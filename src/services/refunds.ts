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
import { postLedgerTransaction } from "./ledger.js";
import { queueNotification } from "./notifications.js";

/**
 * Refunds for raffles that closed without selling out.
 *
 * Written to be resumable, because partial completion is the EXPECTED state
 * after any failure: refunding 40 buyers means 40 provider calls, and the
 * process can die between any two of them. Every step is therefore keyed on
 * durable rows, and re-running skips what is already done.
 *
 * Note that the platform absorbs the provider's original fee here: we refund
 * the full ticket price but only ever received the price minus that fee. The
 * loss is already booked as PSP_FEES at purchase time, so the ledger stays
 * balanced; it is a real business cost of an unsold raffle, not a bug.
 */

export interface RefundRunResult {
  raffleId: string;
  initiated: number;
  settled: number;
  failed: number;
  /**
   * Payments that cannot be refunded automatically because we never learned
   * where to send the money — see the destination handling in `refundRaffle`.
   * Non-zero means a human has to pay someone back by hand, so it is reported
   * rather than folded into `failed`.
   */
  blocked: number;
  remaining: number;
  raffleStatus: string;
}

/**
 * Moves raffles past their deadline into the refund path.
 *
 * The conditional UPDATE means exactly one worker can claim each raffle, so
 * two job ticks running concurrently cannot both start refunding.
 */
export async function expireOverdueRaffles(limit = 10): Promise<string[]> {
  const candidates = await prisma.raffle.findMany({
    where: { status: "OPEN", closesAt: { lte: new Date() } },
    select: { id: true },
    orderBy: { closesAt: "asc" },
    take: limit,
  });

  const claimed: string[] = [];

  for (const candidate of candidates) {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE "Raffle"
         SET "status" = 'EXPIRED'::"RaffleStatus",
             "updatedAt" = now()
       WHERE "id" = ${candidate.id}
         AND "status" = 'OPEN'::"RaffleStatus"
         AND "closesAt" <= now()
       RETURNING "id"
    `;
    if (rows.length > 0) claimed.push(candidate.id);
  }

  return claimed;
}

/**
 * Initiates (or resumes) refunds for one raffle.
 *
 * Only ever advances state. A payment that already has a non-failed refund is
 * skipped, so calling this repeatedly is safe and is in fact how recovery
 * works.
 */
export async function refundRaffle(raffleId: string): Promise<RefundRunResult> {
  const raffle = await prisma.raffle.findUnique({
    where: { id: raffleId },
    select: { id: true, status: true },
  });

  if (!raffle) throw new Error(`Raffle ${raffleId} not found`);

  // Already finished. Returned as a no-op rather than thrown, because this is
  // driven by a retrying job runner: a raffle that completed between the job
  // selecting it and the handler running is a normal race, not an error.
  if (raffle.status === "REFUNDED") {
    return {
      raffleId,
      initiated: 0,
      settled: 0,
      failed: 0,
      blocked: 0,
      remaining: 0,
      raffleStatus: raffle.status,
    };
  }

  const refundable = ["EXPIRED", "REFUNDING", "CANCELLED"];
  if (!refundable.includes(raffle.status)) {
    throw new Error(
      `Raffle ${raffleId} is ${raffle.status}; only ${refundable.join("/")} raffles are refunded`,
    );
  }

  if (raffle.status !== "REFUNDING") {
    await prisma.raffle.update({
      where: { id: raffleId },
      data: { status: "REFUNDING" },
    });
  }

  const payments = await prisma.payment.findMany({
    where: {
      raffleId,
      status: "SUCCESS",
      // Anything with a live refund attempt is already handled.
      refunds: { none: { status: { in: ["PENDING", "PROCESSING", "SUCCEEDED"] } } },
    },
    select: {
      id: true,
      reference: true,
      amount: true,
      userId: true,
      refundDestinationCipher: true,
      refundChannel: true,
    },
  });

  let initiated = 0;
  let settled = 0;
  let failed = 0;
  let blocked = 0;

  const provider = paymentProvider();

  // Same reasoning as the payout blocker: a sandbox refund would move fake
  // money while settleRefund posted a real TICKET_REFUND, telling us a buyer
  // was paid back when they were not. Refusing the whole run leaves every
  // payment untouched and `remaining` non-zero, so the raffle cannot reach
  // REFUNDED on the strength of refunds that never happened.
  if (!providerMovesRealMoney() && !env.ALLOW_TEST_MONEY_ON_REAL_DATA) {
    return {
      raffleId,
      initiated: 0,
      settled: 0,
      failed: 0,
      blocked: payments.length,
      remaining: payments.length,
      raffleStatus: raffle.status,
    };
  }

  for (const payment of payments) {
    // A provider with no refund endpoint refunds by transferring back, which
    // needs the payer's account. That is only ever disclosed in a payment
    // callback, so a payment confirmed solely by the buyer returning to /paid
    // has nothing recorded — and in local development, where the callback
    // cannot reach localhost at all, that is every payment.
    //
    // No Refund row is created in that case, deliberately. Writing a FAILED one
    // would mint a fresh row on every sweep, since FAILED is outside the
    // "already handled" filter above. Leaving the payment untouched keeps
    // `remaining` non-zero so the raffle never reaches REFUNDED while a real
    // buyer is still owed money, and surfaces the count for a human.
    let destination: TransferDestination | undefined;
    if (provider.transfersNeedDestination) {
      if (!payment.refundDestinationCipher || !payment.refundChannel) {
        blocked++;
        continue;
      }
      try {
        destination = {
          kind: payment.refundChannel === "2" ? "bank" : "mobile_money",
          accountNumber: decryptDestination(payment.refundDestinationCipher),
          bankCode: payment.refundChannel,
        };
      } catch {
        blocked++;
        continue;
      }
    }

    const reference = newReference("rfn");

    const refund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        reference,
        amount: payment.amount,
        reason: "raffle_expired_not_sold_out",
        status: "PENDING",
      },
      select: { id: true },
    });
    initiated++;

    try {
      const snapshot = await provider.refund({
        paymentReference: payment.reference,
        refundReference: reference,
        amountMinor: payment.amount,
        reason: "Raffle closed without selling out",
        ...(destination ? { destination } : {}),
      });

      if (snapshot.state === "succeeded") {
        await settleRefund(refund.id, snapshot.providerRefundId, snapshot.feeMinor);
        settled++;
      } else if (snapshot.state === "failed") {
        await prisma.refund.update({
          where: { id: refund.id },
          data: { status: "FAILED", failureReason: "provider_rejected" },
        });
        failed++;
      } else {
        // Paystack refunds settle over days. Left PROCESSING; the ledger moves
        // only when refund.processed arrives, because the cash has not left yet.
        await prisma.refund.update({
          where: { id: refund.id },
          data: {
            status: "PROCESSING",
            providerRefundId: snapshot.providerRefundId,
          },
        });
      }
    } catch (error) {
      await prisma.refund.update({
        where: { id: refund.id },
        data: {
          status: "FAILED",
          failureReason:
            error instanceof PaymentProviderError
              ? (error.providerMessage ?? error.message)
              : "refund_call_failed",
        },
      });
      failed++;
    }
  }

  const status = await finaliseRaffleIfFullyRefunded(raffleId);

  const remaining = await prisma.payment.count({
    where: {
      raffleId,
      status: "SUCCESS",
      refunds: { none: { status: "SUCCEEDED" } },
    },
  });

  return {
    raffleId,
    initiated,
    settled,
    failed,
    blocked,
    remaining,
    raffleStatus: status,
  };
}

/**
 * Records that a refund actually left our balance: marks the tickets refunded
 * and reverses the escrow entry.
 *
 * Idempotent on the refund row, so a replayed `refund.processed` webhook
 * cannot double-reverse the ledger.
 */
/**
 * Settles a refund the provider last reported as in flight.
 *
 * The refund counterpart of `reconcilePayout`, and needed for the same
 * reason: where a refund is an outbound transfer rather than a card reversal,
 * it completes asynchronously and the provider sends no transfer webhook to
 * say so. A PROCESSING refund would otherwise sit there while the buyer waits,
 * and `finaliseRaffleIfFullyRefunded` would never see the raffle finish.
 *
 * Read-only against the provider. Settling is still routed through
 * `settleRefund`, so the ledger entry is written in exactly one place.
 */
export async function reconcileRefund(refundId: string): Promise<{
  refundId: string;
  status: string;
}> {
  const refund = await prisma.refund.findUnique({
    where: { id: refundId },
    select: { id: true, status: true, reference: true, providerRefundId: true },
  });

  if (!refund) throw new Error(`Refund ${refundId} not found`);

  // Already decided elsewhere — a webhook beat the sweep. Normal, not an error.
  if (refund.status !== "PROCESSING") {
    return { refundId, status: refund.status };
  }

  const snapshot = await paymentProvider().checkRefundStatus({
    refundReference: refund.reference,
    providerRefundId: refund.providerRefundId,
  });

  if (snapshot.state === "succeeded") {
    // The ledger moves here and only here: the money has actually left now,
    // which is what it could not be said to have done while PROCESSING.
    await settleRefund(
      refundId,
      snapshot.providerRefundId ?? refund.providerRefundId,
      snapshot.feeMinor,
    );
    return { refundId, status: "SUCCEEDED" };
  }

  if (snapshot.state === "failed") {
    await prisma.refund.update({
      where: { id: refundId },
      data: {
        status: "FAILED",
        failureReason: "provider_reported_failure",
        providerRefundId: snapshot.providerRefundId ?? refund.providerRefundId,
      },
    });
    return { refundId, status: "FAILED" };
  }

  return { refundId, status: "PROCESSING" };
}

export async function settleRefund(
  refundId: string,
  providerRefundId: string | null,
  /**
   * What the provider charged us to send the money back, where it reports one.
   *
   * On a rail with no refund endpoint a refund is an outbound transfer, and an
   * outbound fee is charged on top. So refunding an unsold raffle costs the
   * platform twice: the collection fee it already absorbed at purchase (booked
   * then) plus this one. Both are real costs of a raffle that did not sell.
   */
  feeMinor: number | null = null,
): Promise<void> {
  const refundFee = feeMinor ?? 0;

  await prisma.$transaction(
    async (tx) => {
      const refund = await tx.refund.findUnique({
        where: { id: refundId },
        select: {
          id: true,
          status: true,
          amount: true,
          paymentId: true,
          payment: {
            select: {
              raffleId: true,
              userId: true,
              raffle: { select: { product: { select: { title: true } } } },
            },
          },
        },
      });

      if (!refund || refund.status === "SUCCEEDED") return;

      await tx.refund.update({
        where: { id: refundId },
        data: {
          status: "SUCCEEDED",
          providerRefundId: providerRefundId,
          settledAt: new Date(),
          failureReason: null,
        },
      });

      await tx.ticket.updateMany({
        where: { paymentId: refund.paymentId },
        data: { status: "REFUNDED", refundedAt: new Date() },
      });

      await tx.payment.update({
        where: { id: refund.paymentId },
        data: { status: "REVERSED" },
      });

      await postLedgerTransaction(tx, {
        type: "TICKET_REFUND",
        reference: `ticket-refund:${refundId}`,
        description: "Refund for an unsold raffle",
        legs: [
          {
            account: "TICKET_ESCROW",
            amount: refund.amount,
            raffleId: refund.payment.raffleId,
            paymentId: refund.paymentId,
          },
          ...(refundFee > 0
            ? [
                {
                  account: "PSP_FEES" as const,
                  amount: refundFee,
                  raffleId: refund.payment.raffleId,
                  paymentId: refund.paymentId,
                },
              ]
            : []),
          {
            account: "PLATFORM_CASH",
            amount: -(refund.amount + refundFee),
            raffleId: refund.payment.raffleId,
            paymentId: refund.paymentId,
          },
        ],
      });

      await queueNotification(tx, {
        type: NOTIFICATION_TYPES.RAFFLE_REFUNDED,
        recipientUserId: refund.payment.userId,
        entityType: "Refund",
        entityId: refundId,
        payload: {
          productTitle: refund.payment.raffle?.product.title,
          raffleId: refund.payment.raffleId ?? undefined,
          amountMinor: refund.amount,
        },
      });

      await tx.auditLog.create({
        data: {
          action: "refund.settled",
          entityType: "Refund",
          entityId: refundId,
          metadata: {
            paymentId: refund.paymentId,
            raffleId: refund.payment.raffleId,
            amount: refund.amount,
            providerRefundId,
          },
        },
      });
    },
    { timeout: 20_000, maxWait: 10_000 },
  );

  const refund = await prisma.refund.findUnique({
    where: { id: refundId },
    select: { payment: { select: { raffleId: true } } },
  });

  if (refund?.payment.raffleId) {
    await finaliseRaffleIfFullyRefunded(refund.payment.raffleId);
  }
}

/** Flips a raffle to REFUNDED once nothing is left owing. */
async function finaliseRaffleIfFullyRefunded(raffleId: string): Promise<string> {
  const outstanding = await prisma.payment.count({
    where: {
      raffleId,
      status: "SUCCESS",
      refunds: { none: { status: "SUCCEEDED" } },
    },
  });

  if (outstanding > 0) {
    const current = await prisma.raffle.findUniqueOrThrow({
      where: { id: raffleId },
      select: { status: true },
    });
    return current.status;
  }

  const rows = await prisma.$queryRaw<Array<{ status: string }>>`
    UPDATE "Raffle"
       SET "status" = 'REFUNDED'::"RaffleStatus",
           "updatedAt" = now()
     WHERE "id" = ${raffleId}
       AND "status" IN ('EXPIRED'::"RaffleStatus", 'REFUNDING'::"RaffleStatus", 'CANCELLED'::"RaffleStatus")
     RETURNING "status"
  `;

  if (rows[0]) return rows[0].status;

  const current = await prisma.raffle.findUniqueOrThrow({
    where: { id: raffleId },
    select: { status: true },
  });
  return current.status;
}

/** Retries refunds the provider rejected. Driven by the job runner. */
export async function retryFailedRefunds(limit = 20): Promise<number> {
  const stuck = await prisma.refund.findMany({
    where: { status: "FAILED" },
    select: { payment: { select: { raffleId: true } } },
    take: limit,
  });

  const raffleIds = [
    ...new Set(
      stuck
        .map((refund) => refund.payment.raffleId)
        .filter((id): id is string => id !== null),
    ),
  ];

  for (const raffleId of raffleIds) {
    // Clear the failed marker so refundRaffle picks the payment up again.
    await prisma.refund.deleteMany({
      where: { status: "FAILED", payment: { raffleId } },
    });
    await refundRaffle(raffleId);
  }

  return raffleIds.length;
}
