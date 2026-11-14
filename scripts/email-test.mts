/**
 * Sends one throwaway email straight through the SMTP driver.
 *
 * `npm run email:test -- you@example.com`   (defaults to SMTP_USER)
 *
 * This exists because of a trap in the notification layer: the unique
 * `Notification (type, entityId, recipientUserId)` row is a *permanent*
 * dedupe, so you cannot use a real queued notification to test the email
 * config. A send attempt either marks the row SENT — burning the only chance
 * to ever deliver it for real — or FAILED. There are currently real
 * `raffle.won` notifications parked in the queue, so that matters.
 *
 * So this touches no Notification row, no Job row and no database at all.
 *
 * It also deliberately bypasses `EMAIL_PROVIDER` and `emailProvider()`: the
 * whole point is to prove the credentials work *before* flipping the provider
 * over, and going through the factory while it still says "console" would
 * print to stdout and prove nothing.
 */
import "dotenv/config";
import { SmtpProvider } from "../src/notifications/smtp.js";

const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASS;

if (!user || !pass) {
  console.error(
    "SMTP_USER and SMTP_PASS must both be set in .env.\n" +
      "SMTP_PASS is a 16-character Google App Password (account Security >\n" +
      "2-Step Verification > App passwords), not the account password.",
  );
  process.exit(1);
}

const to = process.argv[2] ?? user;
const host = process.env.SMTP_HOST ?? null;
const port = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : null;
const fromEmail = process.env.EMAIL_FROM || null;

const provider = new SmtpProvider({
  user,
  pass,
  host,
  port,
  fromEmail,
  fromName: process.env.EMAIL_FROM_NAME ?? null,
});

const stamp = new Date().toISOString();

console.log(`Sending via ${host ?? "smtp.gmail.com"}:${port ?? 465} as ${fromEmail ?? user} -> ${to}`);

try {
  const result = await provider.send({
    to,
    subject: `Bafle email test ${stamp}`,
    text:
      `This is a test from Bafle's SMTP driver.\n\n` +
      `Sent at ${stamp}. Nothing was recorded in the database — if this ` +
      `arrived, the credentials work and EMAIL_PROVIDER=smtp is safe to turn on.\n`,
    html:
      `<p>This is a test from Bafle's SMTP driver.</p>` +
      `<p>Sent at <code>${stamp}</code>. Nothing was recorded in the database — ` +
      `if this arrived, the credentials work and <code>EMAIL_PROVIDER=smtp</code> ` +
      `is safe to turn on.</p>`,
  });

  console.log(`Accepted. messageId=${result.providerMessageId ?? "(none returned)"}`);
  console.log("Check the inbox before flipping EMAIL_PROVIDER and running jobs:tick.");
} catch (error) {
  const err = error as { message?: string; retryable?: boolean; status?: number | null };
  console.error(`Send failed: ${err.message ?? String(error)}`);
  if (err.status != null) console.error(`SMTP response code: ${err.status}`);
  console.error(`Classified as ${err.retryable ? "retryable" : "permanent"}.`);
  if (!err.retryable) {
    // Permanent means retrying changes nothing, so the fix is in the relay's
    // own settings. Which one depends on how far the session got: an auth
    // failure dies before any SMTP code, so a code here means the credentials
    // were already accepted and the account rejected the send.
    console.error(
      [
        "Permanent means retrying will not help. Common causes:",
        "  535 / EAUTH  wrong SMTP key or App Password",
        "  525          the relay does not allow this IP (Brevo: SMTP & API >",
        "               Authorized IPs). Auth already succeeded if you see this.",
        "  5xx sender   EMAIL_FROM is not a sender this relay has verified",
      ].join(String.fromCharCode(10)),
    );
  }
  process.exit(1);
}
