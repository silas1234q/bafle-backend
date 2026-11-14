import { createHmac, timingSafeEqual } from "node:crypto";

import { assertPositiveMinorAmount } from "../lib/money.js";
import {
  PaymentProviderError,
  type CheckoutRequest,
  type CheckoutSession,
  type PaymentProvider,
  type PaymentSnapshot,
  type PaymentState,
  type PayoutBank,
  type PayoutRequest,
  type PayoutSnapshot,
  type PayoutState,
  type Recipient,
  type RecipientRequest,
  type RefundRequest,
  type RefundSnapshot,
  type RefundState,
  type WebhookEnvelope,
} from "./provider.js";

const API_BASE = "https://api.paystack.co";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;

/**
 * The bank list changes a few times a year at most, and the seller onboarding
 * form reads it on every render. Cached per process rather than per instance:
 * the list depends on the country, not on our key.
 */
const BANK_CACHE_TTL_MS = 60 * 60_000;
const bankCache = new Map<string, { banks: PayoutBank[]; expiresAt: number }>();

/** Paystack wraps every response in this envelope. */
interface Envelope<T> {
  status: boolean;
  message: string;
  data: T;
}

interface InitializeData {
  authorization_url: string;
  access_code: string;
  reference: string;
}

interface VerifyData {
  id: number;
  status: string;
  reference: string;
  amount: number;
  currency: string;
  channel: string | null;
  paid_at: string | null;
  gateway_response: string | null;
  fees: number | null;
}

interface RecipientData {
  recipient_code: string;
  details?: {
    account_number?: string | null;
    // Paystack echoes the name it holds for the account. For Ghanaian mobile
    // money it is often absent, so callers must tolerate null rather than
    // treating it as verification.
    account_name?: string | null;
  } | null;
}

interface BankData {
  name: string;
  code: string;
}

interface TransferData {
  transfer_code: string;
  reference: string;
  status: string;
  amount: number;
}

interface RefundData {
  id?: number;
  status?: string;
  amount?: number;
  refund?: { id?: number; status?: string; amount?: number } | null;
}

// Paystack's transaction statuses mapped onto our vocabulary. Anything
// unrecognised becomes "pending" rather than a guess: a wrong "succeeded"
// would release escrow for money we never actually received.
function toPaymentState(status: string): PaymentState {
  switch (status) {
    case "success":
      return "succeeded";
    case "failed":
      return "failed";
    case "abandoned":
      return "abandoned";
    case "reversed":
      return "reversed";
    default:
      return "pending";
  }
}

function toPayoutState(status: string): PayoutState {
  switch (status) {
    case "success":
      return "succeeded";
    case "failed":
      return "failed";
    case "reversed":
      return "reversed";
    case "processing":
    case "otp":
      return "processing";
    default:
      return "pending";
  }
}

function toRefundState(status: string | undefined): RefundState {
  switch (status) {
    case "processed":
      return "succeeded";
    case "failed":
      return "failed";
    case "processing":
      return "processing";
    default:
      return "pending";
  }
}

function delay(attempt: number): Promise<void> {
  // Short backoff: a buyer is waiting on the checkout call.
  return new Promise((resolve) => setTimeout(resolve, 250 * attempt));
}

export interface PaystackConfig {
  secretKey: string;
  /** Overridable so tests can point at a local stub. */
  baseUrl?: string;
}

export class PaystackProvider implements PaymentProvider {
  readonly name = "paystack" as const;
  readonly movesRealMoney = true;
  // Paystack keeps the account behind an opaque recipient code, so we never
  // need — or want — the number again after onboarding.
  readonly transfersNeedDestination = false;

  private readonly secretKey: string;
  private readonly baseUrl: string;

  constructor(config: PaystackConfig) {
    if (!config.secretKey.startsWith("sk_")) {
      throw new Error(
        'Paystack secret key must start with "sk_"; a publishable key cannot authenticate',
      );
    }
    this.secretKey = config.secretKey;
    this.baseUrl = config.baseUrl ?? API_BASE;
  }

  /** True when running on test keys, i.e. no real money moves. */
  get isTestMode(): boolean {
    return this.secretKey.startsWith("sk_test_");
  }

  private async call<T>(
    method: "GET" | "POST",
    path: string,
    options: { body?: unknown; idempotent: boolean },
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.secretKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body:
            options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        const text = await response.text();
        let envelope: Envelope<T> | null = null;
        try {
          envelope = JSON.parse(text) as Envelope<T>;
        } catch {
          envelope = null;
        }

        // 5xx and 429 may succeed on another attempt; 4xx will not.
        const transient = response.status >= 500 || response.status === 429;

        if (!response.ok || envelope?.status !== true) {
          const error = new PaymentProviderError(
            this.name,
            `Paystack ${method} ${path} failed with ${response.status}`,
            {
              status: response.status,
              providerMessage: envelope?.message ?? text.slice(0, 300),
              retryable: transient,
            },
          );

          if (transient && options.idempotent && attempt < MAX_ATTEMPTS) {
            lastError = error;
            await delay(attempt);
            continue;
          }
          throw error;
        }

        return envelope.data;
      } catch (error) {
        if (error instanceof PaymentProviderError) throw error;

        // Network failure or timeout. Retried only when replaying the request
        // cannot create a second charge or a second transfer.
        const wrapped = new PaymentProviderError(
          this.name,
          `Paystack ${method} ${path} did not complete`,
          { retryable: true, cause: error },
        );

        if (options.idempotent && attempt < MAX_ATTEMPTS) {
          lastError = wrapped;
          await delay(attempt);
          continue;
        }
        throw wrapped;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new PaymentProviderError(
          this.name,
          `Paystack ${method} ${path} exhausted retries`,
        );
  }

  async initiateCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
    assertPositiveMinorAmount(request.amountMinor);

    // Idempotent: Paystack keys the transaction on our reference, so a retry
    // returns the same pending transaction instead of creating a second one.
    const data = await this.call<InitializeData>(
      "POST",
      "/transaction/initialize",
      {
        idempotent: true,
        body: {
          email: request.customerEmail,
          amount: request.amountMinor,
          currency: request.currency,
          reference: request.reference,
          callback_url: request.callbackUrl,
          metadata: request.metadata,
        },
      },
    );

    return {
      reference: data.reference,
      redirectUrl: data.authorization_url,
      providerRef: data.access_code,
    };
  }

  async confirmPayment(reference: string): Promise<PaymentSnapshot> {
    const data = await this.call<VerifyData>(
      "GET",
      `/transaction/verify/${encodeURIComponent(reference)}`,
      { idempotent: true },
    );

    const state = toPaymentState(data.status);

    return {
      reference: data.reference,
      state,
      amountMinor: data.amount,
      currency: data.currency,
      feeMinor: data.fees ?? null,
      channel: data.channel ?? null,
      paidAt: data.paid_at ? new Date(data.paid_at) : null,
      providerRef: String(data.id),
      failureReason: state === "succeeded" ? null : (data.gateway_response ?? null),
    };
  }

  async refund(request: RefundRequest): Promise<RefundSnapshot> {
    assertPositiveMinorAmount(request.amountMinor);

    // NOT idempotent: Paystack accepts no client reference on refunds, so a
    // blind retry could refund twice. Retries belong to the job runner, which
    // consults our own Refund row before calling again.
    const data = await this.call<RefundData>("POST", "/refund", {
      idempotent: false,
      body: {
        transaction: request.paymentReference,
        amount: request.amountMinor,
        merchant_note: request.reason,
      },
    });

    const id = data.refund?.id ?? data.id ?? null;

    return {
      providerRefundId: id === null ? null : String(id),
      state: toRefundState(data.refund?.status ?? data.status),
      amountMinor: request.amountMinor,
      // Paystack reports no outbound fee here. Null rather than 0, so
      // "not reported" stays distinguishable from "genuinely free".
      feeMinor: null,
    };
  }

  async createRecipient(request: RecipientRequest): Promise<Recipient> {
    const data = await this.call<RecipientData>("POST", "/transferrecipient", {
      idempotent: false,
      body: {
        // "ghipss" is the Ghanaian bank rail; "nuban" is Nigeria-only.
        type: request.kind === "mobile_money" ? "mobile_money" : "ghipss",
        name: request.accountName,
        account_number: request.accountNumber,
        bank_code: request.bankCode,
        currency: request.currency,
      },
    });

    const accountNumber = data.details?.account_number ?? request.accountNumber;

    return {
      recipientCode: data.recipient_code,
      accountNumberLast4: accountNumber.slice(-4),
      accountName: data.details?.account_name ?? null,
    };
  }

  async listPayoutBanks(kind: RecipientRequest["kind"]): Promise<PayoutBank[]> {
    const type = kind === "mobile_money" ? "mobile_money" : "ghipss";

    const cached = bankCache.get(type);
    if (cached && cached.expiresAt > Date.now()) return cached.banks;

    // idempotent: a GET cannot create a recipient or move money, so the call
    // helper's retry is safe here and worth having — this is on the path of a
    // seller trying to get paid.
    const data = await this.call<BankData[]>(
      "GET",
      `/bank?country=ghana&currency=GHS&type=${type}`,
      { idempotent: true },
    );

    const banks = data.map((bank) => ({ code: bank.code, name: bank.name, kind }));
    bankCache.set(type, { banks, expiresAt: Date.now() + BANK_CACHE_TTL_MS });
    return banks;
  }

  async payout(request: PayoutRequest): Promise<PayoutSnapshot> {
    assertPositiveMinorAmount(request.amountMinor);

    // Idempotent by reference, per Paystack's transfer contract.
    const data = await this.call<TransferData>("POST", "/transfer", {
      idempotent: true,
      body: {
        source: "balance",
        amount: request.amountMinor,
        recipient: request.recipientCode,
        reference: request.reference,
        reason: request.reason,
        currency: "GHS",
      },
    });

    return {
      reference: data.reference,
      providerRef: data.transfer_code,
      state: toPayoutState(data.status),
      amountMinor: data.amount,
      feeMinor: null,
      failureReason: null,
    };
  }

  async checkPayoutStatus(reference: string): Promise<PayoutSnapshot> {
    // Keyed on our own reference: Paystack accepts either that or its transfer
    // code here, and ours is the one we are guaranteed to still have if the
    // original /transfer response never arrived.
    const data = await this.call<TransferData>(
      "GET",
      `/transfer/verify/${encodeURIComponent(reference)}`,
      { idempotent: true },
    );

    const state = toPayoutState(data.status);

    return {
      reference: data.reference,
      providerRef: data.transfer_code,
      state,
      amountMinor: data.amount,
      feeMinor: null,
      failureReason: state === "failed" || state === "reversed" ? data.status : null,
    };
  }

  async checkRefundStatus(args: {
    refundReference: string;
    providerRefundId: string | null;
  }): Promise<RefundSnapshot> {
    // Paystack keys refunds by ITS id, not ours. A refund with none recorded
    // never reached Paystack, so it is reported pending rather than invented
    // as succeeded — and crucially rather than looked up under our reference,
    // which would 404 and read like a provider fault.
    if (!args.providerRefundId) {
      return { providerRefundId: null, state: "pending", amountMinor: 0, feeMinor: null };
    }

    const data = await this.call<RefundData>(
      "GET",
      `/refund/${encodeURIComponent(args.providerRefundId)}`,
      { idempotent: true },
    );

    const id = data.refund?.id ?? data.id ?? null;

    return {
      providerRefundId: id === null ? null : String(id),
      state: toRefundState(data.refund?.status ?? data.status),
      amountMinor: data.refund?.amount ?? data.amount ?? 0,
      feeMinor: null,
    };
  }

  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookEnvelope | null {
    const header = headers["x-paystack-signature"];
    const signature = Array.isArray(header) ? header[0] : header;
    if (!signature) return null;

    // Paystack signs the raw body with the SECRET KEY itself (there is no
    // separate webhook secret), HMAC-SHA512, hex encoded.
    const expected = createHmac("sha512", this.secretKey)
      .update(rawBody)
      .digest("hex");

    const given = Buffer.from(signature, "utf8");
    const mine = Buffer.from(expected, "utf8");
    // timingSafeEqual throws when lengths differ, so compare those first.
    if (given.length !== mine.length) return null;
    if (!timingSafeEqual(given, mine)) return null;

    let parsed: {
      event?: unknown;
      data?: { reference?: unknown; id?: unknown };
    };
    try {
      parsed = JSON.parse(rawBody.toString("utf8")) as typeof parsed;
    } catch {
      return null;
    }

    const eventType = typeof parsed.event === "string" ? parsed.event : null;
    if (!eventType) return null;

    // Paystack sends no delivery id, so the dedupe key is the event type plus
    // the entity it concerns. Two deliveries of one event collapse together;
    // different events on the same entity (charge.success, then
    // refund.processed) have different types and so cannot collide.
    const entity =
      typeof parsed.data?.reference === "string"
        ? parsed.data.reference
        : parsed.data?.id !== undefined
          ? String(parsed.data.id)
          : "unknown";

    return {
      eventId: `paystack:${eventType}:${entity}`,
      eventType,
      payload: parsed,
    };
  }
}
