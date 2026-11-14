import type { RequestHandler } from "express";

import { env } from "../env.js";

/**
 * One line per request, written when the response finishes.
 *
 * Hand-rolled rather than `morgan`, for two reasons: it avoids a dependency
 * for ~40 lines of work, and it can see things morgan cannot — the resolved
 * local user id (morgan only knows Clerk's bearer token, which is useless in
 * a log) and whether the response was a server fault worth sending to stderr.
 *
 * Written on `finish`, not on arrival, because the status and duration are the
 * parts worth having. A request that never finishes is still visible: it is
 * the one that produced no line.
 *
 * NEVER log headers or bodies here. Authorization carries a live session
 * token, and the Paystack and Clerk webhook bodies carry customer details.
 */

// Built from a char code rather than written as a literal escape, so no
// invisible control byte ever lands in this file — they survive neither
// grep nor a careless copy-paste.
const ESC = String.fromCharCode(27);
const RESET = `${ESC}[0m`;
const DIM = `${ESC}[2m`;
const BOLD = `${ESC}[1m`;

function statusColour(status: number): string {
  if (status >= 500) return `${ESC}[31m`; // red
  if (status >= 400) return `${ESC}[33m`; // yellow
  if (status >= 300) return `${ESC}[36m`; // cyan
  return `${ESC}[32m`; // green
}

/**
 * Colour is suppressed when stdout is not a terminal, so piping to a file or
 * to a hosting provider's log collector does not fill it with escape codes.
 */
const useColour = process.stdout.isTTY === true && !env.IS_PRODUCTION;

function paint(value: string, colour: string): string {
  return useColour ? `${colour}${value}${RESET}` : value;
}

/** Sub-millisecond requests are common locally; µs keeps them meaningful. */
function formatDuration(nanoseconds: bigint): string {
  const microseconds = Number(nanoseconds / 1000n);
  if (microseconds < 1000) return `${microseconds}us`;

  const milliseconds = microseconds / 1000;
  return milliseconds < 100
    ? `${milliseconds.toFixed(1)}ms`
    : `${Math.round(milliseconds)}ms`;
}

export const requestLog: RequestHandler = (req, res, next) => {
  const startedAt = process.hrtime.bigint();

  res.on("finish", () => {
    // An uptime probe hits /health on a schedule forever. Worth seeing while
    // developing, pure noise in production — but a FAILING probe is logged
    // either way, since that is the line anyone would actually be looking for.
    if (env.IS_PRODUCTION && req.path === "/health" && res.statusCode < 400) {
      return;
    }

    const duration = formatDuration(process.hrtime.bigint() - startedAt);
    const status = paint(
      String(res.statusCode),
      statusColour(res.statusCode) + BOLD,
    );

    // Present only once `requireUser` has run, which is exactly when knowing
    // who made the call is useful. Truncated — the full uuid is noise, and
    // eight characters is plenty to correlate against the database.
    const actor = req.localUser?.id;
    const who = actor ? paint(` user=${actor.slice(0, 8)}`, DIM) : "";

    // Padded to 7 — the width of OPTIONS, the longest method in use here.
    // Any narrower and preflights run straight into the path: "OPTIONS/me".
    const method = req.method.padEnd(7);

    const line = `${method} ${req.originalUrl} ${status} ${paint(duration, DIM)}${who}`;

    // stderr for server faults, so `npm run dev > out.log` still surfaces them.
    if (res.statusCode >= 500) console.error(line);
    else console.log(line);
  });

  next();
};
