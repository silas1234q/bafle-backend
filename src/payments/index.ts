import { env } from "../env.js";
import { MoolreProvider } from "./moolre.js";
import { PaystackProvider } from "./paystack.js";
import type { PaymentProvider } from "./provider.js";

export * from "./provider.js";

let instance: PaymentProvider | null = null;

/**
 * The active payment driver.
 *
 * Constructed lazily and cached: validating payment config at import time
 * would stop the whole API from booting just because provider keys are not set
 * yet, which is the normal state during early development.
 */
export function paymentProvider(): PaymentProvider {
  if (instance) return instance;

  switch (env.PAYMENT_PROVIDER) {
    case "paystack": {
      if (!env.PAYSTACK_SECRET_KEY) {
        throw new Error(
          "PAYMENT_PROVIDER=paystack but PAYSTACK_SECRET_KEY is not set. " +
            "Create a free Paystack account and copy the test secret key.",
        );
      }
      instance = new PaystackProvider({
        secretKey: env.PAYSTACK_SECRET_KEY,
        ...(env.PAYSTACK_BASE_URL ? { baseUrl: env.PAYSTACK_BASE_URL } : {}),
      });
      return instance;
    }

    case "moolre": {
      // Every missing value is named at once. Reported together rather than one
      // at a time because this is four separate dashboard fields, and finding
      // them one failed boot apiece is how an evening disappears — the same
      // reasoning as the production guards in env.ts.
      const missing = (
        [
          ["MOOLRE_API_USER", env.MOOLRE_API_USER],
          ["MOOLRE_API_KEY", env.MOOLRE_API_KEY],
          ["MOOLRE_PUBLIC_KEY", env.MOOLRE_PUBLIC_KEY],
          ["MOOLRE_ACCOUNT_NUMBER", env.MOOLRE_ACCOUNT_NUMBER],
        ] as const
      )
        .filter(([, value]) => !value)
        .map(([name]) => name);

      if (missing.length > 0) {
        throw new Error(
          `PAYMENT_PROVIDER=moolre but ${missing.join(", ")} ${
            missing.length === 1 ? "is" : "are"
          } not set. ` +
            "Find them in the Moolre dashboard under Integrate Our APIs: the " +
            "account number is the wallet, and the keys are in the API " +
            "service's Security section.",
        );
      }

      instance = new MoolreProvider({
        // Non-null: the guard above returns for every missing value. Asserted
        // through a local rather than `!` so a future edit to that list fails
        // here loudly instead of sending "undefined" as a credential.
        apiUser: String(env.MOOLRE_API_USER),
        apiKey: String(env.MOOLRE_API_KEY),
        publicKey: String(env.MOOLRE_PUBLIC_KEY),
        accountNumber: String(env.MOOLRE_ACCOUNT_NUMBER),
        webhookSecret: env.MOOLRE_WEBHOOK_SECRET,
        ...(env.MOOLRE_BASE_URL ? { baseUrl: env.MOOLRE_BASE_URL } : {}),
      });
      return instance;
    }

    case "mock": {
      // Built in phase 2b, from webhook payloads captured against real test
      // keys rather than guessed at.
      throw new Error(
        "PAYMENT_PROVIDER=mock is not implemented yet; use paystack or moolre",
      );
    }
  }
}

/**
 * Whether the active driver actually moves money.
 *
 * The single answer to that question, because each driver signals test mode
 * differently — Paystack by an `sk_test_` key prefix, Moolre by running against
 * a separate sandbox host with the same credentials. Services must not re-derive
 * it; `sendPayout` and `refundRaffle` consult this before moving anything.
 *
 * Throws if the provider is unconfigured, so a caller cannot read "not real"
 * out of a missing configuration and proceed on that basis.
 */
export function providerMovesRealMoney(): boolean {
  const provider = paymentProvider();
  const testMode =
    provider instanceof PaystackProvider || provider instanceof MoolreProvider
      ? provider.isTestMode
      : false;
  return provider.movesRealMoney && !testMode;
}

/** For /health and startup logging. Never throws. */
export function paymentProviderStatus(): {
  provider: string;
  configured: boolean;
  movesRealMoney: boolean | null;
  testMode: boolean | null;
} {
  try {
    const provider = paymentProvider();
    // Each driver decides what "not real money" means for it: Paystack has a
    // test key prefix, Moolre has a separate sandbox host and no test keys at
    // all. Neither is inferable from the interface.
    const testMode =
      provider instanceof PaystackProvider || provider instanceof MoolreProvider
        ? provider.isTestMode
        : null;
    return {
      provider: provider.name,
      configured: true,
      movesRealMoney: provider.movesRealMoney && testMode !== true,
      testMode,
    };
  } catch {
    return {
      provider: env.PAYMENT_PROVIDER,
      configured: false,
      movesRealMoney: null,
      testMode: null,
    };
  }
}
