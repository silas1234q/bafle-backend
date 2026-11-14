import { Router } from "express";
import { z } from "zod";

import { isOwnCloudinaryUrl } from "../images/cloudinary.js";
import { param } from "../lib/http.js";
import { newReference } from "../lib/reference.js";
import { localUser, requireRole, requireUser } from "../middleware/auth.js";
import { contentLimiter } from "../middleware/rateLimit.js";
import { prisma } from "../lib/prisma.js";
import {
  archiveProduct,
  ProductMutationError,
  updateProduct,
} from "../services/products.js";

export const productsRouter = Router();

const createProductSchema = z.object({
  title: z.string().trim().min(3).max(140),
  description: z.string().trim().min(10).max(5_000),
  category: z.string().trim().min(2).max(60),
  condition: z.enum(["NEW", "REFURBISHED", "USED"]).default("NEW"),
  /** Pesewas. Integer by contract, same as every other amount. */
  retailValue: z.int().positive().max(2_147_483_647),
  images: z
    .array(
      z.object({
        // Not just "a valid URL". An arbitrary host here would let a seller
        // point a listing at a tracking pixel that deanonymises viewers, or
        // swap the image for something else after moderation approved it.
        url: z
          .url()
          .refine(isOwnCloudinaryUrl, "Image URLs must be uploads in our own Cloudinary account"),
        alt: z.string().trim().max(200).optional(),
      }),
    )
    .max(10)
    .default([]),
});

/** Public listing shape. Never exposes moderation notes or reviewer ids. */
const publicProductFields = {
  id: true,
  sellerId: true,
  title: true,
  slug: true,
  description: true,
  category: true,
  condition: true,
  retailValue: true,
  status: true,
  createdAt: true,
  images: { select: { url: true, alt: true, position: true } },
} as const;

function toSlug(title: string): string {
  const stem = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  // Suffixed rather than deduplicated: two sellers listing "iPhone 13" is
  // normal, and a retry loop on slug collisions is wasted work.
  //
  // The prefix must be 2-8 lowercase letters — `newReference` throws
  // otherwise, and "p" did, which made every POST /products a 500.
  return `${stem || "item"}-${newReference("prod").split("-")[1]?.slice(0, 8) ?? "x"}`;
}

productsRouter.get("/", async (req, res) => {
  const category = typeof req.query.category === "string" ? req.query.category : undefined;

  const products = await prisma.product.findMany({
    where: { status: "ACTIVE", ...(category ? { category } : {}) },
    select: publicProductFields,
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  res.json(products);
});

/**
 * The seller's own listings, in every status.
 *
 * `GET /` only ever returns ACTIVE products, so without this a seller cannot
 * see the draft they just created or find out why one was rejected. Unlike the
 * public projection this includes `moderationNotes` — the rejection reason is
 * precisely what the seller needs — and the live raffle, so the UI can tell
 * "ready to raffle" apart from "already running".
 *
 * MUST stay above `/:id`, or Express matches "mine" as a product id.
 */
productsRouter.get("/mine", requireUser, async (req, res) => {
  const user = localUser(req);

  const products = await prisma.product.findMany({
    // ARCHIVED is excluded: the point of archiving is that the listing leaves
    // the seller's list. The row stays for the raffles and orders that
    // reference it, but nothing here should resurrect it.
    where: { sellerId: user.id, status: { not: "ARCHIVED" } },
    select: {
      ...publicProductFields,
      moderationNotes: true,
      reviewedAt: true,
      // A product carries at most one unfinished raffle (enforced by the
      // partial unique index), so this is a list of zero or one.
      raffles: {
        where: { status: { in: ["OPEN", "SOLD_OUT", "DRAWN"] } },
        select: {
          id: true,
          status: true,
          ticketPrice: true,
          totalTickets: true,
          ticketsSold: true,
          closesAt: true,
        },
        take: 1,
      },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  res.json(products);
});

productsRouter.get("/:id", async (req, res) => {
  const product = await prisma.product.findUnique({
    where: { id: param(req, "id") },
    select: publicProductFields,
  });

  if (!product) {
    res.status(404).json({ error: "Product not found" });
    return;
  }

  res.json(product);
});

productsRouter.post("/", requireUser, contentLimiter, async (req, res) => {
  const parsed = createProductSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid product", issues: z.treeifyError(parsed.error) });
    return;
  }

  const user = localUser(req);
  const input = parsed.data;

  const product = await prisma.product.create({
    data: {
      sellerId: user.id,
      title: input.title,
      slug: toSlug(input.title),
      description: input.description,
      category: input.category,
      condition: input.condition,
      retailValue: input.retailValue,
      status: "DRAFT",
      images: {
        create: input.images.map((image, index) => ({
          url: image.url,
          alt: image.alt ?? null,
          position: index,
        })),
      },
    },
    select: publicProductFields,
  });

  res.status(201).json(product);
});

/**
 * Seller publishes their own listing. No review step.
 *
 * This used to move the product to PENDING_REVIEW and wait for a moderator.
 * That gate was removed deliberately: a seller publishes straight to ACTIVE
 * and can open a raffle immediately.
 *
 * What that costs, so it is not rediscovered the hard way: nothing now
 * verifies a listing before it sells tickets. A fabricated item can take real
 * money from real buyers, and the only remedy is after the fact — the
 * `/moderate` route below, which is now a takedown tool rather than a gate.
 */
productsRouter.post("/:id/publish", requireUser, async (req, res) => {
  const user = localUser(req);

  const product = await prisma.product.findUnique({
    where: { id: param(req, "id") },
    select: { id: true, sellerId: true, status: true },
  });

  if (!product || product.sellerId !== user.id) {
    // Same response whether it is missing or someone else's, so this cannot
    // be used to enumerate other sellers' drafts.
    res.status(404).json({ error: "Product not found" });
    return;
  }

  if (product.status !== "DRAFT" && product.status !== "REJECTED") {
    res.status(409).json({ error: `Cannot publish a product that is ${product.status}` });
    return;
  }

  const updated = await prisma.product.update({
    where: { id: product.id },
    data: { status: "ACTIVE" },
    select: publicProductFields,
  });

  res.json(updated);
});

/**
 * Every field optional — this is a PATCH, and the seller's form may only have
 * touched the title. `images`, when present, replaces the whole gallery.
 */
const updateProductSchema = createProductSchema.partial().refine(
  (body) => Object.keys(body).length > 0,
  "Nothing to update",
);

const MUTATION_STATUS: Record<ProductMutationError["code"], number> = {
  NOT_FOUND: 404,
  TICKETS_SOLD: 409,
  CHECKOUT_IN_PROGRESS: 409,
  BREAKS_PRICING_FLOOR: 409,
};

/**
 * Resolves a product the caller owns.
 *
 * Returns 404 for both "no such product" and "someone else's product", the
 * same as `/publish` — distinguishing them would let anyone enumerate other
 * sellers' listing ids.
 */
async function findOwnProduct(
  productId: string,
  userId: string,
): Promise<{ id: string } | null> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, sellerId: true },
  });

  if (!product || product.sellerId !== userId) return null;
  return { id: product.id };
}

/**
 * Seller edits their own listing.
 *
 * Refused outright once a ticket has been paid for — see `services/products.ts`
 * for why: the listing is what buyers paid against.
 */
productsRouter.patch("/:id", requireUser, contentLimiter, async (req, res) => {
  const parsed = updateProductSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid product", issues: z.treeifyError(parsed.error) });
    return;
  }

  const user = localUser(req);
  const owned = await findOwnProduct(param(req, "id"), user.id);
  if (!owned) {
    res.status(404).json({ error: "Product not found" });
    return;
  }

  try {
    await updateProduct(owned.id, parsed.data);
  } catch (error) {
    if (error instanceof ProductMutationError) {
      res.status(MUTATION_STATUS[error.code]).json({
        error: error.message,
        code: error.code,
      });
      return;
    }
    throw error;
  }

  const updated = await prisma.product.findUniqueOrThrow({
    where: { id: owned.id },
    select: publicProductFields,
  });

  res.json(updated);
});

/**
 * Seller withdraws their own listing.
 *
 * A soft archive, not a row delete — Raffle and Order reference Product, so a
 * completed sale's history has to survive. Any raffle that nobody has paid
 * into is cancelled along with it, because `GET /raffles` filters on raffle
 * status alone and would otherwise keep selling tickets for this listing.
 */
productsRouter.delete("/:id", requireUser, async (req, res) => {
  const user = localUser(req);
  const owned = await findOwnProduct(param(req, "id"), user.id);
  if (!owned) {
    res.status(404).json({ error: "Product not found" });
    return;
  }

  try {
    const result = await archiveProduct(owned.id, user.id);
    res.json({ id: owned.id, status: "ARCHIVED", ...result });
  } catch (error) {
    if (error instanceof ProductMutationError) {
      res.status(MUTATION_STATUS[error.code]).json({
        error: error.message,
        code: error.code,
      });
      return;
    }
    throw error;
  }
});

const moderationSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  notes: z.string().trim().max(1_000).optional(),
});

/**
 * Moderator takedown / reinstatement.
 *
 * No longer a gate — sellers publish themselves (see `/publish` above), so
 * this runs *after* a listing is already live and possibly already selling
 * tickets. "reject" pulls it from the public catalogue; it does not touch any
 * raffle already open against the product, which has to be cancelled and
 * refunded separately.
 */
productsRouter.post(
  "/:id/moderate",
  requireUser,
  requireRole("ADMIN", "MODERATOR"),
  async (req, res) => {
    const parsed = moderationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid decision", issues: z.treeifyError(parsed.error) });
      return;
    }

    const reviewer = localUser(req);
    const product = await prisma.product.findUnique({
      where: { id: param(req, "id") },
      select: { id: true, status: true },
    });

    if (!product) {
      res.status(404).json({ error: "Product not found" });
      return;
    }

    const updated = await prisma.product.update({
      where: { id: product.id },
      data: {
        status: parsed.data.decision === "approve" ? "ACTIVE" : "REJECTED",
        moderationNotes: parsed.data.notes ?? null,
        reviewedByUserId: reviewer.id,
        reviewedAt: new Date(),
      },
      select: publicProductFields,
    });

    await prisma.auditLog.create({
      data: {
        actorUserId: reviewer.id,
        action: `product.${parsed.data.decision}`,
        entityType: "Product",
        entityId: product.id,
        metadata: { from: product.status, to: updated.status },
      },
    });

    res.json(updated);
  },
);
