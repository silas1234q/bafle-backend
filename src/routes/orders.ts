import { Router } from "express";
import { z } from "zod";

import { param } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";
import { localUser, requireUser } from "../middleware/auth.js";
import { contentLimiter, deliveryCodeLimiter } from "../middleware/rateLimit.js";
import {
  confirmDelivery,
  markOrderShipped,
  mintDeliveryCode,
  openDispute,
  ORDER_FIELDS,
  OrderError,
  setOrderAddress,
} from "../services/orders.js";
import { releaseEscrow, sendPayout } from "../services/payouts.js";

export const ordersRouter = Router();

ordersRouter.use(requireUser);

const ORDER_ERROR_STATUS: Record<OrderError["code"], number> = {
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  WRONG_STATUS: 409,
  NO_ADDRESS: 409,
  CODE_EXPIRED: 410,
  CODE_INVALID: 400,
  TOO_MANY_ATTEMPTS: 429,
  DISPUTED: 409,
};

/** Translates service errors into responses, so handlers stay readable. */
function handle(error: unknown, res: import("express").Response): boolean {
  if (error instanceof OrderError) {
    res.status(ORDER_ERROR_STATUS[error.code]).json({
      error: error.message,
      code: error.code,
    });
    return true;
  }
  return false;
}

ordersRouter.get("/", async (req, res) => {
  const user = localUser(req);

  const orders = await prisma.order.findMany({
    where: { OR: [{ winnerUserId: user.id }, { sellerId: user.id }] },
    select: {
      ...ORDER_FIELDS,
      product: { select: { id: true, title: true, slug: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  res.json(
    orders.map((order) => ({
      ...order,
      role: order.winnerUserId === user.id ? "winner" : "seller",
    })),
  );
});

ordersRouter.get("/:id", async (req, res) => {
  const user = localUser(req);

  const order = await prisma.order.findUnique({
    where: { id: param(req, "id") },
    select: {
      ...ORDER_FIELDS,
      product: { select: { id: true, title: true, slug: true } },
      address: true,
      disputes: {
        select: { id: true, status: true, reason: true, createdAt: true },
      },
    },
  });

  const isParticipant =
    order && (order.winnerUserId === user.id || order.sellerId === user.id);

  // 404 for everyone else, so order ids cannot be enumerated.
  if (!order || !isParticipant) {
    res.status(404).json({ error: "Order not found" });
    return;
  }

  res.json({
    ...order,
    role: order.winnerUserId === user.id ? "winner" : "seller",
  });
});

const addressSchema = z.object({ addressId: z.uuid() });

ordersRouter.post("/:id/address", async (req, res) => {
  const parsed = addressSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "addressId is required" });
    return;
  }

  try {
    const order = await setOrderAddress(
      param(req, "id"),
      localUser(req).id,
      parsed.data.addressId,
    );
    res.json(order);
  } catch (error) {
    if (!handle(error, res)) throw error;
  }
});

const shipSchema = z.object({
  courier: z.string().trim().min(2).max(80),
  trackingNumber: z.string().trim().min(1).max(120).optional(),
});

ordersRouter.post("/:id/ship", async (req, res) => {
  const parsed = shipSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid shipment", issues: z.treeifyError(parsed.error) });
    return;
  }

  try {
    const order = await markOrderShipped(param(req, "id"), localUser(req).id, {
      courier: parsed.data.courier,
      trackingNumber: parsed.data.trackingNumber ?? null,
    });
    res.json(order);
  } catch (error) {
    if (!handle(error, res)) throw error;
  }
});

/**
 * Winner mints the handover code. Returned once, in plaintext; only its HMAC
 * is stored, so this response is the only chance to read it.
 */
ordersRouter.post("/:id/delivery-code", deliveryCodeLimiter, async (req, res) => {
  try {
    const minted = await mintDeliveryCode(param(req, "id"), localUser(req).id);
    res.json({
      code: minted.display,
      expiresAt: minted.expiresAt,
      instructions:
        "Read this code to the courier at handover. It expires in 30 minutes and can only be used once.",
    });
  } catch (error) {
    if (!handle(error, res)) throw error;
  }
});

const confirmSchema = z.object({ code: z.string().trim().min(4).max(20) });

/**
 * Seller redeems the code, which proves delivery and releases escrow.
 */
ordersRouter.post("/:id/confirm-delivery", deliveryCodeLimiter, async (req, res) => {
  const parsed = confirmSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "code is required" });
    return;
  }

  const orderId = param(req, "id");

  try {
    const { releaseDue } = await confirmDelivery(
      orderId,
      localUser(req).id,
      parsed.data.code,
    );

    if (!releaseDue) {
      res.json({ status: "delivered", released: false });
      return;
    }

    const release = await releaseEscrow(orderId, "delivery_confirmed");
    // The transfer may be blocked (KYC, no recipient) or fail at the provider.
    // That does not undo the release: the seller is already a creditor in the
    // ledger, and the job runner retries the disbursement.
    const payout = await sendPayout(release.payoutId).catch(() => null);

    res.json({
      status: "delivered",
      released: true,
      grossAmount: release.grossAmount,
      platformFee: release.platformFee,
      netAmount: release.netAmount,
      payout: payout
        ? { status: payout.status, failureReason: payout.failureReason }
        : { status: "PENDING", failureReason: "payout_attempt_failed" },
    });
  } catch (error) {
    if (!handle(error, res)) throw error;
  }
});

const disputeSchema = z.object({
  reason: z.string().trim().min(10).max(2_000),
});

ordersRouter.post("/:id/dispute", contentLimiter, async (req, res) => {
  const parsed = disputeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "A reason of at least 10 characters is required",
      issues: z.treeifyError(parsed.error),
    });
    return;
  }

  try {
    const dispute = await openDispute(
      param(req, "id"),
      localUser(req).id,
      parsed.data.reason,
    );
    res.status(201).json({ ...dispute, status: "OPEN" });
  } catch (error) {
    if (!handle(error, res)) throw error;
  }
});
