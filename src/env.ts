import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/** Comma-separated list, trimmed, empties dropped. */
function list(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;

  const values = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return values.length > 0 ? values : fallback;
}

/** Keeps `${APP_URL}/orders/x` from becoming `//orders/x`. */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end--;
  return value.slice(0, end);
}

const NODE_ENV = process.env.NODE_ENV ?? "development";
const IS_PRODUCTION = NODE_ENV === "production";

const PAYMENT_PROVIDERS = ["paystack", "moolre", "mock"] as const;
export type PaymentProviderName = (typeof PAYMENT_PROVIDERS)[number];

const EMAIL_PROVIDERS = ["brevo", "console", "smtp"] as const;
export type EmailProviderName = (typeof EMAIL_PROVIDERS)[number];

const rawEmailProvider = process.env.EMAIL_PROVIDER ?? "console";
if (!EMAIL_PROVIDERS.includes(rawEmailProvider as EmailProviderName)) {
  throw new Error(
    `EMAIL_PROVIDER must be one of ${EMAIL_PROVIDERS.join(", ")}, got "${rawEmailProvider}"`,
  );
}
const EMAIL_PROVIDER = rawEmailProvider as EmailProviderName;

// Caught here rather than left to the driver: a NaN port makes Nodemailer hang
// until it times out, which reads like a network fault instead of a typo.
if (process.env.SMTP_PORT && !Number.isInteger(Number(process.env.SMTP_PORT))) {
  throw new Error(`SMTP_PORT must be an integer, got "${process.env.SMTP_PORT}"`);
}

const rawProvider = process.env.PAYMENT_PROVIDER ?? "paystack";
if (!PAYMENT_PROVIDERS.includes(rawProvider as PaymentProviderName)) {
  throw new Error(
    `PAYMENT_PROVIDER must be one of ${PAYMENT_PROVIDERS.join(", ")}, got "${rawProvider}"`,
  );
}
const PAYMENT_PROVIDER = rawProvider as PaymentProviderName;

// Deliberately nullable, and NOT validated at boot. The payment layer
// validates on first use instead, so missing payment config cannot stop the
// auth and catalogue routes from working during development.
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY ?? null;

export const env = {
  DATABASE_URL: required("DATABASE_URL"),

  // Clerk. Required rather than optional on purpose: booting without these
  // would leave every "protected" route silently unauthenticated.
  CLERK_PUBLISHABLE_KEY: required("CLERK_PUBLISHABLE_KEY"),
  CLERK_SECRET_KEY: required("CLERK_SECRET_KEY"),
  CLERK_WEBHOOK_SIGNING_SECRET: required("CLERK_WEBHOOK_SIGNING_SECRET"),

  PAYMENT_PROVIDER,
  PAYSTACK_SECRET_KEY,
  // Overridable so tests can point the driver at a local stub, and so a
  // proxy or regional endpoint can be used without a code change.
  PAYSTACK_BASE_URL: process.env.PAYSTACK_BASE_URL ?? null,
  // Where Paystack returns the buyer after checkout.
  PAYSTACK_CALLBACK_URL: process.env.PAYSTACK_CALLBACK_URL ?? null,

  // Moolre. Nullable and validated on first use, same reasoning as Paystack's
  // keys: missing payment config must not stop the catalogue and auth routes
  // from booting in development.
  //
  // Two keys, not one, and they are not interchangeable: the hosted checkout
  // link authenticates with the PUBLIC key, while transfers, status lookups,
  // name validation and the wallet balance need the PRIVATE one.
  MOOLRE_API_USER: process.env.MOOLRE_API_USER ?? null,
  MOOLRE_API_KEY: process.env.MOOLRE_API_KEY ?? null,
  MOOLRE_PUBLIC_KEY: process.env.MOOLRE_PUBLIC_KEY ?? null,
  // The wallet collections credit and transfers debit — the same one, which is
  // what makes payouts self-funding on this rail.
  MOOLRE_ACCOUNT_NUMBER: process.env.MOOLRE_ACCOUNT_NUMBER ?? null,
  // Echoed inside every callback body. Moolre does not sign the payload, so
  // this is the only authentication a webhook carries; the driver refuses every
  // callback when it is unset rather than trusting unverified ones.
  MOOLRE_WEBHOOK_SECRET: process.env.MOOLRE_WEBHOOK_SECRET ?? null,
  // Point at https://sandbox.moolre.com to run against the sandbox, or at a
  // local stub in tests.
  MOOLRE_BASE_URL: process.env.MOOLRE_BASE_URL ?? null,

  // Optional. When unset, the delivery-code key is derived from
  // CLERK_SECRET_KEY via HKDF with a distinct label, which is already a
  // strong secret. Set this to rotate delivery codes independently of auth.
  DELIVERY_CODE_SECRET: process.env.DELIVERY_CODE_SECRET ?? null,

  // Lets a TEST-mode payment provider settle real payouts and refunds.
  //
  // Off by default, and the default is the whole point. A sandbox provider
  // pointed at this database will happily "pay" a real seller with fake money
  // and mark the payout PAID with a genuine ledger entry — the books would
  // then say a debt was settled that was never settled, which is corruption
  // no later reconciliation can distinguish from a real payment.
  //
  // Set it only for a deliberate end-to-end test (see npm run moolre:e2e),
  // and never in an environment holding real debts.
  ALLOW_TEST_MONEY_ON_REAL_DATA:
    process.env.ALLOW_TEST_MONEY_ON_REAL_DATA === "true",

  // Optional, same shape as DELIVERY_CODE_SECRET: when unset the destination
  // key is derived from CLERK_SECRET_KEY via HKDF under its own label. Set it
  // to rotate payout destinations independently of auth — but note that
  // rotating it makes every stored destination undecryptable, so sellers would
  // have to re-onboard and queued refunds would need their destination again.
  PAYOUT_ENCRYPTION_KEY: process.env.PAYOUT_ENCRYPTION_KEY ?? null,

  // Shared secret for POST /internal/jobs/tick. That endpoint drives refunds
  // and payouts, so it is refused entirely when this is unset rather than
  // defaulting to open.
  JOBS_TRIGGER_SECRET: process.env.JOBS_TRIGGER_SECRET ?? null,

  EMAIL_PROVIDER,
  BREVO_API_KEY: process.env.BREVO_API_KEY ?? null,

  // SMTP, for EMAIL_PROVIDER=smtp. Host and port default to Gmail's in the
  // driver, so a Gmail account needs only the user and an App Password.
  SMTP_HOST: process.env.SMTP_HOST ?? null,
  SMTP_PORT: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : null,
  SMTP_USER: process.env.SMTP_USER ?? null,
  SMTP_PASS: process.env.SMTP_PASS ?? null,

  // Must be the sender address verified with the provider. On smtp this may be
  // left unset: the driver falls back to SMTP_USER, which is the only sender
  // Gmail accepts anyway.
  EMAIL_FROM: process.env.EMAIL_FROM ?? null,
  EMAIL_FROM_NAME: process.env.EMAIL_FROM_NAME ?? null,

  // Public base URL of the web app, used to build links inside emails.
  APP_URL: stripTrailingSlashes(
    process.env.APP_URL ?? "http://localhost:5173",
  ),

  // Cloudinary. Uploads are signed here and sent straight from the
  // browser, so image bytes never pass through this API.
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME ?? null,
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY ?? null,
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET ?? null,

  // Browser origins allowed to call this API. Defaulted for local dev only.
  CORS_ORIGINS: list("CORS_ORIGINS", ["http://localhost:5173"]),

  PORT: Number(process.env.PORT ?? 3000),
  NODE_ENV,
  IS_PRODUCTION,
};

// ---------------------------------------------------------------------------
// Production guards.
//
// Config conventions fail: .env files get copied, someone flips a value to
// debug staging and forgets. These turn "don't do that" into "the process
// will not start".
//
// Every violation is collected and reported together. Throwing on the first
// one means a misconfigured deployment gets fixed one redeploy at a time,
// which is how a launch evening disappears.
// ---------------------------------------------------------------------------

if (IS_PRODUCTION) {
  const problems: string[] = [];

  if (!process.env.CORS_ORIGINS) {
    problems.push(
      "CORS_ORIGINS must be set in production; refusing to fall back to localhost",
    );
  }

  if (process.env.ALLOW_TEST_MONEY_ON_REAL_DATA === "true") {
    problems.push(
      "ALLOW_TEST_MONEY_ON_REAL_DATA=true in production would let a sandbox provider mark real payouts PAID with money that never moved",
    );
  }

  if (PAYMENT_PROVIDER === "mock") {
    problems.push(
      "PAYMENT_PROVIDER=mock in production would record payments that never happened",
    );
  }

  // Per-provider, for the same reason the email guard below is: demanding
  // Paystack's key from a Moolre deployment would refuse to start a correctly
  // configured one. That exact bug was already fixed once in the email branch.
  switch (PAYMENT_PROVIDER) {
    case "paystack":
      if (!PAYSTACK_SECRET_KEY) {
        problems.push("PAYSTACK_SECRET_KEY must be set in production");
      } else if (PAYSTACK_SECRET_KEY.startsWith("sk_test_")) {
        // The sneakier failure: the code path is identical and the responses
        // look real, but no money ever moves.
        problems.push("PAYSTACK_SECRET_KEY is a TEST key but NODE_ENV=production");
      }
      break;

    case "moolre": {
      for (const key of [
        "MOOLRE_API_USER",
        "MOOLRE_API_KEY",
        "MOOLRE_PUBLIC_KEY",
        "MOOLRE_ACCOUNT_NUMBER",
      ]) {
        if (!process.env[key]) problems.push(`${key} must be set in production`);
      }

      if (!process.env.MOOLRE_WEBHOOK_SECRET) {
        problems.push(
          "MOOLRE_WEBHOOK_SECRET must be set in production; without it every payment callback is refused and paid tickets are only confirmed when a buyer returns to /paid",
        );
      }

      // The sandbox is a separate host rather than a test key, so this is the
      // Moolre equivalent of shipping sk_test_ to production: every call
      // succeeds and no money moves.
      if (process.env.MOOLRE_BASE_URL?.includes("sandbox")) {
        problems.push(
          "MOOLRE_BASE_URL points at the sandbox but NODE_ENV=production",
        );
      }
      break;
    }

    case "mock":
      // Already reported above.
      break;
  }

  // Per-provider, not "console vs. everything else": each driver needs a
  // different set of secrets, and demanding Brevo's from an SMTP deployment
  // would refuse to start a perfectly configured one.
  switch (EMAIL_PROVIDER) {
    case "console":
      problems.push(
        "EMAIL_PROVIDER=console in production would silently discard every notification, including telling winners they won",
      );
      break;

    case "brevo":
      if (!process.env.BREVO_API_KEY) problems.push("BREVO_API_KEY must be set in production");
      if (!process.env.EMAIL_FROM) problems.push("EMAIL_FROM must be set in production");
      break;

    case "smtp":
      // EMAIL_FROM is not required: the driver falls back to SMTP_USER.
      if (!process.env.SMTP_USER) problems.push("SMTP_USER must be set in production");
      if (!process.env.SMTP_PASS) {
        problems.push(
          "SMTP_PASS must be set in production (a Google App Password for Gmail)",
        );
      }
      break;
  }

  if (!process.env.APP_URL) {
    problems.push(
      "APP_URL must be set in production; email links would otherwise point at localhost",
    );
  }

  for (const key of [
    "CLOUDINARY_CLOUD_NAME",
    "CLOUDINARY_API_KEY",
    "CLOUDINARY_API_SECRET",
  ]) {
    if (!process.env[key]) problems.push(`${key} must be set in production`);
  }

  if (!process.env.JOBS_TRIGGER_SECRET) {
    problems.push(
      "JOBS_TRIGGER_SECRET must be set in production; without it reservations never expire, raffles never refund and sellers never get paid",
    );
  }

  if (problems.length > 0) {
    const newline = "\n";
    throw new Error(
      [
        `Refusing to start in production with ${problems.length} configuration problem(s):`,
        ...problems.map((problem) => `  - ${problem}`),
      ].join(newline),
    );
  }
}
