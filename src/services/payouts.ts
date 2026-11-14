import { applyBasisPoints } from "../lib/money.js";
import { newReference } from "../lib/reference.js";
import { env } from "../env.js";
import { prisma } from "../lib/prisma.js";
import { decryptDestination } from "../lib/payoutSecrets.js";
import {
  paymentProvider,
  providerMovesRealMoney,
} from "../payments/index.js";
import {
  PaymentProviderError,
  type TransferDestination,
} from "../payments/provider.js";
import { NOTIFICATION_TYPES } from "../notifications/templates.js";
import { postLedgerTransaction, type LedgerLeg } from "./ledger.js";
import { queueNotification } from "./notifications.js";
import type { PayoutStatus } from "../generated/prisma/client.js";

/**
 * Escrow release and seller payout.
 *
 * These are two separate events on purpose:
 *
 *   ACCRUAL — the money stops being the buyers' and becomes the seller's.
 *             Happens the moment delivery is proven. Cannot fail.
 *   PAYOUT  — the money physically leaves our balance. Happens when the
 *             provider accepts a transfer, which can fail or be delayed.
 *
 * Collapsing them would mean a seller is owed nothing until a transfer
 * succeeds, so a provider outage would silently erase a debt we actually owe.
 */

export class PayoutError extends Error {
  readonly code:
    | "ORDER_NOT_FOUND"
    | "NOT_RELEASABLE"
    | "NO_ESCROW"
    | "PAYOUT_NOT_FOUND"
    | "SELLER_NOT_PAYABLE";

  constructor(code: PayoutError["code"], message: string) {
    super(message);
    this.name = "PayoutError";
    this.code = code;
  }
}

export type ReleaseReason = "delivery_confirmed" | "auto_release" | "dispute_resolved";

export interface ReleaseResult {
  orderId: string;
  grossAmount: number;
  platformFee: number;
  netAmount: number;
  payoutId: string;
  alreadyReleased: boolean;
}

/**
 * Posts the accrual and queues a payout. Idempotent on the order.
 */
export async function releaseEscrow(
  orderId: string,
  reason: ReleaseReason,
): Promise<ReleaseResult> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      status: true,
      sellerId: true,
      raffleId: true,
      autoReleaseAt: true,
      grossAmount: true,
      platformFee: true,
      netAmount: true,
      payout: { select: { id: true } },
      raffle: { select: { platformFeeBps: true } },
    },
  });

  if (!order) throw new PayoutError("ORDER_NOT_FOUND", "Order not found");

  if (order.status === "CONFIRMED" && order.payout) {
    return {
      orderId,
      grossAmount: order.grossAmount ?? 0,
      platformFee: order.platformFee ?? 0,
      netAmount: order.netAmount ?? 0,
      payoutId: order.payout.id,
      alreadyReleased: true,
    };
  }

  const eligible =
    order.status === "DELIVERED" ||
    (reason === "auto_release" &&
      order.status === "SHIPPED" &&
      order.autoReleaseAt !== null &&
      order.autoReleaseAt.getTime() <= Date.now()) ||
    (reason === "dispute_resolved" && order.status === "DISPUTED");

  if (!eligible) {
    throw new PayoutError(
      "NOT_RELEASABLE",
      `Order is ${order.status}; not releasable via ${reason}`,
    );
  }

  // What is actually in escrow for this raffle, taken from the payments that
  // succeeded rather than from ticketPrice x totalTickets. If a refund or a
  // partial sale happened, the arithmetic has to follow the real money.
  const escrow = await prisma.payment.aggregate({
    where: { raffleId: order.raffleId, status: "SUCCESS" },
    _sum: { amount: true },
  });

  const grossAmount = escrow._sum.amount ?? 0;
  if (grossAmount <= 0) {
    throw new PayoutError("NO_ESCROW", "No successful payments found for this raffle");
  }

  const platformFee = applyBasisPoints(grossAmount, order.raffle.platformFeeBps);
  const netAmount = grossAmount - platformFee;

  const payoutReference = newReference("pay");

  const result = await prisma.$transaction(
    async (tx) => {
      // Escrow liability discharges; the seller is now a creditor.
      const legs: LedgerLeg[] = [
        {
          account: "TICKET_ESCROW",
          amount: grossAmount,
          raffleId: order.raffleId,
          orderId,
        },
        {
          account: "SELLER_PAYABLE",
          userId: order.sellerId,
          amount: -netAmount,
          raffleId: order.raffleId,
          orderId,
        },
      ];

      // Omitted when the fee is zero: a zero-amount leg violates the ledger's
      // CHECK constraint, and rightly so.
      if (platformFee > 0) {
        legs.push({
          account: "PLATFORM_REVENUE",
          amount: -platformFee,
          raffleId: order.raffleId,
          orderId,
        });
      }

      await postLedgerTransaction(tx, {
        type: "PAYOUT_ACCRUAL",
        reference: `payout-accrual:${orderId}`,
        description: `Escrow released via ${reason}`,
        legs,
      });

      await tx.order.update({
        where: { id: orderId },
        data: {
          status: "CONFIRMED",
          confirmedAt: new Date(),
          autoReleaseAt: null,
          grossAmount,
          platformFee,
          netAmount,
        },
      });

      await tx.raffle.update({
        where: { id: order.raffleId },
        data: { status: "COMPLETED" },
      });

      const payout = await tx.payout.create({
        data: {
          orderId,
          sellerId: order.sellerId,
          amount: netAmount,
          currency: "GHS",
          reference: payoutReference,
          status: "PENDING",
        },
        select: { id: true },
      });

      await tx.auditLog.create({
        data: {
          action: "order.escrow_released",
          entityType: "Order",
          entityId: orderId,
          metadata: { reason, grossAmount, platformFee, netAmount },
        },
      });

      return payout.id;
    },
    { timeout: 20_000, maxWait: 10_000 },
  );

  return {
    orderId,
    grossAmount,
    platformFee,
    netAmount,
    payoutId: result,
    alreadyReleased: false,
  };
}

export interface SendPayoutResult {
  payoutId: string;
  status: PayoutStatus;
  failureReason: string | null;
}

/**
 * Attempts the actual transfer.
 *
 * Safe to call repeatedly: the provider is idempotent on our reference, and a
 * payout that is already PAID short-circuits. Designed to be driven by the job
 * runner so a provider outage becomes a retry rather than a lost debt.
 */
export async function sendPayout(payoutId: string): Promise<SendPayoutResult> {
  const payout = await prisma.payout.findUnique({
    where: { id: payoutId },
    select: {
      id: true,
      status: true,
      amount: true,
      reference: true,
      sellerId: true,
      seller: {
        select: {
          kycStatus: true,
          suspendedAt: true,
          sellerProfile: {
            select: {
              payoutsEnabled: true,
              providerRecipientCode: true,
              payoutDestinationCipher: true,
              recipientType: true,
              bankCode: true,
            },
          },
        },
      },
    },
  });

  if (!payout) throw new PayoutError("PAYOUT_NOT_FOUND", "Payout not found");

  if (payout.status === "PAID") {
    return { payoutId, status: "PAID", failureReason: null };
  }

  const seller = payout.seller;
  const profile = seller.sellerProfile;
  const recipientCode = profile?.providerRecipientCode ?? null;

  // Every reason a disbursement cannot go out right now. Checked in order of
  // severity so the recorded reason is the most useful one.
  // Resolved before the blockers so a rail that transfers to a raw account can
  // report a missing destination as a blocker like any other, rather than
  // failing mid-transfer with the money's status unknown.
  const provider = paymentProvider();
  let destination: TransferDestination | undefined;
  let destinationProblem: string | null = null;

  if (provider.transfersNeedDestination) {
    if (!profile?.payoutDestinationCipher || !profile.bankCode) {
      // A profile onboarded under a provider that kept the account itself: the
      // recipient code it holds is meaningless to this rail. Re-onboarding is
      // the fix, and leaving it PENDING is what makes that retroactive.
      destinationProblem = "no_payout_destination";
    } else {
      try {
        destination = {
          kind: profile.recipientType === "bank" ? "bank" : "mobile_money",
          accountNumber: decryptDestination(profile.payoutDestinationCipher),
          bankCode: profile.bankCode,
        };
      } catch {
        // A key rotation or an edited row. Must not become a transfer to
        // whatever the bytes decode to.
        destinationProblem = "payout_destination_unreadable";
      }
    }
  }

  let blocked: string | null = null;
  // Checked FIRST, ahead of every seller-specific reason, because it is the
  // only one where proceeding would corrupt rather than merely delay. A
  // sandbox provider would transfer fake money and markPayoutPaid would
  // record a real SELLER_PAYOUT — the books would then say a debt was settled
  // that nobody was paid, and nothing downstream could tell that apart from a
  // genuine payment. Left PENDING, so flipping to a live provider releases it.
  if (!providerMovesRealMoney() && !env.ALLOW_TEST_MONEY_ON_REAL_DATA) {
    blocked = "provider_in_test_mode";
  } else if (seller.suspendedAt !== null) blocked = "seller_suspended";
  else if (seller.kycStatus !== "APPROVED") blocked = "kyc_not_approved";
  else if (!profile?.payoutsEnabled) blocked = "payouts_not_enabled";
  else if (!recipientCode) blocked = "no_payout_recipient";
  else if (destinationProblem) blocked = destinationProblem;

  if (blocked) {
    // Left PENDING, not FAILED. The debt is real and the ledger already says
    // so; this is a blocked disbursement, not a cancelled one.
    await prisma.payout.update({
      where: { id: payoutId },
      data: { status: "PENDING", failureReason: blocked },
    });
    return { payoutId, status: "PENDING", failureReason: blocked };
  }

  await prisma.payout.update({
    where: { id: payoutId },
    data: { status: "PROCESSING", failureReason: null },
  });

  // Unreachable: the guard above returns whenever recipientCode is null.
  // Stated explicitly rather than with a non-null assertion, so a future edit
  // to the guard fails loudly here instead of transferring to nowhere.
  if (!recipientCode) {
    throw new PayoutError("SELLER_NOT_PAYABLE", "No payout recipient on file");
  }

  try {
    const snapshot = await provider.payout({
      reference: payout.reference,
      amountMinor: payout.amount,
      recipientCode,
      reason: "Bafle raffle payout",
      ...(destination ? { destination } : {}),
    });

    if (snapshot.state === "succeeded") {
      await markPayoutPaid(payoutId, snapshot.providerRef, snapshot.feeMinor);
      return { payoutId, status: "PAID", failureReason: null };
    }

    if (snapshot.state === "failed" || snapshot.state === "reversed") {
      await prisma.payout.update({
        where: { id: payoutId },
        data: {
          status: snapshot.state === "reversed" ? "REVERSED" : "FAILED",
          providerTransferCode: snapshot.providerRef,
          failureReason: snapshot.failureReason ?? "provider_rejected",
        },
      });
      return {
        payoutId,
        status: snapshot.state === "reversed" ? "REVERSED" : "FAILED",
        failureReason: snapshot.failureReason ?? "provider_rejected",
      };
    }

    // Still in flight. The cash leg is posted when the webhook confirms, not
    // optimistically — money that has not moved must not appear to have moved.
    await prisma.payout.update({
      where: { id: payoutId },
      data: { status: "PROCESSING", providerTransferCode: snapshot.providerRef },
    });
    return { payoutId, status: "PROCESSING", failureReason: null };
  } catch (error) {
    const reason =
      error instanceof PaymentProviderError
        ? (error.providerMessage ?? error.message)
        : "transfer_call_failed";

    await prisma.payout.update({
      where: { id: payoutId },
      data: { status: "FAILED", failureReason: reason },
    });

    return { payoutId, status: "FAILED", failureReason: reason };
  }
}

/**
 * Records that money actually left our balance. Called on a successful
 * transfer or from the provider's transfer.success webhook.
 */
export async function markPayoutPaid(
  payoutId: string,
  providerRef: string | null,
  /**
   * What the provider charged us to send it, where it reports one.
   *
   * Measured against the Moolre sandbox on 2026-11-14: a GHS 5.00 transfer
   * debited GHS 5.05. The fee is charged **on top**, so the cash leg has to be
   * `amount + fee` with the difference booked as an expense — otherwise our
   * PLATFORM_CASH drifts below the real wallet by the fee on every payout, and
   * the ledger would still sum to zero while being wrong about the money.
   */
  feeMinor: number | null = null,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const payout = await tx.payout.findUnique({
      where: { id: payoutId },
      select: { id: true, status: true, amount: true, sellerId: true, orderId: true },
    });

    if (!payout || payout.status === "PAID") return;

    const fee = feeMinor ?? 0;

    await tx.payout.update({
      where: { id: payoutId },
      data: {
        status: "PAID",
        paidAt: new Date(),
        providerTransferCode: providerRef,
        feeMinor,
        failureReason: null,
      },
    });

    // The creditor is settled and our cash drops. Keyed on the payout id, so a
    // duplicated webhook cannot post the cash movement twice.
    await postLedgerTransaction(tx, {
      type: "SELLER_PAYOUT",
      reference: `seller-payout:${payoutId}`,
      legs: [
        {
          account: "SELLER_PAYABLE",
          userId: payout.sellerId,
          amount: payout.amount,
          orderId: payout.orderId,
          payoutId,
        },
        // Only when there is one, so a provider that reports no fee produces
        // exactly the two legs it always did.
        ...(fee > 0
          ? [
              {
                account: "PSP_FEES" as const,
                amount: fee,
                orderId: payout.orderId,
                payoutId,
              },
            ]
          : []),
        {
          account: "PLATFORM_CASH",
          amount: -(payout.amount + fee),
          orderId: payout.orderId,
          payoutId,
        },
      ],
    });

    // Inside the transaction: an audit row that can disagree with the ledger
    // is worse than no audit row.
    const paidOrder = await tx.order.findUnique({
      where: { id: payout.orderId },
      select: { product: { select: { title: true } } },
    });

    await queueNotification(tx, {
      type: NOTIFICATION_TYPES.PAYOUT_PAID,
      recipientUserId: payout.sellerId,
      entityType: "Payout",
      entityId: payoutId,
      payload: {
        productTitle: paidOrder?.product.title,
        orderId: payout.orderId,
        amountMinor: payout.amount,
      },
    });

    await tx.auditLog.create({
      data: {
        action: "payout.paid",
        entityType: "Payout",
        entityId: payoutId,
        metadata: {
          sellerId: payout.sellerId,
          orderId: payout.orderId,
          amount: payout.amount,
          providerRef,
        },
      },
    });
  });
}

/** Marks a transfer as failed, from the provider's webhook. */
/**
 * Settles a payout that the provider last reported as in flight.
 *
 * Exists because a transfer can be asynchronous on a rail that sends no
 * transfer webhook — and `runSweeps` deliberately will not re-queue a
 * PROCESSING payout, since re-sending risks paying a seller twice. Without
 * something to poll, such a payout stays PROCESSING forever and the seller is
 * never told their money arrived. This is that something.
 *
 * Read-only against the provider, so it is safe to run as often as the queue
 * likes: it asks what happened, it never moves money.
 */
export async function reconcilePayout(
  payoutId: string,
): Promise<SendPayoutResult> {
  const payout = await prisma.payout.findUnique({
    where: { id: payoutId },
    select: { id: true, status: true, reference: true },
  });

  if (!payout) throw new PayoutError("PAYOUT_NOT_FOUND", "Payout not found");

  // Anything already decided is success for the job: a payout settled by a
  // webhook between the sweep selecting it and this running is the normal
  // race, not an error to retry.
  if (payout.status !== "PROCESSING") {
    return { payoutId, status: payout.status, failureReason: null };
  }

  const snapshot = await paymentProvider().checkPayoutStatus(payout.reference);

  if (snapshot.state === "succeeded") {
    await markPayoutPaid(payoutId, snapshot.providerRef, snapshot.feeMinor);
    return { payoutId, status: "PAID", failureReason: null };
  }

  if (snapshot.state === "failed" || snapshot.state === "reversed") {
    const status = snapshot.state === "reversed" ? "REVERSED" : "FAILED";
    await prisma.payout.update({
      where: { id: payoutId },
      data: {
        status,
        providerTransferCode: snapshot.providerRef,
        failureReason: snapshot.failureReason ?? "provider_reported_failure",
      },
    });
    return {
      payoutId,
      status,
      failureReason: snapshot.failureReason ?? "provider_reported_failure",
    };
  }

  // Still in flight. Left exactly as it was so the next sweep asks again.
  return { payoutId, status: "PROCESSING", failureReason: null };
}

export async function markPayoutFailed(
  reference: string,
  failureReason: string,
): Promise<void> {
  await prisma.payout.updateMany({
    where: { reference, status: { in: ["PENDING", "PROCESSING"] } },
    data: { status: "FAILED", failureReason },
  });
}

/**
 * Orders whose dispute window elapsed with no dispute.
 *
 * Disputed orders have a null autoReleaseAt and so are structurally excluded
 * from this query rather than filtered out of its results.
 *
 * Shared by the job sweep and by autoReleaseDueOrders below, so there is only
 * one definition of "due for release".
 */
export async function findOrdersDueForRelease(limit = 20): Promise<string[]> {
  const due = await prisma.order.findMany({
    where: { status: "SHIPPED", autoReleaseAt: { lte: new Date() } },
    select: { id: true },
    orderBy: { autoReleaseAt: "asc" },
    take: limit,
  });
  return due.map((order) => order.id);
}

/**
 * Releases every due order immediately, in process.
 *
 * The queued path (ORDER_RELEASE jobs) is what production uses, because it
 * retries per order. This remains for tests and manual operator use.
 */
export async function autoReleaseDueOrders(limit = 20): Promise<string[]> {
  const dueIds = await findOrdersDueForRelease(limit);
  const due = dueIds.map((id) => ({ id }));

  const released: string[] = [];
  for (const order of due) {
    const result = await releaseEscrow(order.id, "auto_release");
    released.push(order.id);
    // Best effort: a blocked or failing transfer is retried by the job runner.
    await sendPayout(result.payoutId).catch(() => undefined);
  }

  return released;
}
