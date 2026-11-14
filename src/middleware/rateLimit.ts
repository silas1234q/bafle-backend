import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request } from "express";

/**
 * Rate limits.
 *
 * Keyed on the authenticated user where there is one, falling back to IP.
 * Keying purely on IP would let one account abuse a shared connection on
 * everyone else's behalf, and would also lump an entire mobile carrier NAT
 * into a single bucket.
 *
 * CAVEAT: the default store is in-process memory. On a single instance that is
 * fine, but counters reset when the process restarts or the free tier spins it
 * down, and two instances would each keep their own counts. The durable limits
 * that actually protect money are in the database — delivery-code attempts on
 * Order, and the unique constraints that make replays no-ops.
 */

function userOrIp(req: Request): string {
  const userId = req.localUser?.id;
  if (userId) return `user:${userId}`;
  // ipKeyGenerator normalises IPv6 so a /64 cannot trivially rotate addresses.
  return `ip:${ipKeyGenerator(req.ip ?? "unknown")}`;
}

const shared = {
  standardHeaders: "draft-8" as const,
  legacyHeaders: false,
  keyGenerator: userOrIp,
};

/** Blunt instrument across the whole API. */
export const globalLimiter = rateLimit({
  ...shared,
  windowMs: 60_000,
  limit: 300,
  message: { error: "Too many requests; slow down" },
});

/**
 * Ticket purchase. Deliberately tight: each call reserves ticket numbers and
 * opens a provider checkout, so a loop here both costs money and can make a
 * raffle look sold out while nothing is paid.
 */
export const purchaseLimiter = rateLimit({
  ...shared,
  windowMs: 60_000,
  limit: 10,
  message: { error: "Too many ticket purchases; wait a minute and try again" },
});

/** Handle changes. Cheap to serve, but a rename loop is a nuisance vector. */
export const usernameLimiter = rateLimit({
  ...shared,
  windowMs: 60 * 60_000,
  limit: 5,
  message: { error: "Too many username changes; try again later" },
});

/**
 * Delivery codes. The durable guard is the attempt counter on Order; this
 * stops someone grinding through fresh codes to widen their budget.
 */
export const deliveryCodeLimiter = rateLimit({
  ...shared,
  windowMs: 15 * 60_000,
  limit: 15,
  message: { error: "Too many delivery code attempts; try again shortly" },
});

/**
 * Payout destination setup. Every accepted call creates a recipient at the
 * payment provider, so this is one of the few routes where our own rate limit
 * protects someone else's API as much as ours.
 */
export const payoutSetupLimiter = rateLimit({
  ...shared,
  windowMs: 60 * 60_000,
  limit: 10,
  message: { error: "Too many payout detail changes; try again later" },
});

/** Writes that create reviewable records a human has to read. */
export const contentLimiter = rateLimit({
  ...shared,
  windowMs: 60 * 60_000,
  limit: 30,
  message: { error: "Too many submissions; try again later" },
});
