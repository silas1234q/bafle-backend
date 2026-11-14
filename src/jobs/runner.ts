import { JOB_HANDLERS, runSweeps, type SweepResult } from "./handlers.js";
import {
  claimJobs,
  completeJob,
  failJob,
  queueDepth,
  reclaimStuckJobs,
  type QueueDepth,
} from "./queue.js";

export interface TickResult {
  reclaimed: number;
  sweeps: SweepResult;
  processed: number;
  succeeded: number;
  failed: number;
  retrying: number;
  skipped: number;
  depth: QueueDepth;
  budgetExhausted: boolean;
}

/** Stops claiming new work once this much of the tick is spent. */
const DEFAULT_BUDGET_MS = 20_000;
const DEFAULT_BATCH = 25;

/**
 * One pass of the queue: reclaim, sweep, drain.
 *
 * Deliberately bounded in both count and wall-clock time. The trigger is an
 * HTTP request from an external cron, so a tick that ran until the backlog was
 * empty would eventually exceed the request timeout and be reported as a
 * failure even though it was making progress. Leftover work is simply picked
 * up by the next tick.
 */
export async function runTick(
  options: { batch?: number; budgetMs?: number } = {},
): Promise<TickResult> {
  const batch = options.batch ?? DEFAULT_BATCH;
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const deadline = Date.now() + budgetMs;

  const reclaimed = await reclaimStuckJobs();
  const sweeps = await runSweeps(batch);

  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let retrying = 0;
  let skipped = 0;
  let budgetExhausted = false;

  while (processed < batch) {
    if (Date.now() >= deadline) {
      budgetExhausted = true;
      break;
    }

    // Claim a few at a time rather than the whole batch, so a slow job does
    // not hold a large claim while the budget runs out.
    const claimed = await claimJobs(Math.min(5, batch - processed));
    if (claimed.length === 0) break;

    for (const job of claimed) {
      processed++;

      const handler = JOB_HANDLERS[job.type];
      if (!handler) {
        // Unknown type: fail it rather than leaving it claimed forever. A
        // renamed handler should be visible, not silently stuck.
        await failJob(job.id, new Error(`No handler registered for "${job.type}"`));
        skipped++;
        continue;
      }

      try {
        const result = await handler(job.payload);
        await completeJob(job.id, result as never);
        succeeded++;
      } catch (error) {
        const outcome = await failJob(job.id, error);
        if (outcome === "FAILED") failed++;
        else retrying++;
      }
    }
  }

  return {
    reclaimed,
    sweeps,
    processed,
    succeeded,
    failed,
    retrying,
    skipped,
    depth: await queueDepth(),
    budgetExhausted,
  };
}
