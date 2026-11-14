import { isOwnCloudinaryUrl } from "../images/cloudinary.js";
import { prisma } from "../lib/prisma.js";
import { JOB_TYPES } from "../jobs/handlers.js";
import { enqueueJob } from "../jobs/queue.js";
import type { Prisma, ProductCondition } from "../generated/prisma/client.js";

type Tx = Prisma.TransactionClient;

/**
 * Seller edits and removal of their own listing.
 *
 * One rule governs both: **a paid ticket freezes the listing.** From the moment
 * any buyer's money is in, the seller can neither change what they are selling
 * nor withdraw it. Without that, two things are possible that the rest of the
 * system has no answer for — selling tickets for one item and editing the
 * listing into another, and a seller cancelling a raffle because sales are
 * going badly, which would have to refund buyers who were owed a draw.
 *
 * Removal is an ARCHIVE, never a row delete: Raffle and Order hold foreign
 * keys to Product, so deleting the row would either fail or orphan a completed
 * sale's history.
 */

export class ProductMutationError extends Error {
  readonly code:
    | "NOT_FOUND"
    | "TICKETS_SOLD"
    | "CHECKOUT_IN_PROGRESS"
    | "BREAKS_PRICING_FLOOR";

  constructor(code: ProductMutationError["code"], message: string) {
    super(message);
    this.name = "ProductMutationError";
    this.code = code;
  }
}

/** Raffle states that still hold a claim on the product. */
const LIVE_RAFFLE_STATES = [
  "DRAFT",
  "OPEN",
  "SOLD_OUT",
  "DRAWN",
  "EXPIRED",
  "REFUNDING",
] as const;

export interface EditableProduct {
  title?: string;
  description?: string;
  category?: string;
  condition?: ProductCondition;
  retailValue?: number;
  /** Replaces the whole set when present; position follows array order. */
  images?: Array<{ url: string; alt?: string | null }>;
}

/**
 * Throws unless the seller may still change or withdraw this listing.
 *
 * Takes the caller's transaction, so the decision and the write that depends
 * on it commit together — checking outside the transaction would leave a
 * window where a reservation lands between the two.
 *
 * Two distinct refusals, because they mean different things to the person
 * reading them: TICKETS_SOLD is permanent and CHECKOUT_IN_PROGRESS clears on
 * its own once the reservation sweep runs.
 */
async function assertNotFrozen(tx: Tx, productId: string): Promise<void> {
  // A PAID ticket on any raffle of this product, past or present. Checked
  // against Ticket rather than Raffle.ticketsSold, which is only a display
  // counter — the tickets themselves are the money.
  const paid = await tx.ticket.count({
    where: { raffle: { productId }, status: "PAID" },
  });

  if (paid > 0) {
    throw new ProductMutationError(
      "TICKETS_SOLD",
      `${paid} ticket${paid === 1 ? " has" : "s have"} been paid for. ` +
        `A listing cannot be changed or removed once buyers have entered.`,
    );
  }

  // Someone may be on the provider's checkout page right now. Their payment
  // would land against a listing that no longer says what they bought, so
  // this waits rather than racing it.
  const pending = await tx.payment.count({
    where: { raffle: { productId }, status: "PENDING" },
  });

  if (pending > 0) {
    throw new ProductMutationError(
      "CHECKOUT_IN_PROGRESS",
      "Someone is part-way through paying for a ticket. Try again in a few minutes.",
    );
  }
}

/**
 * Edits a listing the seller owns.
 *
 * The slug is deliberately NOT regenerated from a new title: it is unique and
 * public, and silently repointing it would break any link already shared.
 */
export async function updateProduct(
  productId: string,
  input: EditableProduct,
): Promise<void> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, status: true },
  });

  if (!product || product.status === "ARCHIVED") {
    throw new ProductMutationError("NOT_FOUND", "Product not found");
  }

  if (input.retailValue !== undefined) {
    // The raffle pricing floor is checked when a raffle opens; raising the
    // stated value afterwards would leave a live raffle that cannot cover the
    // item it is selling. Re-checked here against the same rule rather than
    // forbidding the edit outright.
    const live = await prisma.raffle.findFirst({
      where: { productId, status: { in: [...LIVE_RAFFLE_STATES] } },
      select: { ticketPrice: true, totalTickets: true },
    });

    if (live) {
      const gross = live.ticketPrice * live.totalTickets;
      if (input.retailValue > gross) {
        throw new ProductMutationError(
          "BREAKS_PRICING_FLOOR",
          `This product has a live raffle that would raise ${gross} pesewas, which is ` +
            `less than the new value of ${input.retailValue}. Lower the value, or close the raffle first.`,
        );
      }
    }
  }

  for (const image of input.images ?? []) {
    // Same guard as creation: an arbitrary host here is a tracking pixel, or
    // an image that can be swapped out from under the listing later.
    if (!isOwnCloudinaryUrl(image.url)) {
      throw new ProductMutationError(
        "NOT_FOUND",
        "Image URLs must be uploads in our own Cloudinary account",
      );
    }
  }

  const data: Prisma.ProductUpdateInput = {};
  if (input.title !== undefined) data.title = input.title;
  if (input.description !== undefined) data.description = input.description;
  if (input.category !== undefined) data.category = input.category;
  if (input.condition !== undefined) data.condition = input.condition;
  if (input.retailValue !== undefined) data.retailValue = input.retailValue;

  await prisma.$transaction(async (tx) => {
    await assertNotFrozen(tx, productId);

    if (input.images) {
      // Replace rather than merge: the form sends the gallery it wants, and
      // position has to follow that order for cover selection to mean anything.
      await tx.productImage.deleteMany({ where: { productId } });
      await tx.productImage.createMany({
        data: input.images.map((image, index) => ({
          productId,
          url: image.url,
          alt: image.alt ?? null,
          position: index,
        })),
      });
    }

    await tx.product.update({ where: { id: productId }, data });
  });
}

/**
 * Withdraws a listing: ARCHIVED, plus any empty raffle cancelled with it.
 *
 * Cancelling the raffle is not an extra: `GET /raffles` filters on raffle
 * status and never looks at the product, so an archived product with an OPEN
 * raffle would keep selling tickets for a listing the seller believes they
 * deleted. CANCELLED is also outside the `Raffle_one_live_per_product` partial
 * index, so the row stops blocking the product's slot.
 *
 * Idempotent: archiving an archived product is a no-op, so a double-tap on the
 * confirm button is not an error.
 */
export async function archiveProduct(
  productId: string,
  actorUserId: string,
): Promise<{ alreadyArchived: boolean; cancelledRaffleIds: string[] }> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, status: true },
  });

  if (!product) {
    throw new ProductMutationError("NOT_FOUND", "Product not found");
  }

  if (product.status === "ARCHIVED") {
    return { alreadyArchived: true, cancelledRaffleIds: [] };
  }

  const liveIds = await prisma.$transaction(async (tx) => {
    await assertNotFrozen(tx, productId);

    const live = await tx.raffle.findMany({
      where: { productId, status: { in: [...LIVE_RAFFLE_STATES] } },
      select: { id: true },
    });
    const ids = live.map((raffle) => raffle.id);

    if (ids.length > 0) {
      // Status first, deliberately. `reserveTickets` allocates with one
      // conditional INSERT whose WHERE requires the raffle to be OPEN, so
      // flipping the status is what actually closes the door on new buyers;
      // deleting tickets before that would just free numbers for them.
      await tx.raffle.updateMany({
        where: { id: { in: ids } },
        data: { status: "CANCELLED", ticketsSold: 0 },
      });

      // Every reservation left is unpaid and unpayable — assertNotFrozen has
      // ruled out PAID tickets and PENDING payments, so these are lapsed
      // holds the sweep had not reached yet. Deleted rather than VOIDed,
      // matching releaseExpiredReservations.
      await tx.ticket.deleteMany({ where: { raffleId: { in: ids } } });
    }

    await tx.product.update({
      where: { id: productId },
      data: { status: "ARCHIVED" },
    });

    await tx.auditLog.create({
      data: {
        actorUserId,
        action: "product.archive",
        entityType: "Product",
        entityId: productId,
        metadata: { from: product.status, cancelledRaffleIds: ids },
      },
    });

    return ids;
  });

  // One narrow race survives the transaction above: a reservation that had
  // already read the raffle as OPEN can commit immediately after it, since
  // READ COMMITTED makes its inserts invisible to us and plain reads do not
  // block. That buyer would hold tickets on a cancelled raffle, and the
  // refund sweep only ever looks at raffles it expired itself — so nothing
  // would give them their money back.
  //
  // Rather than widen the lock, hand the loser to the machinery that already
  // handles this: `refundRaffle` accepts CANCELLED, so one job per affected
  // raffle refunds them automatically.
  for (const raffleId of liveIds) {
    const stragglers = await prisma.payment.count({
      where: { raffleId, status: { in: ["PENDING", "SUCCESS"] } },
    });
    if (stragglers === 0) continue;

    await prisma.$transaction(async (tx) => {
      await enqueueJob(tx, {
        type: JOB_TYPES.RAFFLE_REFUND,
        payload: { raffleId },
        dedupeKey: `${JOB_TYPES.RAFFLE_REFUND}:${raffleId}`,
      });

      await tx.auditLog.create({
        data: {
          actorUserId,
          action: "product.archive.contended",
          entityType: "Raffle",
          entityId: raffleId,
          metadata: { productId, payments: stragglers },
        },
      });
    });
  }

  return { alreadyArchived: false, cancelledRaffleIds: liveIds };
}
