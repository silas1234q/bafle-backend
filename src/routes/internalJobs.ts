import { timingSafeEqual } from "node:crypto";

import { Router } from "express";
import type { RequestHandler } from "express";

import { env } from "../env.js";
import { queueDepth } from "../jobs/queue.js";
import { runTick } from "../jobs/runner.js";

export const internalJobsRouter = Router();

/**
 * Shared-secret gate for the cron trigger.
 *
 * This endpoint moves money — it drives refunds and payouts — so an open
 * trigger would let anyone force the queue to drain on demand. Compared in
 * constant time, and refused outright when no secret is configured rather than
 * defaulting to open.
 */
const requireTriggerSecret: RequestHandler = (req, res, next) => {
  const configured = env.JOBS_TRIGGER_SECRET;

  if (!configured) {
    res.status(503).json({
      error: "JOBS_TRIGGER_SECRET is not configured; the job trigger is disabled",
    });
    return;
  }

  const header = req.header("x-jobs-secret") ?? "";
  const given = Buffer.from(header, "utf8");
  const expected = Buffer.from(configured, "utf8");

  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    res.status(401).json({ error: "Invalid job trigger secret" });
    return;
  }

  next();
};

internalJobsRouter.use(requireTriggerSecret);

/**
 * One bounded pass of the queue. Driven by external cron, because the free
 * hosting tier spins the process down when idle and an in-process timer would
 * silently stop running.
 *
 * Safe to call more often than needed: sweeps are idempotent and claiming uses
 * SKIP LOCKED, so two overlapping ticks take different jobs.
 */
internalJobsRouter.post("/tick", async (req, res) => {
  const batch = Number(req.query.batch ?? 25);
  const budgetMs = Number(req.query.budgetMs ?? 20_000);

  const result = await runTick({
    batch: Number.isFinite(batch) ? Math.min(Math.max(batch, 1), 200) : 25,
    budgetMs: Number.isFinite(budgetMs)
      ? Math.min(Math.max(budgetMs, 1_000), 50_000)
      : 20_000,
  });

  res.json(result);
});

/** Backlog visibility, so a stuck queue is noticed before users notice. */
internalJobsRouter.get("/status", async (_req, res) => {
  res.json(await queueDepth());
});
