/**
 * Sets the Moolre wallet's callback URL and prints the webhook secret.
 *
 * The secret is not something you choose and not something you can read back:
 * Moolre generates it as a UUID tied to the wallet, and returns it only from
 * `/open/account/create` and `/open/account/update`. `/open/account/status`
 * deliberately returns the callback URL without it. So the only way to learn
 * the secret on an existing wallet is to write the callback URL — which is a
 * call you need to make anyway to point events at this API.
 *
 * Reads credentials straight from process.env rather than going through
 * `env.ts` and `paymentProvider()`, for the same reason `email-test.mts` does:
 * the point is to prove and configure credentials *before* flipping
 * PAYMENT_PROVIDER, and the factory would refuse to build while it still says
 * paystack.
 *
 *   npm run moolre:callback -- https://your-tunnel.example.com/webhooks/payments
 *
 * Pass no URL to read the current configuration without changing anything.
 *
 * NOTE: the docs do not say whether updating rotates the secret or returns the
 * existing one. Treat a re-run as potentially rotating it — harmless during
 * first-time setup, but on a live wallet it would invalidate the value in
 * .env until you paste the new one, and every callback would be refused in the
 * meantime.
 */
import "dotenv/config";

const baseUrl = process.env.MOOLRE_BASE_URL ?? "https://api.moolre.com";
const apiUser = process.env.MOOLRE_API_USER;
const apiKey = process.env.MOOLRE_API_KEY;
const accountNumber = process.env.MOOLRE_ACCOUNT_NUMBER;

const missing = Object.entries({
  MOOLRE_API_USER: apiUser,
  MOOLRE_API_KEY: apiKey,
  MOOLRE_ACCOUNT_NUMBER: accountNumber,
})
  .filter(([, value]) => !value)
  .map(([name]) => name);

if (missing.length > 0) {
  console.error(`Missing ${missing.join(", ")} in backend/.env`);
  process.exit(1);
}

const callbackUrl = process.argv[2] ?? null;

async function call(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "X-API-USER": String(apiUser),
      "X-API-KEY": String(apiKey),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path} returned non-JSON (${response.status}): ${text.slice(0, 300)}`);
  }
}

console.log(`host:   ${baseUrl}`);
console.log(`wallet: ${accountNumber}`);

// Always read first, so a run that changes nothing still tells you where
// events currently go — and so a typo'd wallet number fails before a write.
const status = (await call("/open/account/status", {
  type: 1,
  accountnumber: accountNumber,
})) as {
  status?: unknown;
  message?: string;
  data?: { balance?: unknown; accountname?: string; activated?: unknown; callback?: string };
};

if (String(status.status) !== "1") {
  console.error(`\nMoolre refused the status call: ${status.message ?? "unknown error"}`);
  process.exit(1);
}

console.log(`name:   ${status.data?.accountname ?? "?"}`);
console.log(`active: ${String(status.data?.activated ?? "?")}`);
console.log(`balance: GHS ${String(status.data?.balance ?? "?")}`);
console.log(`current callback: ${status.data?.callback ?? "(none)"}`);

if (!callbackUrl) {
  console.log(
    "\nRead-only run. Pass a URL to set the callback and print the secret:\n" +
      "  npm run moolre:callback -- https://your-tunnel.example.com/webhooks/payments",
  );
  process.exit(0);
}

if (!callbackUrl.startsWith("https://")) {
  // Moolre posts the secret in the body, so a plaintext callback would publish
  // the one credential that authenticates its own events.
  console.error(`\nRefusing a non-HTTPS callback: ${callbackUrl}`);
  process.exit(1);
}

console.log(`\nsetting callback -> ${callbackUrl}`);

const updated = (await call("/open/account/update", {
  type: 1,
  accountnumber: accountNumber,
  currency: "GHS",
  callback: callbackUrl,
})) as {
  status?: unknown;
  code?: string;
  message?: string;
  data?: { callback?: string; secret?: string };
};

if (String(updated.status) !== "1") {
  console.error(`\nMoolre refused the update: ${updated.message ?? "unknown error"}`);
  process.exit(1);
}

const secret = updated.data?.secret;

console.log(`callback now: ${updated.data?.callback ?? "?"}`);

if (!secret) {
  console.error(
    "\nThe update succeeded but returned no secret. Read the raw response below " +
      "and check the dashboard; without a secret the driver refuses every callback.",
  );
  console.error(JSON.stringify(updated, null, 2));
  process.exit(1);
}

console.log("\nPut this in backend/.env:\n");
console.log(`MOOLRE_WEBHOOK_SECRET=${secret}`);
console.log(
  "\nThen restart the dev server. It reads .env at boot and never re-reads it, " +
    "which is the same trap that burned a real notification on 2026-11-12.",
);
