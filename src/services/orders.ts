import {
  DELIVERY_CODE_TTL_MS,
  MAX_DELIVERY_CODE_ATTEMPTS,
  deliveryCodeMatches,
  generateDeliveryCode,
  hashDeliveryCode,
} from "../lib/deliveryCode.js";
import { prisma } from "../lib/prisma.js";
import { NOTIFICATION_TYPES } from "../notifications/templates.js";
import { queueNotification } from "./notifications.js";
import type { Order } from "../generated/prisma/client.js";

/**
 * Fulfilment.
 *
 * The flow is deliberately asymmetric: the WINNER mints the delivery code and
 * the SELLER redeems it. That ordering is what makes redemption meaningful —
 * the seller can only produce a valid code if the winner handed it over, which
 * they would only do with the goods in front of them. A seller-generated code
 * would prove nothing.
 */

/**
 * How long after shipping the seller gets paid even if no code is ever
 * redeemed. Without this a silent winner strands the seller's money forever;
 * with it, the seller is paid unless someone actually disputes.
 */
export const AUTO_RELEASE_DAYS = 14;

export class OrderError extends Error {
  readonly code:
    | "NOT_FOUND"
    | "FORBIDDEN"
    | "WRONG_STATUS"
    | "NO_ADDRESS"
    | "CODE_EXPIRED"
    | "CODE_INVALID"
    | "TOO_MANY_ATTEMPTS"
    | "DISPUTED";

  constructor(code: OrderError["code"], message: string) {
    super(message);
    this.name = "OrderError";
    this.code = code;
  }
}

/** Fields safe to return. Note the absence of deliveryOtpHash. */
export const ORDER_FIELDS = {
  id: true,
  raffleId: true,
  productId: true,
  winnerUserId: true,
  sellerId: true,
  status: true,
  addressId: true,
  courier: true,
  trackingNumber: true,
  shippedAt: true,
  deliveredAt: true,
  confirmedAt: true,
  autoReleaseAt: true,
  grossAmount: true,
  platformFee: true,
  netAmount: true,
  createdAt: true,
  updatedAt: true,
} as const;

async function loadOrderFor(
  orderId: string,
  userId: string,
  role: "winner" | "seller" | "either",
) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      status: true,
      winnerUserId: true,
      sellerId: true,
      addressId: true,
      shippedAt: true,
      deliveryOtpHash: true,
      deliveryOtpExpiresAt: true,
      deliveryOtpAttempts: true,
    },
  });

  if (!order) throw new OrderError("NOT_FOUND", "Order not found");

  const isWinner = order.winnerUserId === userId;
  const isSeller = order.sellerId === userId;
  const allowed =
    role === "winner" ? isWinner : role === "seller" ? isSeller : isWinner || isSeller;

  // 404 rather than 403 for non-participants, so order ids cannot be probed.
  if (!allowed && !isWinner && !isSeller) {
    throw new OrderError("NOT_FOUND", "Order not found");
  }
  if (!allowed) {
    throw new OrderError(
      "FORBIDDEN",
      role === "winner"
        ? "Only the winner can do this"
        : "Only the seller can do this",
    );
  }

  return order;
}

/** Winner supplies a delivery address, which unblocks shipping. */
export async function setOrderAddress(
  orderId: string,
  winnerUserId: string,
  addressId: string,
): Promise<Order> {
  const order = await loadOrderFor(orderId, winnerUserId, "winner");

  if (order.status !== "AWAITING_ADDRESS" && order.status !== "AWAITING_SHIPMENT") {
    throw new OrderError(
      "WRONG_STATUS",
      `Cannot change the address once the order is ${order.status}`,
    );
  }

  const address = await prisma.address.findUnique({
    where: { id: addressId },
    select: { userId: true },
  });

  if (!address || address.userId !== winnerUserId) {
    throw new OrderError("NOT_FOUND", "Address not found");
  }

  // Transaction so the seller's "ship it" notification cannot be lost if the
  // process dies between the status change and the queueing.
  return prisma.$transaction(async (tx) => {
    const updated = await tx.order.update({
      where: { id: orderId },
      data: { addressId, status: "AWAITING_SHIPMENT" },
      include: { product: { select: { title: true } } },
    });

    await queueNotification(tx, {
      type: NOTIFICATION_TYPES.ORDER_AWAITING_SHIPMENT,
      recipientUserId: updated.sellerId,
      entityType: "Order",
      entityId: orderId,
      payload: { productTitle: updated.product.title, orderId },
    });

    return updated;
  }, { timeout: 15_000, maxWait: 10_000 });
}

/**
 * Seller dispatches the item. This starts the dispute window, so the clock
 * only runs once the seller has actually committed to sending something.
 */
export async function markOrderShipped(
  orderId: string,
  sellerId: string,
  details: { courier: string; trackingNumber?: string | null },
): Promise<Order> {
  const order = await loadOrderFor(orderId, sellerId, "seller");

  if (order.status !== "AWAITING_SHIPMENT") {
    if (order.status === "AWAITING_ADDRESS") {
      throw new OrderError(
        "NO_ADDRESS",
        "The winner has not provided a delivery address yet",
      );
    }
    throw new OrderError("WRONG_STATUS", `Order is ${order.status}, not awaiting shipment`);
  }

  const now = new Date();

  return prisma.order.update({
    where: { id: orderId },
    data: {
      status: "SHIPPED",
      courier: details.courier,
      trackingNumber: details.trackingNumber ?? null,
      shippedAt: now,
      autoReleaseAt: new Date(now.getTime() + AUTO_RELEASE_DAYS * 86_400_000),
    },
  });
}

export interface MintedDeliveryCode {
  display: string;
  expiresAt: Date;
}

/**
 * Winner mints a code at handover. Returned exactly once, in plaintext, to
 * the winner alone — only the HMAC is persisted, so it cannot be re-read
 * later from the database or from a log.
 */
export async function mintDeliveryCode(
  orderId: string,
  winnerUserId: string,
): Promise<MintedDeliveryCode> {
  const order = await loadOrderFor(orderId, winnerUserId, "winner");

  if (order.status === "DISPUTED") {
    throw new OrderError("DISPUTED", "This order is under dispute");
  }
  if (order.status !== "SHIPPED") {
    throw new OrderError(
      "WRONG_STATUS",
      `A delivery code can only be issued once the order is shipped (it is ${order.status})`,
    );
  }

  const { code, display } = generateDeliveryCode();
  const expiresAt = new Date(Date.now() + DELIVERY_CODE_TTL_MS);

  await prisma.order.update({
    where: { id: orderId },
    data: {
      deliveryOtpHash: hashDeliveryCode(code),
      deliveryOtpExpiresAt: expiresAt,
      // Minting a fresh code resets the budget; brute force has to beat the
      // 30 minute window, not accumulate attempts across codes.
      deliveryOtpAttempts: 0,
    },
  });

  return { display, expiresAt };
}

export interface DeliveryConfirmation {
  order: Order;
  /** True when escrow should now be released. */
  releaseDue: boolean;
}

/**
 * Seller redeems the code the winner gave them, which marks the item
 * delivered. This is the point at which the money becomes the seller's.
 */
export async function confirmDelivery(
  orderId: string,
  sellerId: string,
  submittedCode: string,
): Promise<DeliveryConfirmation> {
  const order = await loadOrderFor(orderId, sellerId, "seller");

  if (order.status === "DISPUTED") {
    throw new OrderError("DISPUTED", "This order is under dispute");
  }
  if (order.status === "DELIVERED" || order.status === "CONFIRMED") {
    throw new OrderError("WRONG_STATUS", "Delivery is already confirmed");
  }
  if (order.status !== "SHIPPED") {
    throw new OrderError("WRONG_STATUS", `Order is ${order.status}, not shipped`);
  }
  if (!order.deliveryOtpHash || !order.deliveryOtpExpiresAt) {
    throw new OrderError(
      "CODE_INVALID",
      "No delivery code has been issued; ask the winner to generate one",
    );
  }
  if (order.deliveryOtpAttempts >= MAX_DELIVERY_CODE_ATTEMPTS) {
    throw new OrderError(
      "TOO_MANY_ATTEMPTS",
      "Too many incorrect attempts; ask the winner for a new code",
    );
  }
  if (order.deliveryOtpExpiresAt.getTime() <= Date.now()) {
    throw new OrderError("CODE_EXPIRED", "That code has expired; ask the winner for a new one");
  }

  if (!deliveryCodeMatches(submittedCode, order.deliveryOtpHash)) {
    // Counted before returning, so a wrong guess always costs an attempt.
    await prisma.order.update({
      where: { id: orderId },
      data: { deliveryOtpAttempts: { increment: 1 } },
    });
    throw new OrderError("CODE_INVALID", "That delivery code is not correct");
  }

  const now = new Date();

  const updated = await prisma.order.update({
    where: { id: orderId },
    data: {
      status: "DELIVERED",
      deliveredAt: now,
      // Burned on use. A redeemed code must never work twice.
      deliveryOtpHash: null,
      deliveryOtpExpiresAt: null,
      deliveryOtpAttempts: 0,
    },
  });

  await prisma.auditLog.create({
    data: {
      actorUserId: sellerId,
      action: "order.delivered",
      entityType: "Order",
      entityId: orderId,
      metadata: { method: "delivery_code" },
    },
  });

  return { order: updated, releaseDue: true };
}

/** Either party raises a dispute, which freezes the money. */
export async function openDispute(
  orderId: string,
  userId: string,
  reason: string,
): Promise<{ disputeId: string }> {
  const order = await loadOrderFor(orderId, userId, "either");

  if (order.status === "CONFIRMED" || order.status === "REFUNDED") {
    throw new OrderError(
      "WRONG_STATUS",
      `Order is already ${order.status}; disputes must be raised before settlement`,
    );
  }

  const dispute = await prisma.$transaction(async (tx) => {
    const created = await tx.dispute.create({
      data: { orderId, raisedByUserId: userId, reason, status: "OPEN" },
      select: { id: true },
    });

    // Clearing autoReleaseAt is the freeze: the auto-release job selects on
    // that column, so a disputed order simply stops being eligible.
    await tx.order.update({
      where: { id: orderId },
      data: { status: "DISPUTED", autoReleaseAt: null },
    });

    await tx.auditLog.create({
      data: {
        actorUserId: userId,
        action: "order.dispute_opened",
        entityType: "Order",
        entityId: orderId,
        metadata: { disputeId: created.id },
      },
    });

    return created;
  });

  return { disputeId: dispute.id };
}
