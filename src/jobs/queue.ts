import { randomBytes } from "node:crypto";

import { prisma } from "../lib/prisma.js";
import { Prisma, type Job, type JobStatus } from "../generated/prisma/client.js";

/**
 * Postgres-backed job queue.
 *
 * Claiming uses `FOR UPDATE SKIP LOCKED`, which is Postgres' built-in queue
 * primitive: two workers can never take the same row, and a busy row is
 * skipped rather than waited on. This is the same mechanism pg-boss,
 * graphile-worker, Oban and River all use — nothing here is invented.
 *
 * The reason for a database queue rather than Redis is transactional enqueue:
 * `enqueueJob` takes the caller's transaction, so scheduling a refund commits
 * atomically with marking the raffle expired. With an external broker there is
 * always a window where the database commits and the enqueue fails, and the
 * refund is simply lost.
 */

/** Identifies which process holds a lock, so stuck jobs are attributable. */
export const WORKER_ID = `${process.pid}-${randomBytes(3).toString("hex")}`;

/** A RUNNING job untouched for this long is assumed dead and reclaimed. */
const STUCK_AFTER_MS = 5 * 60_000;

export interface EnqueueOptions {
  type: string;
  payload?: Prisma.InputJsonValue;
  /** Defaults to now. */
  runAt?: Date;
  /**
   * Blocks a duplicate while one is outstanding. Cleared on completion, so
   * the same work can legitimately be scheduled again later.
   */
  dedupeKey?: string;
  maxAttempts?: number;
}

type Tx = Prisma.TransactionClient;

/**
 * Schedules a job. Pass the caller's transaction to make scheduling atomic
 * with whatever state change justifies it.
 *
 * Returns null when a matching job is already outstanding.
 */
export async function enqueueJob(
  tx: Tx | typeof prisma,
  options: EnqueueOptions,
): Promise<string | null> {
  // Quiet fast path. The catch below still handles genuine races, but without
  // this every deduped enqueue logs a constraint violation at error level and
  // looks like a fault in the logs when it is the mechanism working.
  if (options.dedupeKey) {
    const outstanding = await tx.job.findUnique({
      where: { dedupeKey: options.dedupeKey },
      select: { id: true },
    });
    if (outstanding) return null;
  }

  try {
    const job = await tx.job.create({
      data: {
        type: options.type,
        payload: options.payload,
        runAt: options.runAt ?? new Date(),
        dedupeKey: options.dedupeKey ?? null,
        maxAttempts: options.maxAttempts ?? 5,
      },
      select: { id: true },
    });
    return job.id;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      // Already queued. Not an error: this is the dedupe key doing its job.
      return null;
    }
    throw error;
  }
}

/**
 * Returns RUNNING jobs whose worker died back to PENDING.
 *
 * Without this a crash mid-job would leave work permanently locked. Attempts
 * are not reset, so a job that reliably kills its worker still exhausts its
 * budget instead of looping forever.
 */
export async function reclaimStuckJobs(): Promise<number> {
  const cutoff = new Date(Date.now() - STUCK_AFTER_MS);

  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE "Job"
       SET "status" = 'PENDING'::"JobStatus",
           "lockedAt" = NULL,
           "lockedBy" = NULL,
           "lastError" = COALESCE("lastError", 'reclaimed: worker did not finish'),
           "updatedAt" = now()
     WHERE "status" = 'RUNNING'::"JobStatus"
       AND "lockedAt" < ${cutoff}
    RETURNING "id"
  `;

  return rows.length;
}

/**
 * Atomically claims up to `limit` due jobs.
 *
 * Done in two statements inside one transaction rather than as a single
 * `UPDATE ... WHERE id IN (SELECT ... LIMIT n)`. The combined form was
 * observed intermittently returning every pending row instead of `n` — 40
 * distinct rows for a limit of 5 — even though the same SQL run directly
 * against Postgres honoured the limit every time. Rather than rely on a
 * construct that misbehaved under load, the id list is now selected, capped in
 * application code, and then updated by explicit id. Over-claiming is
 * structurally impossible here: the UPDATE can only touch ids we pass it.
 *
 * The transaction matters too — the SELECT's row locks must still be held when
 * the UPDATE runs, or a second worker could claim the same rows in between.
 */
export async function claimJobs(limit: number): Promise<Job[]> {
  // Postgres treats `LIMIT NULL` as NO LIMIT, and Prisma binds NaN or
  // undefined as NULL. Validated rather than coerced, so a miscomputed limit
  // surfaces at the call site instead of as mysterious load.
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(
      `claimJobs limit must be a positive integer, got ${String(limit)}`,
    );
  }
  const safeLimit = Math.min(limit, 500);

  return prisma.$transaction(
    async (tx) => {
      const candidates = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
          FROM "Job"
         WHERE "status" = 'PENDING'::"JobStatus"
           AND "runAt" <= now()
         ORDER BY "runAt"
         LIMIT ${safeLimit}
           FOR UPDATE SKIP LOCKED
      `;

      // Belt and braces: the cap is enforced here, in JS, where it cannot be
      // affected by planner or driver behaviour.
      const ids = candidates.slice(0, safeLimit).map((row) => row.id);
      if (ids.length === 0) return [];

      return tx.$queryRaw<Job[]>`
        UPDATE "Job"
           SET "status" = 'RUNNING'::"JobStatus",
               "lockedAt" = now(),
               "lockedBy" = ${WORKER_ID},
               "attempts" = "attempts" + 1,
               "updatedAt" = now()
         WHERE "id" = ANY(${ids}::text[])
        RETURNING *
      `;
    },
    { timeout: 15_000, maxWait: 10_000 },
  );
}

/** Exponential backoff, capped. 10s, 40s, 90s, 160s, 250s. */
function backoffMs(attempts: number): number {
  return Math.min(10_000 * attempts * attempts, 300_000);
}

export async function completeJob(
  jobId: string,
  result?: Prisma.InputJsonValue,
): Promise<void> {
  await prisma.job.update({
    where: { id: jobId },
    data: {
      status: "SUCCEEDED",
      completedAt: new Date(),
      lockedAt: null,
      lockedBy: null,
      lastError: null,
      // Freed so the same logical work can be scheduled again in future.
      dedupeKey: null,
      ...(result === undefined ? {} : { payload: result }),
    },
  });
}

/**
 * Records a failure and either reschedules with backoff or gives up.
 *
 * A job that exhausts its attempts goes to FAILED and stays there: for money
 * operations, retrying forever is worse than stopping and being visible.
 */
export async function failJob(jobId: string, error: unknown): Promise<JobStatus> {
  const message = error instanceof Error ? error.message : String(error);

  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { attempts: true, maxAttempts: true },
  });

  if (!job) return "FAILED";

  const exhausted = job.attempts >= job.maxAttempts;

  await prisma.job.update({
    where: { id: jobId },
    data: exhausted
      ? {
          status: "FAILED",
          completedAt: new Date(),
          lockedAt: null,
          lockedBy: null,
          lastError: message.slice(0, 2_000),
          dedupeKey: null,
        }
      : {
          status: "PENDING",
          runAt: new Date(Date.now() + backoffMs(job.attempts)),
          lockedAt: null,
          lockedBy: null,
          lastError: message.slice(0, 2_000),
        },
  });

  return exhausted ? "FAILED" : "PENDING";
}

export interface QueueDepth {
  pending: number;
  running: number;
  failed: number;
  dueNow: number;
}

/** For /health and for noticing a stuck backlog before users do. */
export async function queueDepth(): Promise<QueueDepth> {
  const [pending, running, failed, dueNow] = await Promise.all([
    prisma.job.count({ where: { status: "PENDING" } }),
    prisma.job.count({ where: { status: "RUNNING" } }),
    prisma.job.count({ where: { status: "FAILED" } }),
    prisma.job.count({ where: { status: "PENDING", runAt: { lte: new Date() } } }),
  ]);

  return { pending, running, failed, dueNow };
}
