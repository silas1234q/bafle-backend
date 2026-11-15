import { env } from "../env.js";
import { newReference } from "../lib/reference.js";
import type {
  PaymentStatus,
  RaffleStatus,
  TicketStatus,
} from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { PUBLIC_RAFFLE_FIELDS, raffleAvailability } from "./raffles.js";
import { paymentProvider } from "../payments/index.js";
import { PaymentProviderError } from "../payments/provider.js";

/**
 * Where the provider sends the buyer back, with our reference already on it.
 *
 * Appended by us rather than relied on from the provider, because they differ:
 * Paystack adds `?reference=` (and sometimes `trxref=`), Moolre documents no
 * appended parameters at all for a hosted link's `redirect`. Without the
 * reference the return page has nothing to look up — it cannot confirm the
 * payment and it cannot release the hold, so a buyer who cancels keeps their
 * numbers off the shelf for the full window.
 *
 * Harmless where the provider also appends its own: the page reads the first
 * `reference` it finds, and both carry the same value.
 */
function buyerReturnUrl(reference: string): string | undefined {
  const base = env.PAYMENT_RETURN_URL;
  if (!base) return undefined;

  try {
    const url = new URL(base);
    url.searchParams.set("reference", reference);
    return url.toString();
  } catch {
    // A malformed callback URL must not take the whole purchase down; the
    // provider simply gets none and the buyer verifies from /tickets instead.
    return undefined;
  }
}

export class TicketPurchaseError extends Error {
  readonly code:
    | "RAFFLE_NOT_FOUND"
    | "RAFFLE_CLOSED"
    | "NOT_ENOUGH_TICKETS"
    | "SELLER_CANNOT_ENTER"
    | "INVALID_QUANTITY"
    | "CHECKOUT_FAILED"
    | "PAYMENT_NOT_FOUND";
  readonly available?: number;

  constructor(
    code: TicketPurchaseError["code"],
    message: string,
    available?: number,
  ) {
    super(message);
    this.name = "TicketPurchaseError";
    this.code = code;
    this.available = available;
  }
}

/** Abandoned checkouts stop blocking their ticket numbers after this long. */
const RESERVATION_TTL_MS = 15 * 60_000;

/**
 * Frees ticket numbers held by checkouts that were never completed, and marks
 * their payments abandoned.
 *
 * Expired reservations are DELETED rather than marked VOID. If they lingered,
 * their numbers would be permanently unusable and a raffle could never reach
 * sold out. The audit trail survives on the Payment row.
 */
/**
 * Gives up a hold the buyer no longer wants, immediately.
 *
 * The problem this solves: a reservation is held for RESERVATION_TTL_MS so a
 * buyer can pay without losing their numbers, and availability counts it the
 * whole time. A buyer who opens checkout and backs out therefore keeps those
 * numbers off the shelf for fifteen minutes — on a small raffle that can read
 * as nearly sold out, and they cannot re-buy their own numbers either.
 *
 * **It expires the hold rather than deleting it, and that difference is the
 * whole design.** Availability filters on `reservationExpiresAt > now`, so
 * moving that to the present frees the numbers on the very next read. But
 * `confirmTicketPayment` deliberately claims RESERVED rows *without*
 * checking expiry — so if this buyer turns out to have paid after all (a
 * mobile money prompt already in flight, a webhook still in the post), the
 * rows are still there to be claimed and the payment settles normally.
 *
 * Deleting instead would make that case fail every single time:
 * `confirmTicketPayment` would find zero rows, roll back, and record
 * `reservation_lost` — money taken, no ticket, a human to chase. Expiring in
 * place narrows that to the genuine race where somebody else claims the same
 * number in the meantime, which is the identical risk natural expiry already
 * carries.
 *
 * The Payment is left PENDING for the same reason. The sweep marks it
 * ABANDONED when it collects the row, by which point the numbers really are
 * gone.
 */
export async function abandonReservation(
  reference: string,
  userId: string,
): Promise<{ outcome: "released" | "already_paid" | "nothing_held" }> {
  const payment = await prisma.payment.findUnique({
    where: { reference },
    select: { id: true, userId: true, status: true },
  });

  // Same response whether it is missing or someone else's, so this cannot be
  // used to probe for other people's references.
  if (!payment || payment.userId !== userId) {
    throw new TicketPurchaseError("PAYMENT_NOT_FOUND", "Payment not found");
  }

  // Never touch a payment that already went through. A buyer hitting "cancel"
  // after a successful charge must keep the tickets they paid for.
  if (payment.status === "SUCCESS") return { outcome: "already_paid" };
  if (payment.status !== "PENDING") return { outcome: "nothing_held" };

  const released = await prisma.ticket.updateMany({
    where: { paymentId: payment.id, status: "RESERVED" },
    data: { reservationExpiresAt: new Date() },
  });

  return { outcome: released.count > 0 ? "released" : "nothing_held" };
}

export async function releaseExpiredReservations(
  raffleId?: string,
): Promise<number> {
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const expired = await tx.ticket.findMany({
      where: {
        status: "RESERVED",
        reservationExpiresAt: { lt: now },
        ...(raffleId ? { raffleId } : {}),
      },
      select: { id: true, paymentId: true },
    });

    if (expired.length === 0) return 0;

    await tx.ticket.deleteMany({
      where: { id: { in: expired.map((ticket) => ticket.id) } },
    });

    const paymentIds = [
      ...new Set(
        expired
          .map((ticket) => ticket.paymentId)
          .filter((id): id is string => id !== null),
      ),
    ];

    if (paymentIds.length > 0) {
      // Only PENDING: a payment that already succeeded must never be
      // downgraded, even if some ticket row looked stale.
      await tx.payment.updateMany({
        where: { id: { in: paymentIds }, status: "PENDING" },
        data: { status: "ABANDONED", failureReason: "reservation_expired" },
      });
    }

    return expired.length;
  });
}

export interface ReserveTicketsInput {
  raffleId: string;
  userId: string;
  customerEmail: string;
  quantity: number;
}

export interface ReservationResult {
  paymentId: string;
  reference: string;
  amountMinor: number;
  ticketNumbers: number[];
  redirectUrl: string;
  reservationExpiresAt: Date;
}

/** Contention retries before giving up and reporting the raffle full. */
const MAX_ALLOCATION_ATTEMPTS = 5;

/** Thrown internally to roll back a contended attempt. */
class AllocationContended extends Error {}

/**
 * Reserves tickets and starts a checkout.
 *
 * Allocation is done by a SINGLE conditional INSERT rather than by locking the
 * raffle row. An earlier version took `SELECT ... FOR UPDATE` on the raffle,
 * which serialised every buyer: under a sellout rush each had to wait for all
 * the round trips of everyone ahead of them, and with a remote database the
 * tail of the queue exceeded the transaction timeout and failed outright.
 *
 * Here, concurrent buyers contend on the unique index instead of queueing.
 * `ON CONFLICT DO NOTHING` makes a collision cheap, the whole allocation is
 * one statement, and losers retry against the remaining numbers.
 *
 * The provider is still called only AFTER the transaction commits, so no
 * database work waits on an HTTP round trip.
 */
export async function reserveTickets(
  input: ReserveTicketsInput,
): Promise<ReservationResult> {
  const { raffleId, userId, quantity } = input;

  // Raffle-independent sanity only. There is deliberately no flat per-buyer
  // cap: the bound is the raffle's own pool, checked once it is loaded, so a
  // buyer who wants the whole draw can take it.
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new TicketPurchaseError(
      "INVALID_QUANTITY",
      "quantity must be a positive integer",
    );
  }

  await releaseExpiredReservations(raffleId);

  // Cheap pre-checks. None of these can change under us in a way that matters:
  // a raffle does not change owner, and the closing race is caught again
  // inside the allocation statement below.
  const raffle = await prisma.raffle.findUnique({
    where: { id: raffleId },
    select: {
      id: true,
      sellerId: true,
      status: true,
      ticketPrice: true,
      totalTickets: true,
      closesAt: true,
    },
  });

  if (!raffle) {
    throw new TicketPurchaseError("RAFFLE_NOT_FOUND", "Raffle not found");
  }
  // Buying out the raffle is allowed; buying more tickets than exist is not.
  // `amountMinor` below is bounded by this, and `createRaffle` already proved
  // ticketPrice * totalTickets fits the Int columns the ledger uses.
  if (quantity > raffle.totalTickets) {
    throw new TicketPurchaseError(
      "INVALID_QUANTITY",
      `This draw only has ${raffle.totalTickets} tickets`,
    );
  }
  if (raffle.status !== "OPEN") {
    throw new TicketPurchaseError(
      "RAFFLE_CLOSED",
      `Raffle is ${raffle.status}, not open for entries`,
    );
  }
  if (raffle.closesAt.getTime() <= Date.now()) {
    throw new TicketPurchaseError(
      "RAFFLE_CLOSED",
      "Raffle has passed its closing time",
    );
  }
  // A seller entering their own raffle could win the product back while
  // keeping the ticket revenue. Structurally excluded rather than policed.
  if (raffle.sellerId === userId) {
    throw new TicketPurchaseError(
      "SELLER_CANNOT_ENTER",
      "You cannot buy tickets for your own raffle",
    );
  }

  const amountMinor = raffle.ticketPrice * quantity;

  for (let attempt = 1; attempt <= MAX_ALLOCATION_ATTEMPTS; attempt++) {
    // A fresh reference per attempt: a rolled-back attempt must not leave a
    // reference that collides with the retry.
    const reference = newReference("tkt");
    const reservationExpiresAt = new Date(Date.now() + RESERVATION_TTL_MS);

    try {
      const reserved = await prisma.$transaction(
        async (tx) => {
          const payment = await tx.payment.create({
            data: {
              userId,
              raffleId,
              reference,
              amount: amountMinor,
              currency: "GHS",
              quantity,
              status: "PENDING",
            },
            select: { id: true },
          });

          // One statement: pick the lowest free numbers and claim them.
          // The join on Raffle re-checks OPEN and closesAt atomically, so a
          // raffle that closed a moment ago yields zero rows instead of
          // tickets nobody should own.
          const claimed = await tx.$queryRaw<Array<{ ticketNumber: number }>>`
            INSERT INTO "Ticket" (
              "id", "raffleId", "userId", "ticketNumber", "status",
              "paymentId", "reservationExpiresAt", "createdAt", "updatedAt"
            )
            SELECT gen_random_uuid()::text,
                   ${raffleId},
                   ${userId},
                   picked.n,
                   'RESERVED'::"TicketStatus",
                   ${payment.id},
                   ${reservationExpiresAt},
                   now(),
                   now()
              FROM "Raffle" r
              JOIN LATERAL (
                     SELECT n
                       FROM generate_series(1, r."totalTickets") AS n
                      WHERE NOT EXISTS (
                            SELECT 1 FROM "Ticket" t
                             WHERE t."raffleId" = r."id"
                               AND t."ticketNumber" = n
                            )
                      ORDER BY n
                      LIMIT ${quantity}
                   ) AS picked ON TRUE
             WHERE r."id" = ${raffleId}
               AND r."status" = 'OPEN'::"RaffleStatus"
               AND r."closesAt" > now()
            ON CONFLICT ("raffleId", "ticketNumber") DO NOTHING
            RETURNING "ticketNumber"
          `;

          if (claimed.length < quantity) {
            // Either someone else took these numbers, or there are not enough
            // left. Roll back so no partial reservation or orphan payment
            // survives, then decide which it was outside the transaction.
            throw new AllocationContended();
          }

          return {
            paymentId: payment.id,
            reference,
            ticketNumbers: claimed
              .map((row) => row.ticketNumber)
              .sort((a, b) => a - b),
            reservationExpiresAt,
          };
        },
        // Generous relative to the work: this transaction is two statements,
        // but a contended retry under load should not be killed mid-flight.
        { timeout: 15_000, maxWait: 10_000 },
      );

      return await startCheckout(input, reserved, amountMinor, raffleId);
    } catch (error) {
      if (error instanceof AllocationContended) {
        const availability = await raffleAvailability(raffleId);
        // Genuinely out of tickets: retrying cannot help.
        if ((availability?.available ?? 0) < quantity) {
          throw new TicketPurchaseError(
            "NOT_ENOUGH_TICKETS",
            `Only ${availability?.available ?? 0} ticket(s) left`,
            availability?.available ?? 0,
          );
        }
        continue; // lost a race; the numbers moved but stock remains
      }
      throw error;
    }
  }

  const availability = await raffleAvailability(raffleId);
  throw new TicketPurchaseError(
    "NOT_ENOUGH_TICKETS",
    "Could not reserve tickets; please try again",
    availability?.available ?? 0,
  );
}

interface ReservedTickets {
  paymentId: string;
  reference: string;
  ticketNumbers: number[];
  reservationExpiresAt: Date;
}

async function startCheckout(
  input: ReserveTicketsInput,
  reserved: ReservedTickets,
  amountMinor: number,
  raffleId: string,
): Promise<ReservationResult> {
  const reference = reserved.reference;

  // Network call, deliberately outside the transaction.
  try {
    const session = await paymentProvider().initiateCheckout({
      reference,
      amountMinor,
      currency: "GHS",
      customerEmail: input.customerEmail,
      callbackUrl: buyerReturnUrl(reference),
      // Tied to the hold, so the link cannot outlive the numbers it is for.
      expiresAt: reserved.reservationExpiresAt,
      metadata: {
        raffleId,
        paymentId: reserved.paymentId,
        ticketNumbers: reserved.ticketNumbers,
      },
    });

    await prisma.payment.update({
      where: { id: reserved.paymentId },
      data: {
        // Only the checkout URL. session.providerRef is Paystack's
        // access_code, a short-lived checkout session token -- not a
        // transaction reference, and storing it in the unique
        // providerReference column both misrepresented it and collided.
        // The real provider reference is recorded at confirmation time.
        authorizationUrl: session.redirectUrl,
      },
    });

    return {
      paymentId: reserved.paymentId,
      reference,
      amountMinor,
      ticketNumbers: reserved.ticketNumbers,
      redirectUrl: session.redirectUrl,
      reservationExpiresAt: reserved.reservationExpiresAt,
    };
  } catch (error) {
    // Fail the payment immediately so the buyer sees an error instead of a
    // dead checkout link. The tickets stay reserved until they expire, which
    // is the safe direction: worst case a few numbers are briefly unbuyable.
    await prisma.payment.update({
      where: { id: reserved.paymentId },
      data: {
        status: "FAILED",
        failureReason:
          error instanceof PaymentProviderError
            ? (error.providerMessage ?? error.message)
            : "checkout_initiation_failed",
      },
    });

    throw new TicketPurchaseError(
      "CHECKOUT_FAILED",
      "Could not start checkout with the payment provider",
    );
  }
}

// ---------------------------------------------------------------------------
// Buyer-side listing
// ---------------------------------------------------------------------------

/** Where a buyer stands in one raffle they hold tickets in. */
export type TicketOutcome =
  | "unpaid"
  | "open"
  | "drawing"
  | "won"
  | "lost"
  | "refund_pending"
  | "refunded";

/**
 * State of one unpaid reservation, which decides what the UI may offer.
 *
 * `unconfirmed` is the one that matters. The hold's clock has run out but the
 * sweep has not deleted the rows yet, and `confirmTicketPayment` claims
 * RESERVED tickets without checking expiry (see the updateMany in
 * services/payments.ts) -- so a charge whose webhook was lost is still fully
 * recoverable by re-verifying. Hiding an expired hold from its own owner would
 * throw away the only route back to that money.
 *
 * `stalled` is the aftermath of startCheckout failing above: the tickets stay
 * RESERVED on purpose, but the payment is FAILED and there is no checkout URL
 * to return to. It needs an explanation rather than an action.
 */
export type HoldState = "live" | "expiring" | "unconfirmed" | "stalled";

/** Resuming a hold this close to expiry is what produces `reservation_lost`. */
const RESUME_CUTOFF_MS = 60_000;

/** Raffles to return. A buyer with more than this has older ones truncated. */
const MAX_ENTRIES = 50;
/** Per-raffle ticket cap. Fifty purchases of the twenty-ticket maximum. */
const MAX_TICKETS_PER_ENTRY = 500;
/** Orphaned payments are an exception path; a handful is all anyone needs. */
const MAX_UNMATCHED_PAYMENTS = 10;

export interface MyTicket {
  ticketNumber: number;
  status: TicketStatus;
  paidAt: Date | null;
  refundedAt: Date | null;
  reservationExpiresAt: Date | null;
}

export interface TicketHold {
  /** Null only if a reservation somehow lost its payment row. */
  reference: string | null;
  state: HoldState;
  /** The provider's hosted checkout. Null unless the hold is resumable. */
  checkoutUrl: string | null;
  expiresAt: Date | null;
  ticketNumbers: number[];
  resumable: boolean;
}

/**
 * A payment left PENDING with no surviving tickets.
 *
 * In practice this is the `reservation_lost` case: the charge succeeded, the
 * hold had already been swept, so confirmTicketPayment rolled everything back
 * and left the payment PENDING with a failureReason. Money is with the
 * provider and the buyer has nothing -- which today is recorded only in a
 * console.error, so this listing is the one place they can see it.
 *
 * Note what is NOT in here: an ordinary abandoned checkout. The sweep marks
 * those ABANDONED as it deletes the tickets, so the PENDING filter excludes
 * them, which is the point -- nobody needs a card telling them about a
 * payment they chose not to make.
 */
export interface UnmatchedPayment {
  reference: string;
  amount: number;
  quantity: number;
  createdAt: Date;
  raffleId: string | null;
  productTitle: string | null;
}

export interface TicketEntry {
  raffle: {
    id: string;
    productId: string;
    sellerId: string;
    ticketPrice: number;
    totalTickets: number;
    ticketsSold: number;
    status: RaffleStatus;
    opensAt: Date | null;
    closesAt: Date;
    drawAt: Date | null;
    platformFeeBps: number;
    createdAt: Date;
    product: {
      id: string;
      title: string;
      slug: string;
      retailValue: number;
      images: Array<{ url: string; alt: string | null; position: number }>;
    };
  };
  tickets: MyTicket[];
  paidCount: number;
  reservedCount: number;
  refundedCount: number;
  /** Pesewas actually paid for this raffle. */
  amountPaidMinor: number;
  outcome: TicketOutcome;
  won: boolean;
  winningTicketNumber: number | null;
  drawnAt: Date | null;
  holds: TicketHold[];
}

export interface MyTickets {
  entries: TicketEntry[];
  unmatchedPayments: UnmatchedPayment[];
}

/**
 * Raffle status alone, before the draw and the buyer's own tickets are taken
 * into account. Exhaustive on purpose: a new RaffleStatus should be a compile
 * error here rather than an undefined badge in the UI.
 */
const OUTCOME_BY_RAFFLE_STATUS: Record<RaffleStatus, TicketOutcome> = {
  // Cannot hold tickets -- reserveTickets requires OPEN -- but enumerated so
  // the map stays total.
  DRAFT: "open",
  OPEN: "open",
  SOLD_OUT: "drawing",
  // These two always have a Draw row, so the check in entryOutcome wins. The
  // fallback is "waiting" rather than "lost": claiming someone lost a draw
  // whose result we cannot read would be the worse failure.
  DRAWN: "drawing",
  COMPLETED: "drawing",
  EXPIRED: "refund_pending",
  REFUNDING: "refund_pending",
  CANCELLED: "refund_pending",
  REFUNDED: "refunded",
};

function entryOutcome(
  status: RaffleStatus,
  isWinner: boolean | null,
  paidCount: number,
  refundedCount: number,
): TicketOutcome {
  // Checked before the status map: a COMPLETED raffle has been delivered and
  // the seller paid, but from the buyer's side it is still just won or lost.
  if (isWinner !== null) return isWinner ? "won" : "lost";

  // Only settleRefund writes REFUNDED, so this is the one statement about
  // this buyer's money that is certainly true. A raffle sitting in REFUNDING
  // or EXPIRED may have moved nothing yet, which is why that is a separate
  // outcome -- saying "refunded" before the money lands is the worst thing
  // this listing could do.
  if (refundedCount > 0) return "refunded";

  const base = OUTCOME_BY_RAFFLE_STATUS[status];
  // Reserved-only in an open raffle. "You are in the draw" would be false.
  if (base === "open" && paidCount === 0) return "unpaid";
  return base;
}

/** Ordering: things the buyer can act on, then good news, then history. */
const OUTCOME_RANK: Record<TicketOutcome, number> = {
  unpaid: 1,
  won: 2,
  open: 3,
  drawing: 4,
  lost: 5,
  refund_pending: 6,
  refunded: 7,
};

function holdState(
  paymentStatus: PaymentStatus | null,
  expiresAt: Date | null,
  now: number,
): HoldState {
  if (paymentStatus !== "PENDING") return "stalled";
  if (expiresAt === null) return "stalled";

  const remaining = expiresAt.getTime() - now;
  if (remaining <= 0) return "unconfirmed";
  if (remaining <= RESUME_CUTOFF_MS) return "expiring";
  return "live";
}

/**
 * Every raffle this user holds tickets in, with their numbers and where the
 * raffle got to, plus any payment of theirs that lost its tickets.
 *
 * Rooted on Raffle rather than Ticket deliberately. A ticket-rooted query with
 * a row cap lets one busy raffle consume the whole budget and silently drop
 * every older raffle -- including won/lost history, which exists nowhere else
 * in the UI. Capping raffles caps the right unit, and the grouping and ticket
 * ordering happen in SQL.
 *
 * This is not one query: Prisma issues a statement per relation level, so
 * expect roughly six. What matters is that the count is constant in the number
 * of raffles, which is also why raffleAvailability() is not called here -- it
 * is three more round trips each, and `ticketsSold` already carries the paid
 * count the progress meter needs.
 *
 * Read-only by design. releaseExpiredReservations() writes, so it is not
 * called from here even though this is where expired holds surface.
 */
export async function listUserTickets(userId: string): Promise<MyTickets> {
  const now = Date.now();

  const [raffles, orphanedPayments] = await Promise.all([
    prisma.raffle.findMany({
      where: { tickets: { some: { userId } } },
      select: {
        ...PUBLIC_RAFFLE_FIELDS,
        product: {
          select: {
            id: true,
            title: true,
            slug: true,
            retailValue: true,
            images: {
              select: { url: true, alt: true, position: true },
              orderBy: { position: "asc" },
              take: 1,
            },
          },
        },
        // Narrow select on purpose. `winnerUserId` is used below to decide
        // `won` and is then dropped, so the nested draw never reaches the
        // response — see the destructure after the query.
        draw: {
          select: {
            winningTicketNumber: true,
            winnerUserId: true,
            drawnAt: true,
          },
        },
        tickets: {
          where: { userId },
          select: {
            ticketNumber: true,
            status: true,
            paidAt: true,
            refundedAt: true,
            reservationExpiresAt: true,
            paymentId: true,
            payment: {
              select: {
                reference: true,
                status: true,
                authorizationUrl: true,
              },
            },
          },
          orderBy: { ticketNumber: "asc" },
          take: MAX_TICKETS_PER_ENTRY,
        },
      },
      orderBy: { createdAt: "desc" },
      take: MAX_ENTRIES,
    }),

    // Cheap: Payment is indexed on (userId, status). Deliberately narrow --
    // ABANDONED and FAILED rows are expected debris, and surfacing them would
    // tell a buyer they owe money for something they never bought.
    prisma.payment.findMany({
      where: { userId, status: "PENDING", tickets: { none: {} } },
      select: {
        reference: true,
        amount: true,
        quantity: true,
        createdAt: true,
        raffleId: true,
        raffle: { select: { product: { select: { title: true } } } },
      },
      orderBy: { createdAt: "desc" },
      take: MAX_UNMATCHED_PAYMENTS,
    }),
  ]);

  const entries = raffles.map((row): TicketEntry => {
    // `draw` carries winnerUserId, the only private field in this projection.
    // Destructuring it out here is what keeps it out of the response; do not
    // reintroduce a spread of the whole row below.
    const { draw, tickets, ...raffle } = row;

    const paidCount = tickets.filter((t) => t.status === "PAID").length;
    const reservedCount = tickets.filter((t) => t.status === "RESERVED").length;
    const refundedCount = tickets.filter((t) => t.status === "REFUNDED").length;

    // Decided by the draw's own winnerUserId, never by matching the winning
    // number against the numbers below: the per-raffle take can truncate, and
    // that would report "lost" to someone who actually won.
    const isWinner = draw ? draw.winnerUserId === userId : null;

    const holdsByPayment = new Map<string, TicketHold>();
    for (const ticket of tickets) {
      if (ticket.status !== "RESERVED") continue;

      // A payment is the unit of resume, and one buyer can hold two live
      // reservations on the same raffle (two tabs -- nothing prevents it).
      const key = ticket.paymentId ?? `orphan:${String(ticket.ticketNumber)}`;
      const existing = holdsByPayment.get(key);
      if (existing) {
        existing.ticketNumbers.push(ticket.ticketNumber);
        continue;
      }

      const state = holdState(
        ticket.payment?.status ?? null,
        ticket.reservationExpiresAt,
        now,
      );
      const resumable = state === "live";

      holdsByPayment.set(key, {
        reference: ticket.payment?.reference ?? null,
        state,
        // Only while it can still be used. A live provider checkout URL
        // attached to anything else is pointless attack surface.
        checkoutUrl: resumable
          ? (ticket.payment?.authorizationUrl ?? null)
          : null,
        expiresAt: ticket.reservationExpiresAt,
        ticketNumbers: [ticket.ticketNumber],
        resumable,
      });
    }

    return {
      raffle,
      tickets: tickets.map((ticket) => ({
        ticketNumber: ticket.ticketNumber,
        status: ticket.status,
        paidAt: ticket.paidAt,
        refundedAt: ticket.refundedAt,
        reservationExpiresAt: ticket.reservationExpiresAt,
      })),
      paidCount,
      reservedCount,
      refundedCount,
      // From the raffle's immutable ticket price. Payment.amount is the whole
      // basket, so summing it per ticket would overstate by the quantity.
      amountPaidMinor: paidCount * raffle.ticketPrice,
      outcome: entryOutcome(raffle.status, isWinner, paidCount, refundedCount),
      won: isWinner === true,
      winningTicketNumber: draw?.winningTicketNumber ?? null,
      drawnAt: draw?.drawnAt ?? null,
      holds: [...holdsByPayment.values()],
    };
  });

  entries.sort((a, b) => {
    // Anything the buyer can act on comes first, whatever the raffle is doing.
    const aRank = a.holds.length > 0 ? 0 : OUTCOME_RANK[a.outcome];
    const bRank = b.holds.length > 0 ? 0 : OUTCOME_RANK[b.outcome];
    if (aRank !== bRank) return aRank - bRank;

    return b.raffle.closesAt.getTime() - a.raffle.closesAt.getTime();
  });

  return {
    entries,
    unmatchedPayments: orphanedPayments.map((payment) => ({
      reference: payment.reference,
      amount: payment.amount,
      quantity: payment.quantity,
      createdAt: payment.createdAt,
      raffleId: payment.raffleId,
      productTitle: payment.raffle?.product.title ?? null,
    })),
  };
}
