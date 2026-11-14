import { prisma } from "../lib/prisma.js";
import { executeDraw, notifyDrawScheduled } from "../services/draw.js";
import {
  findOrdersDueForRelease,
  reconcilePayout,
  releaseEscrow,
  sendPayout,
} from "../services/payouts.js";
import {
  expireOverdueRaffles,
  reconcileRefund,
  refundRaffle,
} from "../services/refunds.js";
import {
  NOTIFICATION_JOB_TYPE,
  sendNotification,
} from "../services/notifications.js";
import { releaseExpiredReservations } from "../services/tickets.js";
import { enqueueJob } from "./queue.js";

/**
 * Job types and their handlers.
 *
 * Discovery is separated from work: sweeps find things that need doing and
 * enqueue one job per item. That matters because a sweep covering forty
 * refunds in a loop fails as a unit, whereas forty jobs retry independently
 * and one bad payment cannot stall the other thirty-nine.
 */

export const JOB_TYPES = {
  /** The draw itself, scheduled DRAW_DELAY_MS after the raffle sells out. */
  RAFFLE_DRAW: "raffle.draw",
  /** Tells entrants the draw is imminent. Runs immediately on sellout. */
  RAFFLE_DRAW_NOTIFY: "raffle.draw.notify",
  RAFFLE_REFUND: "raffle.refund",
  ORDER_RELEASE: "order.release",
  PAYOUT_SEND: "payout.send",
  /**
   * Asks the provider what became of a transfer already in flight.
   *
   * Separate from PAYOUT_SEND because the two must never be confused: sending
   * again could pay a seller twice, while asking is free. A rail that reports
   * a transfer as processing and sends no webhook for its completion leaves
   * this as the only thing that can ever settle the row.
   */
  PAYOUT_STATUS_CHECK: "payout.status.check",
  REFUND_STATUS_CHECK: "refund.status.check",
  NOTIFICATION_SEND: NOTIFICATION_JOB_TYPE,
} as const;

export type JobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES];

type JobHandler = (payload: unknown) => Promise<Record<string, unknown>>;

function requireString(payload: unknown, key: string): string {
  const value =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)[key]
      : undefined;

  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Job payload is missing "${key}"`);
  }
  return value;
}

export const JOB_HANDLERS: Record<string, JobHandler> = {
  [JOB_TYPES.NOTIFICATION_SEND]: async (payload) => {
    const notificationId = requireString(payload, "notificationId");
    const result = await sendNotification(notificationId);
    // Mapped rather than returned directly: JobHandler promises a plain
    // record, and a typed interface has no index signature.
    return { status: result.status, reason: result.reason ?? null };
  },

  [JOB_TYPES.RAFFLE_DRAW]: async (payload) => {
    const raffleId = requireString(payload, "raffleId");

    // A draw that is no longer eligible is not a failure. The raffle may have
    // been drawn already by the sweep's copy of this job, or cancelled; both
    // are normal and must not retry forever.
    const raffle = await prisma.raffle.findUnique({
      where: { id: raffleId },
      select: { status: true },
    });

    if (!raffle) return { raffleId, drawn: false, reason: "raffle_missing" };
    if (raffle.status === "DRAWN" || raffle.status === "COMPLETED") {
      return { raffleId, drawn: false, reason: "already_drawn" };
    }
    if (raffle.status !== "SOLD_OUT") {
      return { raffleId, drawn: false, reason: `status_${raffle.status}` };
    }

    const draw = await executeDraw(raffleId);
    return { raffleId, drawn: true, drawId: draw.id };
  },

  [JOB_TYPES.RAFFLE_DRAW_NOTIFY]: async (payload) => {
    const raffleId = requireString(payload, "raffleId");
    const queued = await notifyDrawScheduled(raffleId);
    return { raffleId, notified: queued };
  },

  [JOB_TYPES.RAFFLE_REFUND]: async (payload) => {
    const raffleId = requireString(payload, "raffleId");
    const result = await refundRaffle(raffleId);

    // Anything still owing means the provider has not settled yet. Re-queued
    // with a delay rather than retried immediately, since the wait is on
    // Paystack's settlement clock, not on us.
    if (result.remaining > 0) {
      await enqueueJob(prisma, {
        type: JOB_TYPES.RAFFLE_REFUND,
        payload: { raffleId },
        dedupeKey: `${JOB_TYPES.RAFFLE_REFUND}:${raffleId}`,
        runAt: new Date(Date.now() + 60 * 60_000),
      });
    }

    return { ...result };
  },

  [JOB_TYPES.ORDER_RELEASE]: async (payload) => {
    const orderId = requireString(payload, "orderId");
    const release = await releaseEscrow(orderId, "auto_release");

    // The transfer is a separate job: the accrual has already happened and
    // must not be rolled back just because a disbursement is blocked.
    await enqueueJob(prisma, {
      type: JOB_TYPES.PAYOUT_SEND,
      payload: { payoutId: release.payoutId },
      dedupeKey: `${JOB_TYPES.PAYOUT_SEND}:${release.payoutId}`,
    });

    return { orderId, netAmount: release.netAmount, payoutId: release.payoutId };
  },

  [JOB_TYPES.PAYOUT_SEND]: async (payload) => {
    const payoutId = requireString(payload, "payoutId");
    const result = await sendPayout(payoutId);

    // A blocked payout (unverified seller, no recipient on file) is not a
    // failure to retry in seconds — it needs the seller to act. Checked again
    // in six hours.
    if (result.status === "PENDING") {
      await enqueueJob(prisma, {
        type: JOB_TYPES.PAYOUT_SEND,
        payload: { payoutId },
        dedupeKey: `${JOB_TYPES.PAYOUT_SEND}:${payoutId}`,
        runAt: new Date(Date.now() + 6 * 60 * 60_000),
      });
    }

    // A hard FAILED is thrown so the queue applies its own backoff and the
    // attempt count is visible.
    if (result.status === "FAILED") {
      throw new Error(`Payout failed: ${result.failureReason ?? "unknown"}`);
    }

    return { payoutId, status: result.status };
  },

  [JOB_TYPES.PAYOUT_STATUS_CHECK]: async (payload) => {
    const payoutId = requireString(payload, "payoutId");
    const result = await reconcilePayout(payoutId);

    // Still in flight: ask again later rather than throwing. A throw would
    // burn the attempt counter on a payout that is behaving perfectly
    // normally, and eventually bury it under a retry limit.
    if (result.status === "PROCESSING") {
      await enqueueJob(prisma, {
        type: JOB_TYPES.PAYOUT_STATUS_CHECK,
        payload: { payoutId },
        dedupeKey: `${JOB_TYPES.PAYOUT_STATUS_CHECK}:${payoutId}`,
        runAt: new Date(Date.now() + 15 * 60_000),
      });
    }

    return { payoutId, status: result.status };
  },

  [JOB_TYPES.REFUND_STATUS_CHECK]: async (payload) => {
    const refundId = requireString(payload, "refundId");
    const result = await reconcileRefund(refundId);

    if (result.status === "PROCESSING") {
      await enqueueJob(prisma, {
        type: JOB_TYPES.REFUND_STATUS_CHECK,
        payload: { refundId },
        dedupeKey: `${JOB_TYPES.REFUND_STATUS_CHECK}:${refundId}`,
        runAt: new Date(Date.now() + 15 * 60_000),
      });
    }

    return { refundId, status: result.status };
  },
};

export interface SweepResult {
  reservationsReleased: number;
  rafflesExpired: number;
  drawJobsQueued: number;
  refundJobsQueued: number;
  releaseJobsQueued: number;
  payoutJobsQueued: number;
  payoutChecksQueued: number;
  refundChecksQueued: number;
}

/**
 * Finds work and queues it. Cheap, idempotent, and safe to run on every tick.
 */
export async function runSweeps(limit = 25): Promise<SweepResult> {
  // Done inline: it is a single bounded delete, and nothing downstream depends
  // on it having its own retry.
  const reservationsReleased = await releaseExpiredReservations();

  // Draws whose scheduled moment has arrived. The sellout already enqueued a
  // `raffle.draw` job, so this is purely the safety net: without it, a job
  // lost to a failed enqueue or a wiped queue would leave a sold-out raffle
  // with no winner and no way to get one. The dedupe key makes a duplicate
  // here free.
  const dueDraws = await prisma.raffle.findMany({
    where: {
      status: "SOLD_OUT",
      drawAt: { lte: new Date() },
      draw: { is: null },
    },
    select: { id: true },
    orderBy: { drawAt: "asc" },
    take: limit,
  });

  let drawJobsQueued = 0;
  for (const raffle of dueDraws) {
    const queued = await enqueueJob(prisma, {
      type: JOB_TYPES.RAFFLE_DRAW,
      payload: { raffleId: raffle.id },
      dedupeKey: `${JOB_TYPES.RAFFLE_DRAW}:${raffle.id}`,
    });
    if (queued) drawJobsQueued++;
  }

  const expired = await expireOverdueRaffles(limit);
  let refundJobsQueued = 0;
  for (const raffleId of expired) {
    const queued = await enqueueJob(prisma, {
      type: JOB_TYPES.RAFFLE_REFUND,
      payload: { raffleId },
      dedupeKey: `${JOB_TYPES.RAFFLE_REFUND}:${raffleId}`,
    });
    if (queued) refundJobsQueued++;
  }

  const dueOrders = await findOrdersDueForRelease(limit);
  let releaseJobsQueued = 0;
  for (const orderId of dueOrders) {
    const queued = await enqueueJob(prisma, {
      type: JOB_TYPES.ORDER_RELEASE,
      payload: { orderId },
      dedupeKey: `${JOB_TYPES.ORDER_RELEASE}:${orderId}`,
    });
    if (queued) releaseJobsQueued++;
  }

  // Payouts that never went out. PROCESSING is excluded: those are waiting on
  // a provider webhook, and re-sending would risk a duplicate transfer.
  const stuckPayouts = await prisma.payout.findMany({
    where: { status: { in: ["PENDING", "FAILED"] } },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  let payoutJobsQueued = 0;
  for (const payout of stuckPayouts) {
    const queued = await enqueueJob(prisma, {
      type: JOB_TYPES.PAYOUT_SEND,
      payload: { payoutId: payout.id },
      dedupeKey: `${JOB_TYPES.PAYOUT_SEND}:${payout.id}`,
    });
    if (queued) payoutJobsQueued++;
  }

  // Transfers already in flight. Asked about, never re-sent — the queries
  // above deliberately exclude PROCESSING for exactly that reason, and this is
  // the other half of that decision: without it, a rail whose transfers settle
  // asynchronously and which sends no transfer webhook leaves every PROCESSING
  // row stranded forever.
  //
  // The grace period keeps a transfer that is merely seconds old from being
  // polled before the provider has had a chance to finish it.
  const inFlightSince = new Date(Date.now() - 2 * 60_000);

  const inFlightPayouts = await prisma.payout.findMany({
    where: { status: "PROCESSING", updatedAt: { lte: inFlightSince } },
    select: { id: true },
    orderBy: { updatedAt: "asc" },
    take: limit,
  });

  let payoutChecksQueued = 0;
  for (const payout of inFlightPayouts) {
    const queued = await enqueueJob(prisma, {
      type: JOB_TYPES.PAYOUT_STATUS_CHECK,
      payload: { payoutId: payout.id },
      dedupeKey: `${JOB_TYPES.PAYOUT_STATUS_CHECK}:${payout.id}`,
    });
    if (queued) payoutChecksQueued++;
  }

  const inFlightRefunds = await prisma.refund.findMany({
    where: { status: "PROCESSING", updatedAt: { lte: inFlightSince } },
    select: { id: true },
    orderBy: { updatedAt: "asc" },
    take: limit,
  });

  let refundChecksQueued = 0;
  for (const refund of inFlightRefunds) {
    const queued = await enqueueJob(prisma, {
      type: JOB_TYPES.REFUND_STATUS_CHECK,
      payload: { refundId: refund.id },
      dedupeKey: `${JOB_TYPES.REFUND_STATUS_CHECK}:${refund.id}`,
    });
    if (queued) refundChecksQueued++;
  }

  return {
    reservationsReleased,
    rafflesExpired: expired.length,
    drawJobsQueued,
    refundJobsQueued,
    releaseJobsQueued,
    payoutJobsQueued,
    payoutChecksQueued,
    refundChecksQueued,
  };
}
