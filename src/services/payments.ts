import { prisma } from "../lib/prisma.js";
import { encryptDestination } from "../lib/payoutSecrets.js";
import { paymentProvider } from "../payments/index.js";
import { JOB_TYPES } from "../jobs/handlers.js";
import { enqueueJob } from "../jobs/queue.js";
import { postLedgerTransaction, type LedgerLeg } from "./ledger.js";
import type { PaymentState } from "../payments/provider.js";

/**
 * How long after the last ticket is paid for the draw runs.
 *
 * The draw used to fire inline in this confirmation, which meant the final
 * buyer's webhook decided the winner before any entrant could be told the
 * draw was imminent. The gap exists so `RAFFLE_DRAW_SCHEDULED` can go out
 * first. It also makes the draw depend on the job queue being ticked — there
 * is no in-process timer, by design (see src/jobs).
 */
export const DRAW_DELAY_MS = 10 * 60_000;

/**
 * Remembers where a refund would have to go, from a verified callback.
 *
 * Deliberately NOT folded into `confirmTicketPayment`. Two reasons, and both
 * have bitten this codebase in other forms:
 *
 * 1. That function returns early once a payment is SUCCESS, so a callback
 *    arriving *after* the buyer already settled it on /paid — the common order
 *    in local development, where the webhook cannot reach localhost at all —
 *    would never get this far. A late callback is still the only chance to
 *    learn the payer.
 * 2. The callback is the ONLY place a provider may disclose the payer: the
 *    status endpoint returns it empty. If this is not captured here, the
 *    payment simply cannot be refunded automatically, and `refundRaffle` has
 *    to report no_refund_destination for a human to chase.
 *
 * This is the one piece of webhook data taken on trust rather than re-queried,
 * because there is nowhere to re-query it from. The scope of that trust is
 * narrow and worth stating: the *amount* is still verified independently, so a
 * forged callback cannot move money — at worst it misdirects a refund that
 * only happens if the raffle never sells out. Only ever filled in once, so a
 * later callback cannot repoint a destination that is already recorded.
 */
export async function recordRefundDestination(
  reference: string,
  destination: {
    accountNumber: string;
    bankCode: string;
    accountName: string | null;
  },
): Promise<boolean> {
  let cipher: string;
  try {
    cipher = encryptDestination(destination.accountNumber, "mobile_money");
  } catch {
    // An unparseable payer number stores nothing: a refund blocked on a
    // missing destination is visible and fixable, one sent to a mangled
    // number is neither.
    return false;
  }

  const updated = await prisma.payment.updateMany({
    where: { reference, refundDestinationCipher: null },
    data: {
      refundDestinationCipher: cipher,
      refundChannel: destination.bankCode,
      payerNameSnapshot: destination.accountName,
    },
  });

  return updated.count > 0;
}

export interface ConfirmResult {
  outcome:
    | "confirmed"
    | "already_confirmed"
    | "not_successful"
    | "amount_mismatch"
    | "reservation_lost"
    | "unknown_payment";
  raffleSoldOut: boolean;
  paymentId: string | null;
  raffleId: string | null;
}

const TERMINAL_FAILURES: ReadonlySet<PaymentState> = new Set([
  "failed",
  "abandoned",
  "reversed",
]);

/**
 * Raised inside the confirmation transaction when the reserved ticket rows
 * are gone, so the whole thing rolls back.
 *
 * `releaseExpiredReservations` DELETES expired rows. If a charge succeeds at
 * the provider but confirmation arrives after the hold expires — a delayed or
 * lost webhook — the rows no longer exist. Without this guard the payment
 * would be marked SUCCESS and the money posted into escrow against zero
 * tickets: the buyer pays and gets nothing, and the books still balance, so
 * `totalLedgerSum()` never notices.
 *
 * Rolling back leaves the money with the provider, where a refund is the
 * correct remedy, rather than silently absorbing it.
 */
class ReservationLostError extends Error {
  constructor(expected: number, actual: number) {
    super(`Expected to mark ${expected} reserved ticket(s) paid, found ${actual}`);
    this.name = "ReservationLostError";
  }
}

/**
 * Promotes a paid checkout into owned tickets.
 *
 * The webhook body is never trusted for anything that matters: the provider is
 * re-queried with `confirmPayment`, and the authoritative amount is compared
 * against what we charged. A webhook is only a hint that something changed.
 */
export async function confirmTicketPayment(
  reference: string,
): Promise<ConfirmResult> {
  const payment = await prisma.payment.findUnique({
    where: { reference },
    select: {
      id: true,
      userId: true,
      raffleId: true,
      amount: true,
      status: true,
      quantity: true,
    },
  });

  if (!payment || !payment.raffleId) {
    return {
      outcome: "unknown_payment",
      raffleSoldOut: false,
      paymentId: payment?.id ?? null,
      raffleId: null,
    };
  }

  if (payment.status === "SUCCESS") {
    return {
      outcome: "already_confirmed",
      raffleSoldOut: false,
      paymentId: payment.id,
      raffleId: payment.raffleId,
    };
  }

  const snapshot = await paymentProvider().confirmPayment(reference);

  if (snapshot.state !== "succeeded") {
    if (TERMINAL_FAILURES.has(snapshot.state)) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status:
            snapshot.state === "abandoned"
              ? "ABANDONED"
              : snapshot.state === "reversed"
                ? "REVERSED"
                : "FAILED",
          failureReason: snapshot.failureReason,
        },
      });
    }
    return {
      outcome: "not_successful",
      raffleSoldOut: false,
      paymentId: payment.id,
      raffleId: payment.raffleId,
    };
  }

  // Underpayment or a mismatched currency must never buy tickets. Flag it for
  // a human instead of guessing.
  if (snapshot.amountMinor !== payment.amount) {
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        failureReason: `amount_mismatch: charged ${payment.amount}, provider reports ${snapshot.amountMinor}`,
      },
    });
    return {
      outcome: "amount_mismatch",
      raffleSoldOut: false,
      paymentId: payment.id,
      raffleId: payment.raffleId,
    };
  }

  const raffleId = payment.raffleId;
  const feeMinor = snapshot.feeMinor ?? 0;

  let soldOut: boolean;

  try {
    soldOut = await prisma.$transaction(async (tx) => {
      // No row lock here. An earlier version took FOR UPDATE on the raffle,
      // which serialised confirmations behind each other's round trips and hit
      // the transaction timeout. Double-posting is prevented instead by the
      // unique reference on LedgerTransaction, and the sold-out transition by a
      // conditional UPDATE that only one confirmation can win.
      const fresh = await tx.payment.findUnique({
        where: { id: payment.id },
        select: { status: true },
      });
      if (fresh?.status === "SUCCESS") return false;

      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: "SUCCESS",
          paidAt: snapshot.paidAt ?? new Date(),
          channel: snapshot.channel,
          pspFee: snapshot.feeMinor,
          // The provider's own transaction id, from the authoritative verify
          // call. This is what reconciliation against a settlement report needs.
          providerReference: snapshot.providerRef,
          failureReason: null,
        },
      });

      const claimedTickets = await tx.ticket.updateMany({
        where: { paymentId: payment.id, status: "RESERVED" },
        data: {
          status: "PAID",
          paidAt: snapshot.paidAt ?? new Date(),
          reservationExpiresAt: null,
        },
      });

      // The reservation must still be intact. Anything less means the sweep
      // deleted it first, and posting the ledger now would take the money
      // without issuing a ticket.
      if (claimedTickets.count !== payment.quantity) {
        throw new ReservationLostError(payment.quantity, claimedTickets.count);
      }

      // Money arrives in our balance and simultaneously becomes a liability: it
      // is the buyers' money until the raffle resolves one way or the other.
      const legs: LedgerLeg[] = [
        {
          account: "PLATFORM_CASH" as const,
          amount: payment.amount,
          raffleId,
          paymentId: payment.id,
        },
        {
          account: "TICKET_ESCROW" as const,
          amount: -payment.amount,
          raffleId,
          paymentId: payment.id,
        },
      ];

      // The provider's cut is taken out of what we collect, so escrow is backed
      // by slightly less cash than the ticket total. Recorded, not ignored.
      if (feeMinor > 0) {
        legs.push(
          {
            account: "PSP_FEES" as const,
            amount: feeMinor,
            raffleId,
            paymentId: payment.id,
          },
          {
            account: "PLATFORM_CASH" as const,
            amount: -feeMinor,
            raffleId,
            paymentId: payment.id,
          },
        );
      }

      await postLedgerTransaction(tx, {
        type: "TICKET_PURCHASE",
        reference: `ticket-purchase:${reference}`,
        description: `${payment.quantity} ticket(s)`,
        legs,
      });

      const paidCount = await tx.ticket.count({
        where: { raffleId, status: "PAID" },
      });

      // Single atomic claim of the sold-out transition. Exactly one concurrent
      // confirmation gets a row back, and that one schedules the draw.
      const drawAt = new Date(Date.now() + DRAW_DELAY_MS);
      const claimed = await tx.$queryRaw<Array<{ id: string }>>`
        UPDATE "Raffle"
           SET "status" = 'SOLD_OUT'::"RaffleStatus",
               "ticketsSold" = ${paidCount},
               "drawAt" = ${drawAt},
               "updatedAt" = now()
         WHERE "id" = ${raffleId}
           AND "status" = 'OPEN'::"RaffleStatus"
           AND ${paidCount} >= "totalTickets"
         RETURNING "id"
      `;

      if (claimed.length === 0) {
        // Not the sellout confirmation; just keep the counter current.
        await tx.raffle.update({
          where: { id: raffleId },
          data: { ticketsSold: paidCount },
        });
        return false;
      }

      // Both enqueued inside this transaction, which is the reason the queue
      // lives in Postgres: a raffle that is SOLD_OUT with no scheduled draw
      // would never produce a winner, and with an external broker there is
      // always a window where the commit lands and the enqueue does not.
      await enqueueJob(tx, {
        type: JOB_TYPES.RAFFLE_DRAW_NOTIFY,
        payload: { raffleId },
        dedupeKey: `${JOB_TYPES.RAFFLE_DRAW_NOTIFY}:${raffleId}`,
      });

      await enqueueJob(tx, {
        type: JOB_TYPES.RAFFLE_DRAW,
        payload: { raffleId },
        runAt: drawAt,
        dedupeKey: `${JOB_TYPES.RAFFLE_DRAW}:${raffleId}`,
      });

      return true;
    }, { timeout: 20_000, maxWait: 10_000 });
  } catch (error) {
    if (!(error instanceof ReservationLostError)) throw error;

    // Finding no RESERVED rows has two very different causes, and they must
    // not be confused.
    //
    // The benign one is a race: the webhook and the buyer's return page now
    // both settle, so two confirmations can pass the SUCCESS check above and
    // the loser finds the winner has already flipped every row to PAID. That
    // is success, not loss.
    //
    // The real one is the sweep having deleted the reservation first. Only
    // that deserves the alarm.
    const now = await prisma.payment.findUnique({
      where: { id: payment.id },
      select: { status: true },
    });

    if (now?.status === "SUCCESS") {
      return {
        outcome: "already_confirmed",
        raffleSoldOut: false,
        paymentId: payment.id,
        raffleId,
      };
    }

    // Nothing was committed — not the SUCCESS flag, not the ledger. Record
    // why, loudly, because this is money sitting at the provider that needs a
    // refund and a human to look at it.
    await prisma.payment.update({
      where: { id: payment.id },
      data: { failureReason: `reservation_lost: ${error.message}` },
    });
    console.error(
      `payment ${reference}: charge succeeded but its reservation had expired`,
      error,
    );

    return {
      outcome: "reservation_lost",
      raffleSoldOut: false,
      paymentId: payment.id,
      raffleId,
    };
  }

  return {
    outcome: "confirmed",
    raffleSoldOut: soldOut,
    paymentId: payment.id,
    raffleId,
  };
}

export interface SettleResult extends ConfirmResult {
  /**
   * Always null now. The draw is a scheduled job, so no confirmation can
   * report a winner — kept so the webhook and `/paid` response shapes do not
   * change under clients that read it.
   */
  drawId: string | null;
  /** When the draw will run, if this call was the one that sold the raffle out. */
  drawAt: Date | null;
}

/**
 * Confirms a charge, and reports when the draw will run if it was the last
 * ticket.
 *
 * Both entry points use this: the provider's webhook, and the buyer landing
 * back on the return page after checkout. Neither is sufficient alone —
 * a webhook can be delayed, retried or lost, and in local development it
 * cannot arrive at all because the provider has no route to localhost. The
 * redirect, conversely, is missed whenever the buyer closes the tab.
 *
 * Running both is safe because every step underneath is idempotent:
 * `confirmTicketPayment` re-queries the provider and returns early once the
 * payment is SUCCESS, the ledger posting is keyed on a unique reference, and
 * the draw is enqueued under a dedupe key.
 *
 * The draw is NOT run here. It fires `DRAW_DELAY_MS` later, from the
 * `raffle.draw` job, so entrants get told first.
 */
export async function settleTicketPayment(
  reference: string,
): Promise<SettleResult> {
  const result = await confirmTicketPayment(reference);

  if (result.raffleSoldOut && result.raffleId) {
    const raffle = await prisma.raffle.findUnique({
      where: { id: result.raffleId },
      select: { drawAt: true },
    });
    return { ...result, drawId: null, drawAt: raffle?.drawAt ?? null };
  }

  return { ...result, drawId: null, drawAt: null };
}
