/**
 * Runs the job queue once, the way the production cron does.
 *
 * `npm run jobs:tick`
 *
 * There is no in-process timer by design — the free hosting tier spins the
 * process down when idle — so in production an external cron must POST to
 * `/internal/jobs/tick`. Locally nothing does, which means notifications sit
 * PENDING and, since the draw became a scheduled job, a sold-out raffle waits
 * at SOLD_OUT until something ticks. This is that something.
 *
 * Reads PORT and JOBS_TRIGGER_SECRET from the same .env the server uses, so
 * it cannot drift from the running instance's config.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

function readEnvFile(): Map<string, string> {
  const values = new Map<string, string>();
  let raw: string;

  try {
    raw = readFileSync(join(here, "..", ".env"), "utf8");
  } catch {
    return values;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    // Quotes stripped, nothing else: this is not a full dotenv parser, just
    // enough to read two values the server already validated at boot.
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    values.set(key, value);
  }

  return values;
}

const fromFile = readEnvFile();
const secret = process.env.JOBS_TRIGGER_SECRET ?? fromFile.get("JOBS_TRIGGER_SECRET");
const port = process.env.PORT ?? fromFile.get("PORT") ?? "3000";

if (!secret) {
  console.error(
    "JOBS_TRIGGER_SECRET is not set. The tick endpoint refuses every request without it, so there is nothing to call.",
  );
  process.exit(1);
}

const url = `http://127.0.0.1:${port}/internal/jobs/tick`;

// The tick runs inside the *server* process, which read its .env at boot and
// never re-reads it. So editing EMAIL_PROVIDER and ticking without restarting
// sends every queued notification through whatever driver the server still
// holds — and on "console" that prints them and marks them SENT, which the
// permanent Notification dedupe makes final. That exact sequence destroyed a
// real notification on 2026-11-12. Compare the two before doing any work.
const fileProvider = fromFile.get("EMAIL_PROVIDER") ?? "console";
let emailBlocker: string[] | null = null;

try {
  const health = await fetch(`http://127.0.0.1:${port}/health`, {
    signal: AbortSignal.timeout(5000),
  });
  const body = (await health.json()) as { email?: { provider?: string; delivers?: boolean } };
  const live = body.email?.provider;

  if (live && live !== fileProvider) {
    emailBlocker = [
      `The running server is using EMAIL_PROVIDER="${live}" but .env says "${fileProvider}".`,
      "It has not picked up your change -- restart the dev server before ticking.",
      "",
      "Ticking now would send every queued notification through the stale driver,",
      "and a notification marked SENT can never be delivered again.",
    ];
  } else if (body.email?.delivers === false) {
    emailBlocker = [
      `The running server's email driver ("${live}") does not deliver.`,
      "Every notification this tick processes will be marked SENT without",
      "reaching anyone, permanently. Configure a real provider first, and",
      "prove it with: npm run email:test -- you@example.com",
    ];
  }
} catch {
  // A server that cannot answer /health cannot answer the tick either; let the
  // POST below produce the clearer error rather than guessing here.
}

// Exits outside the fetch scope: calling process.exit() with the response
// still in flight trips a libuv assertion on Windows and buries the message.
if (emailBlocker) {
  console.error(emailBlocker.join(String.fromCharCode(10)));
  // exitCode rather than exit(): the /health response above leaves a keep-alive
  // socket open, and exiting on top of it trips a libuv assertion on Windows
  // that buries the message this guard exists to show.
  process.exitCode = 1;
}

let response: Response | null = null;
if (!emailBlocker) {
  try {
    response = await fetch(url, {
      method: "POST",
      // `x-jobs-secret`, not Authorization: the endpoint compares this header
      // in constant time and knows nothing about bearer tokens.
      headers: { "x-jobs-secret": secret },
    });
  } catch (error) {
    console.error(`Could not reach ${url} — is the dev server running?`);
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }

  const body = (await response.json().catch(() => null)) as unknown;

  if (!response.ok) {
    console.error(`Tick failed: ${response.status}`);
    console.error(body);
    process.exit(1);
  }

  console.log(JSON.stringify(body, null, 2));
}
