import { assertPositiveMinorAmount } from "../lib/money.js";
import { prisma } from "../lib/prisma.js";
import { Prisma, type Raffle } from "../generated/prisma/client.js";

export class RaffleValidationError extends Error {
  readonly field: string | null;

  constructor(message: string, field: string | null = null) {
    super(message);
    this.name = "RaffleValidationError";
    this.field = field;
  }
}

// Sane bounds. A 1-ticket raffle is a sale with extra steps, and very large
// pools make the per-purchase number allocation query expensive.
const MIN_TICKETS = 2;
const MAX_TICKETS = 10_000;
const MAX_DURATION_DAYS = 90;

/** Fields safe to serve publicly. */
export const PUBLIC_RAFFLE_FIELDS = {
  id: true,
  productId: true,
  sellerId: true,
  ticketPrice: true,
  totalTickets: true,
  ticketsSold: true,
  status: true,
  opensAt: true,
  closesAt: true,
  // Public from the moment the raffle sells out: the point of the delay is
  // that entrants can see the draw coming.
  drawAt: true,
  platformFeeBps: true,
  createdAt: true,
} as const;

export interface CreateRaffleInput {
  productId: string;
  /** The authenticated user. Must own the product. */
  sellerId: string;
  ticketPriceMinor: number;
  totalTickets: number;
  closesAt: Date;
  platformFeeBps?: number;
}

/** Opens a raffle against a product. */
export async function createRaffle(input: CreateRaffleInput): Promise<Raffle> {
  const { ticketPriceMinor, totalTickets, platformFeeBps = 0 } = input;

  assertPositiveMinorAmount(ticketPriceMinor);

  if (!Number.isInteger(totalTickets) || totalTickets < MIN_TICKETS || totalTickets > MAX_TICKETS) {
    throw new RaffleValidationError(
      `totalTickets must be an integer between ${MIN_TICKETS} and ${MAX_TICKETS}`,
      "totalTickets",
    );
  }

  if (!Number.isInteger(platformFeeBps) || platformFeeBps < 0 || platformFeeBps > 10_000) {
    throw new RaffleValidationError(
      "platformFeeBps must be an integer between 0 and 10000",
      "platformFeeBps",
    );
  }

  const now = new Date();
  if (input.closesAt.getTime() <= now.getTime()) {
    throw new RaffleValidationError("closesAt must be in the future", "closesAt");
  }
  const maxClose = now.getTime() + MAX_DURATION_DAYS * 86_400_000;
  if (input.closesAt.getTime() > maxClose) {
    throw new RaffleValidationError(
      `closesAt cannot be more than ${MAX_DURATION_DAYS} days away`,
      "closesAt",
    );
  }

  const grossIfSoldOut = ticketPriceMinor * totalTickets;

  // Ledger amounts are Int columns, so the whole pool has to fit in one.
  if (grossIfSoldOut > 2_147_483_647) {
    throw new RaffleValidationError(
      "ticketPrice x totalTickets exceeds the maximum supported raffle value",
      "ticketPrice",
    );
  }

  const product = await prisma.product.findUnique({
    where: { id: input.productId },
    select: { id: true, sellerId: true, status: true, retailValue: true },
  });

  if (!product) {
    throw new RaffleValidationError("Product not found", "productId");
  }
  if (product.sellerId !== input.sellerId) {
    throw new RaffleValidationError("You do not own this product", "productId");
  }
  if (product.status !== "ACTIVE") {
    throw new RaffleValidationError(
      `Product must be ACTIVE to raffle; it is ${product.status}`,
      "productId",
    );
  }

  // The pricing floor: a sold-out raffle must cover the item, otherwise the
  // seller is underpaid for a product they have already handed over.
  if (grossIfSoldOut < product.retailValue) {
    throw new RaffleValidationError(
      `A sold-out raffle would raise ${grossIfSoldOut} pesewas but the product is valued at ${product.retailValue}. ` +
        `Raise the ticket price or the ticket count.`,
      "ticketPrice",
    );
  }

  try {
    return await prisma.raffle.create({
      data: {
        productId: product.id,
        sellerId: product.sellerId,
        ticketPrice: ticketPriceMinor,
        totalTickets,
        status: "OPEN",
        opensAt: now,
        closesAt: input.closesAt,
        platformFeeBps,
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      // The partial unique index Raffle_one_live_per_product.
      throw new RaffleValidationError(
        "This product already has a raffle that has not finished",
        "productId",
      );
    }
    throw error;
  }
}

export class RaffleExtendError extends Error {
  readonly code: "RAFFLE_NOT_FOUND" | "NOT_EXTENDABLE" | "INVALID_DEADLINE";

  constructor(code: RaffleExtendError["code"], message: string) {
    super(message);
    this.name = "RaffleExtendError";
    this.code = code;
  }
}

/**
 * Pushes a raffle's closing time back.
 *
 * The case this exists for: a draw that reached its deadline without selling
 * out. Rather than refunding everyone, the seller can give it longer.
 *
 * Only an OPEN raffle can be extended, whether or not `closesAt` has already
 * passed — those are safe because nothing has been unwound yet. An EXPIRED one
 * is refused: `expireOverdueRaffles` enqueues refunds in the same transaction
 * that marks it EXPIRED, so by then buyers are being paid back and reviving
 * the raffle would race those refunds and could leave a ticket both refunded
 * and still in the draw.
 *
 * Run as one conditional UPDATE: a concurrent sweep flipping the row to
 * EXPIRED must either lose or win cleanly, never interleave.
 */
export async function extendRaffle(
  raffleId: string,
  closesAt: Date,
): Promise<Raffle> {
  const raffle = await prisma.raffle.findUnique({
    where: { id: raffleId },
    select: { id: true, status: true, closesAt: true },
  });

  if (!raffle) {
    throw new RaffleExtendError("RAFFLE_NOT_FOUND", "Raffle not found");
  }

  if (raffle.status !== "OPEN") {
    throw new RaffleExtendError(
      "NOT_EXTENDABLE",
      raffle.status === "EXPIRED"
        ? "This draw has already expired and its refunds are under way, so it cannot be reopened."
        : `This draw is ${raffle.status.toLowerCase().replace(/_/g, " ")} and cannot be extended.`,
    );
  }

  const now = Date.now();

  if (closesAt.getTime() <= now) {
    throw new RaffleExtendError(
      "INVALID_DEADLINE",
      "The new closing time must be in the future",
    );
  }

  // Measured from now, not from the original deadline: the same rule a new
  // raffle gets, so an extension cannot outlive what the seller could have
  // opened today.
  if (closesAt.getTime() > now + MAX_DURATION_DAYS * 86_400_000) {
    throw new RaffleExtendError(
      "INVALID_DEADLINE",
      `The new closing time cannot be more than ${MAX_DURATION_DAYS} days away`,
    );
  }

  // Only ever forward. Shortening a deadline would cut off buyers who are
  // mid-checkout against the time they were shown.
  if (closesAt.getTime() <= raffle.closesAt.getTime()) {
    throw new RaffleExtendError(
      "INVALID_DEADLINE",
      "The new closing time must be later than the current one",
    );
  }

  const updated = await prisma.raffle.updateManyAndReturn({
    where: { id: raffleId, status: "OPEN" },
    data: { closesAt },
  });

  const row = updated[0];
  if (!row) {
    // The sweep expired it between the read above and this update.
    throw new RaffleExtendError(
      "NOT_EXTENDABLE",
      "This draw expired a moment ago and its refunds are under way, so it cannot be reopened.",
    );
  }

  await prisma.auditLog.create({
    data: {
      action: "raffle.extend",
      entityType: "Raffle",
      entityId: raffleId,
      metadata: {
        from: raffle.closesAt.toISOString(),
        to: closesAt.toISOString(),
      },
    },
  });

  return row;
}

export interface RaffleAvailability {
  totalTickets: number;
  paid: number;
  held: number;
  available: number;
}

/**
 * Live availability.
 *
 * `held` counts unexpired reservations: numbers that are not sold but are not
 * buyable either. Showing `totalTickets - paid` as available would let a
 * sellout rush start checkouts that are guaranteed to fail.
 */
export async function raffleAvailability(
  raffleId: string,
): Promise<RaffleAvailability | null> {
  const raffle = await prisma.raffle.findUnique({
    where: { id: raffleId },
    select: { totalTickets: true },
  });
  if (!raffle) return null;

  const now = new Date();

  const [paid, held] = await Promise.all([
    prisma.ticket.count({ where: { raffleId, status: "PAID" } }),
    prisma.ticket.count({
      where: {
        raffleId,
        status: "RESERVED",
        reservationExpiresAt: { gt: now },
      },
    }),
  ]);

  return {
    totalTickets: raffle.totalTickets,
    paid,
    held,
    available: Math.max(0, raffle.totalTickets - paid - held),
  };
}
