import { timingSafeEqual } from "node:crypto";

import {
  assertPositiveMinorAmount,
  cedisToPesewas,
  pesewasToCedis,
} from "../lib/money.js";
import {
  deriveRecipientCode,
  normaliseAccountNumber,
} from "../lib/payoutSecrets.js";
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
  type TransferDestination,
  type WebhookEnvelope,
} from "./provider.js";

/**
 * Moolre, replacing Paystack because Paystack refuses third-party transfers on
 * a "starter business" account — no amount of code could fix that, and sellers
 * were structurally unpayable until the rail changed.
 *
 * Three ways this provider differs from Paystack that the rest of the codebase
 * must not have to care about, and which most of this file exists to absorb:
 *
 * 1. **There is no refund endpoint.** A refund is an outbound transfer back to
 *    the payer, using the same call as a seller payout. `RefundRequest.
 *    destination` is therefore mandatory here, and `services/refunds.ts`
 *    decrypts it from the Payment row.
 * 2. **There is no recipient concept.** Every transfer takes the raw receiver,
 *    so the "recipient code" is derived locally (see lib/payoutSecrets.ts) and
 *    a `destination` has to travel with each payout.
 * 3. **Transfers have no webhook.** The documented callbacks are payment
 *    events (P01/P02) only, so a transfer reported as processing is settled by
 *    polling `checkPayoutStatus` / `checkRefundStatus`, never by waiting.
 *
 * Amounts are major-unit GHS on the wire, unlike Paystack's minor units. Every
 * conversion goes through lib/money.ts.
 */

const API_BASE = "https://api.moolre.com";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;

const BANK_CACHE_TTL_MS = 60 * 60_000;
const bankCache = new Map<string, { banks: PayoutBank[]; expiresAt: number }>();

/**
 * Transfer channels. Fetched lists are the rule in this codebase, and this is
 * the documented exception: Moolre's transfer channel enum is a closed set of
 * four, published in the API reference, with no endpoint that returns it. A
 * bank list rots because banks are added; this cannot drift without a
 * documented API change.
 *
 * **The codes are not symmetric between directions.** For a transfer MTN is 1;
 * for a collection MTN is 13. Telecel and AT happen to share 6 and 7 in both.
 * Using a collection code on a transfer silently addresses the wrong network,
 * so these are only ever used for transfers.
 */
const MOMO_TRANSFER_CHANNELS: PayoutBank[] = [
  { code: "1", name: "MTN Mobile Money", kind: "mobile_money" },
  { code: "6", name: "Telecel Cash", kind: "mobile_money" },
  { code: "7", name: "AT Money", kind: "mobile_money" },
];

/** Channel 2 is "Instant Bank Transfer"; the bank itself goes in `sublistid`. */
const BANK_TRANSFER_CHANNEL = "2";

/** Moolre wraps every response in this envelope. `status` is 1/0, not a bool. */
interface Envelope<T> {
  status: number | string;
  code?: string;
  /**
   * A string on most endpoints, but an **array of strings** on transfers
   * (`["Pay out Failed", "Click close to view transactions."]`). Declaring it
   * `string` would send an array into `Payout.failureReason`, which is a
   * String column — the same class of bug as `transactionid` arriving as a
   * number. Always read it through `toMessage`.
   */
  message?: string | string[];
  data?: T;
}

interface LinkData {
  authorization_url?: string;
  reference?: string;
}

interface TransactionData {
  txstatus?: number | string;
  /**
   * **Not consistently typed across endpoints.** The transfer response returns
   * it as a JSON number (`5084`), the status response as a string
   * (`"5082"`). Declaring it `string` made TypeScript vouch for something
   * the wire does not guarantee, and the Int went straight into a String
   * column — Prisma rejected the write *after* the provider had already moved
   * the money, leaving a succeeded transfer recorded as FAILED. Always read it
   * through `toProviderRef`.
   */
  transactionid?: string | number | null;
  externalref?: string | null;
  /** Gross, major-unit GHS, as a string. */
  amount?: string | number | null;
  /**
   * For a COLLECTION, net of the provider's fee: the fee is `amount - value`.
   * For a transfer the two are equal, because an outbound fee is charged on
   * top instead — read `fee` there, not this.
   */
  value?: string | number | null;
  /** Outbound fee, major-unit GHS. Charged on top of `amount`. */
  fee?: string | number | null;
  /** `amount + fee`: the total actually debited from the wallet. */
  amountfee?: string | number | null;
  networkfee?: string | number | null;
  /** The name the provider holds for a transfer's recipient, when it sends one. */
  receivername?: string | null;
  payer?: string | null;
  payername?: string | null;
  payernetwork?: string | null;
  payerinstitution?: string | null;
  payee?: string | null;
  reason?: string | null;
  ts?: string | null;
}

interface BankEntry {
  name?: string;
  code?: string;
}

interface AccountStatusData {
  balance?: number | string;
  accountname?: string;
  activated?: string | number;
}

/**
 * `txstatus` mapped onto our vocabulary.
 *
 * Moolre's reference documents only the success case, so the rest of this was
 * established against the sandbox on 2026-11-14 and the surprise is worth
 * stating plainly:
 *
 * **`txstatus: 3` with code `SS07` means "Transaction not found", not
 * "reversed".** An unpaid payment link and a reference that never existed
 * return the identical body — and they return it with envelope `status: 1`,
 * an application-level *success*, so it reaches this function rather than
 * being thrown as an error. An earlier revision mapped 3 to "reversed", which
 * would have marked a buyer's payment terminally dead while they were still
 * on the checkout page, and told the refund path to unwind escrow that was
 * never funded.
 *
 * So "not found" is **pending**: the transaction may simply not exist yet. The
 * reservation sweep is what eventually abandons a payment nobody made, on our
 * own clock rather than on a provider's silence.
 *
 * Everything unrecognised is pending for the same reason. A wrong "succeeded"
 * releases escrow for money that never arrived; a wrong "failed" refunds a
 * buyer who did pay. There is no safe guess, only a safe default.
 */
function toPaymentState(txstatus: number | string | undefined): PaymentState {
  switch (String(txstatus)) {
    case "1":
      return "succeeded";
    case "2":
      return "failed";
    default:
      return "pending";
  }
}

/**
 * The payout/refund counterpart. No "reversed" case: nothing observed from
 * this provider reports one, and inventing a mapping for it is what caused the
 * bug described above. If a real reversal code turns up, add it on evidence.
 */
function toPayoutState(txstatus: number | string | undefined): PayoutState {
  switch (String(txstatus)) {
    case "1":
      return "succeeded";
    case "2":
      return "failed";
    case "0":
      return "processing";
    default:
      return "pending";
  }
}

/**
 * Provider ids as strings, whatever the wire said.
 *
 * Every id we persist is a String column, and this provider is inconsistent
 * about whether it sends a number or a string for the same field. Coercing at
 * the boundary is the only place that can be done once.
 */
function toProviderRef(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

/**
 * Provider messages as one string, whatever the wire said.
 *
 * Joined rather than reduced to the first element, because the useful half is
 * not reliably first and a failure reason a human has to act on should not be
 * silently halved.
 */
function toMessage(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  if (Array.isArray(value)) {
    const joined = value.filter((part) => typeof part === "string").join(" ");
    return joined.length > 0 ? joined : null;
  }
  return value;
}

/** Major-unit GHS off the wire into pesewas. Tolerates string or number. */
function toPesewas(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  try {
    return cedisToPesewas(typeof value === "string" ? value.trim() : value);
  } catch {
    return null;
  }
}

/**
 * Failures that mean "the wallet is empty", which must be retryable.
 *
 * Moolre funds transfers from a prefunded wallet rather than from settled
 * collections, so an underfunded wallet is an operational state that clears
 * when money is topped up — not a reason to mark a real debt terminally
 * FAILED and stop trying. Matched on text because the API returns no distinct
 * code for it; a false positive here only costs a retry.
 */
function looksUnderfunded(message: string | null | undefined): boolean {
  if (!message) return false;
  const text = message.toLowerCase();
  return (
    text.includes("insufficient") ||
    text.includes("low balance") ||
    text.includes("inadequate")
  );
}

function delay(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 250 * attempt));
}

export interface MoolreConfig {
  apiUser: string;
  /** Private key: transfers, status, validation, balance. */
  apiKey: string;
  /** Public key: the hosted payment link and collections. */
  publicKey: string;
  /** The wallet collections credit and transfers debit. */
  accountNumber: string;
  /** Shared secret echoed in every callback body. */
  webhookSecret: string | null;
  baseUrl?: string;
}

export class MoolreProvider implements PaymentProvider {
  readonly name = "moolre" as const;
  readonly movesRealMoney = true;
  // Every transfer takes the raw receiver; there is no recipient handle to
  // transfer to instead.
  readonly transfersNeedDestination = true;

  private readonly apiUser: string;
  private readonly apiKey: string;
  private readonly publicKey: string;
  private readonly accountNumber: string;
  private readonly webhookSecret: string | null;
  private readonly baseUrl: string;

  constructor(config: MoolreConfig) {
    this.apiUser = config.apiUser;
    this.apiKey = config.apiKey;
    this.publicKey = config.publicKey;
    this.accountNumber = config.accountNumber;
    this.webhookSecret = config.webhookSecret;
    this.baseUrl = config.baseUrl ?? API_BASE;
  }

  /**
   * Moolre has no test-key convention: the sandbox is a different host with the
   * same credentials. So the only honest signal is the base URL.
   */
  get isTestMode(): boolean {
    return this.baseUrl.includes("sandbox");
  }

  private async call<T>(
    method: "GET" | "POST",
    path: string,
    options: {
      body?: unknown;
      idempotent: boolean;
      /** The link and collection endpoints authenticate with the public key. */
      auth?: "private" | "public";
    },
  ): Promise<Envelope<T>> {
    let lastError: unknown;

    const headers: Record<string, string> = {
      "X-API-USER": this.apiUser,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (options.auth === "public") headers["X-API-PUBKEY"] = this.publicKey;
    else headers["X-API-KEY"] = this.apiKey;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers,
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

        const transient = response.status >= 500 || response.status === 429;

        // An HTTP 200 with `status: 0` is a business-level refusal, not a
        // transport failure. Those must not be retried: a duplicate-reference
        // rejection is the provider correctly refusing a second charge.
        if (!response.ok || envelope === null || String(envelope.status) !== "1") {
          const providerMessage = toMessage(envelope?.message) ?? text.slice(0, 300);
          const error = new PaymentProviderError(
            this.name,
            `Moolre ${method} ${path} failed with ${response.status}${
              envelope?.code ? ` (${envelope.code})` : ""
            }`,
            {
              status: response.status,
              providerMessage,
              providerCode: envelope?.code ?? null,
              // An empty wallet is temporary; everything else at this level is
              // the provider saying no on the merits.
              retryable: transient || looksUnderfunded(providerMessage),
            },
          );

          if (transient && options.idempotent && attempt < MAX_ATTEMPTS) {
            lastError = error;
            await delay(attempt);
            continue;
          }
          throw error;
        }

        return envelope;
      } catch (error) {
        if (error instanceof PaymentProviderError) throw error;

        const wrapped = new PaymentProviderError(
          this.name,
          `Moolre ${method} ${path} did not complete`,
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
          `Moolre ${method} ${path} exhausted retries`,
        );
  }

  // -------------------------------------------------------------------------
  // Money in
  // -------------------------------------------------------------------------

  async initiateCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
    assertPositiveMinorAmount(request.amountMinor);

    // Idempotent: Moolre keys the link on our externalref and refuses a second
    // one with code INP02, so a replay cannot create a second charge.
    const envelope = await this.call<LinkData>("POST", "/embed/link", {
      idempotent: true,
      auth: "public",
      body: {
        type: 1,
        accountnumber: this.accountNumber,
        amount: pesewasToCedis(request.amountMinor),
        currency: request.currency,
        email: request.customerEmail,
        externalref: request.reference,
        // "0=No". A reusable link is payable more than once, which for a
        // ticket reservation would take a second payment against a basket
        // that only ever reserved one set of numbers. Required by the API,
        // and the unsafe value is the one that looks harmless.
        reusable: "0",
        // Minutes, minimum 1 — the unit the API wants. Rounded UP so the link
        // never dies a few seconds before the hold it belongs to, which would
        // strand a buyer who was about to pay.
        ...(request.expiresAt
          ? {
              expiration_time: Math.max(
                1,
                Math.ceil((request.expiresAt.getTime() - Date.now()) / 60_000),
              ),
            }
          : {}),
        // `redirect` is where the BUYER lands after paying (our /paid page).
        // The server-to-server callback is deliberately not set here: Moolre
        // ties the callback secret to the wallet's own callback URL, set once
        // via POST /open/account/update, so configuring it per checkout would
        // mean a URL whose secret we could not verify against. One place to
        // configure, one secret to check.
        ...(request.callbackUrl ? { redirect: request.callbackUrl } : {}),
      },
    });

    const redirectUrl = envelope.data?.authorization_url;
    if (!redirectUrl) {
      throw new PaymentProviderError(
        this.name,
        "Moolre returned no authorization_url for the checkout link",
        { providerMessage: toMessage(envelope.message) },
      );
    }

    return {
      reference: envelope.data?.reference ?? request.reference,
      redirectUrl,
      providerRef: envelope.data?.reference ?? null,
    };
  }

  async confirmPayment(reference: string): Promise<PaymentSnapshot> {
    const data = await this.transactionStatus(reference);

    const state = toPaymentState(data.txstatus);
    const gross = toPesewas(data.amount);
    const net = toPesewas(data.value);

    return {
      reference: data.externalref ?? reference,
      state,
      amountMinor: gross ?? 0,
      currency: "GHS",
      // Moolre reports no fee field. It reports gross and net, and the
      // difference is what it kept — which is exactly what the ledger needs to
      // know, since escrow holds the net rather than the ticket total.
      feeMinor: gross !== null && net !== null ? gross - net : null,
      channel: data.payernetwork ?? null,
      paidAt: state === "succeeded" && data.ts ? new Date(data.ts) : null,
      providerRef: toProviderRef(data.transactionid),
      failureReason: state === "succeeded" ? null : (data.reason ?? null),
    };
  }

  /** Shared by payment, payout and refund status: one endpoint serves all. */
  private async transactionStatus(reference: string): Promise<TransactionData> {
    const envelope = await this.call<TransactionData>(
      "POST",
      "/open/transact/status",
      {
        idempotent: true,
        body: {
          type: 1,
          // idtype 1 means "this is the caller's own reference". Always ours:
          // a transfer whose response never arrived has no provider id to use.
          idtype: 1,
          id: reference,
          accountnumber: this.accountNumber,
        },
      },
    );

    return envelope.data ?? {};
  }

  // -------------------------------------------------------------------------
  // Money out
  // -------------------------------------------------------------------------

  /**
   * Resolves a destination to the two fields the transfer endpoint wants.
   *
   * Throws rather than defaulting: a transfer with a missing channel would be
   * addressed to the wrong network, and "pay the right amount to the wrong
   * person" is the single worst outcome available here.
   */
  private transferTarget(destination: TransferDestination | undefined): {
    channel: string;
    receiver: string;
    sublistid?: string;
  } {
    if (!destination) {
      throw new PaymentProviderError(
        this.name,
        "Moolre transfers need the destination account; none was supplied",
        { retryable: false },
      );
    }

    const receiver = normaliseAccountNumber(
      destination.accountNumber,
      destination.kind,
    );

    if (destination.kind === "bank") {
      return {
        channel: BANK_TRANSFER_CHANNEL,
        receiver,
        sublistid: destination.bankCode,
      };
    }

    const channel = MOMO_TRANSFER_CHANNELS.find(
      (entry) => entry.code === destination.bankCode,
    );
    if (!channel) {
      throw new PaymentProviderError(
        this.name,
        `"${destination.bankCode}" is not a Moolre mobile money transfer channel`,
        { retryable: false },
      );
    }

    return { channel: channel.code, receiver };
  }

  private async transfer(args: {
    reference: string;
    amountMinor: number;
    reason: string;
    destination: TransferDestination | undefined;
  }): Promise<TransactionData> {
    assertPositiveMinorAmount(args.amountMinor);
    const target = this.transferTarget(args.destination);

    // NOT idempotent at the transport level. Moolre dedupes on externalref, but
    // a retry whose first attempt actually landed and whose response was lost
    // is indistinguishable here from one that never arrived — so retrying is
    // left to the job runner, which consults our own row first and can poll
    // `checkPayoutStatus` instead of sending again.
    const envelope = await this.call<TransactionData>(
      "POST",
      "/open/transact/transfer",
      {
        idempotent: false,
        body: {
          type: 1,
          channel: target.channel,
          currency: "GHS",
          amount: pesewasToCedis(args.amountMinor),
          receiver: target.receiver,
          externalref: args.reference,
          accountnumber: this.accountNumber,
          reference: args.reason,
          ...(target.sublistid ? { sublistid: target.sublistid } : {}),
        },
      },
    );

    return envelope.data ?? {};
  }

  async payout(request: PayoutRequest): Promise<PayoutSnapshot> {
    const data = await this.transfer({
      reference: request.reference,
      amountMinor: request.amountMinor,
      reason: request.reason,
      destination: request.destination,
    });

    const state = toPayoutState(data.txstatus);

    return {
      reference: data.externalref ?? request.reference,
      providerRef: toProviderRef(data.transactionid),
      state,
      amountMinor: toPesewas(data.amount) ?? request.amountMinor,
      feeMinor: toPesewas(data.fee),
      failureReason: state === "failed" || state === "reversed" ? (data.reason ?? null) : null,
    };
  }

  /**
   * A refund is a transfer back to the payer. Moolre has no refund endpoint, so
   * there is nothing to reverse — the money goes out the same way a payout does.
   *
   * Two consequences the ledger has to carry: the platform pays a transfer fee
   * to refund, on top of already having absorbed the collection fee, and the
   * result is asynchronous where a card reversal would not be.
   */
  async refund(request: RefundRequest): Promise<RefundSnapshot> {
    const data = await this.transfer({
      // The refund's own reference, never the payment's: that one is already
      // taken by the collection being reversed.
      reference: request.refundReference,
      amountMinor: request.amountMinor,
      reason: request.reason,
      destination: request.destination,
    });

    const state = toPayoutState(data.txstatus);

    return {
      providerRefundId: toProviderRef(data.transactionid),
      // PayoutState and RefundState differ only by "reversed", which this
      // provider never reports; collapsed anyway so the types line up and a
      // future reversal code cannot silently widen RefundState.
      state: state === "reversed" ? "failed" : state,
      amountMinor: toPesewas(data.amount) ?? request.amountMinor,
      feeMinor: toPesewas(data.fee),
    };
  }

  async checkPayoutStatus(reference: string): Promise<PayoutSnapshot> {
    const data = await this.transactionStatus(reference);
    const state = toPayoutState(data.txstatus);

    return {
      reference: data.externalref ?? reference,
      providerRef: toProviderRef(data.transactionid),
      state,
      amountMinor: toPesewas(data.amount) ?? 0,
      feeMinor: toPesewas(data.fee),
      failureReason: state === "failed" || state === "reversed" ? (data.reason ?? null) : null,
    };
  }

  async checkRefundStatus(args: {
    refundReference: string;
    providerRefundId: string | null;
  }): Promise<RefundSnapshot> {
    // Our reference: the refund went out as a transfer keyed on it.
    const data = await this.transactionStatus(args.refundReference);
    const state = toPayoutState(data.txstatus);

    return {
      providerRefundId: toProviderRef(data.transactionid),
      state: state === "reversed" ? "failed" : state,
      amountMinor: toPesewas(data.amount) ?? 0,
      feeMinor: toPesewas(data.fee),
    };
  }

  // -------------------------------------------------------------------------
  // Destinations
  // -------------------------------------------------------------------------

  /**
   * Moolre issues no recipient handle, so this validates the account and lets
   * the caller derive its own code.
   *
   * The validation is a real gain over the previous rail: Paystack's resolve
   * endpoint is Nigeria-focused and returned nothing for Ghanaian mobile money,
   * so a seller who mistyped a digit was only caught when their money reached a
   * stranger. `validate-name` answers with the registered account holder.
   */
  async createRecipient(request: RecipientRequest): Promise<Recipient> {
    const target = this.transferTarget({
      kind: request.kind,
      accountNumber: request.accountNumber,
      bankCode: request.bankCode,
    });

    let envelope: { data?: unknown } = {};
    try {
      envelope = await this.call<TransactionData | { name?: string } | string>(
        "POST",
        "/open/transact/validate",
        {
          idempotent: true,
          body: {
            type: 1,
            channel: target.channel,
            currency: request.currency,
            receiver: target.receiver,
            accountnumber: this.accountNumber,
            ...(target.sublistid ? { sublistid: target.sublistid } : {}),
          },
        },
      );
    } catch (error) {
      // Two refusals arrive here and they mean opposite things.
      //
      // AVD02 is the real answer: the provider looked and found no such
      // account. That is exactly the control this call is for, so it is
      // rethrown and onboarding refuses the number.
      //
      // Anything else — IN01 "Authentication Error" is what this account
      // actually returns on the sandbox, with every key combination, while
      // /open/account/status accepts the same private key — means the endpoint
      // is not answering *for us*. Failing onboarding on that would make every
      // seller unpayable to protect against a check that never ran. So we
      // proceed without a name and claim no verification.
      //
      // That is no worse than the rail this replaced: Paystack's resolve
      // endpoint is Nigeria-focused and returned nothing for Ghanaian mobile
      // money either, which is why `accountName` has always been nullable. A
      // wrong number still surfaces as a failed transfer rather than silently
      // paying a stranger — see the open gap on account-name verification.
      if (
        error instanceof PaymentProviderError &&
        error.providerCode === "AVD02"
      ) {
        throw error;
      }
      if (!(error instanceof PaymentProviderError)) throw error;
    }

    // The payload shape for this endpoint is documented only by example, where
    // the holder name is the data field. Read it defensively rather than
    // assuming: a missing name must not fail onboarding, since the call already
    // proved the account exists (AVD02 would have thrown above).
    const raw: unknown = envelope.data;
    const accountName =
      typeof raw === "string"
        ? raw
        : typeof raw === "object" && raw !== null && "name" in raw
          ? ((raw as { name?: unknown }).name as string | undefined) ?? null
          : null;

    return {
      // Derived here rather than returned by Moolre, which issues no handle.
      // Deterministic, so the same account details always produce the same
      // code and the unique index on SellerProfile still turns a second seller
      // claiming someone else's wallet into DESTINATION_TAKEN. Never the raw
      // receiver: that would put a full account number into a column that is
      // deliberately readable, logged and returned to callers.
      recipientCode: deriveRecipientCode(
        request.kind,
        request.bankCode,
        request.accountNumber,
      ),
      accountNumberLast4: target.receiver.slice(-4),
      accountName: accountName && accountName.length > 0 ? accountName : null,
    };
  }

  async listPayoutBanks(kind: RecipientRequest["kind"]): Promise<PayoutBank[]> {
    // The three mobile money channels are a closed documented set — see the
    // comment on MOMO_TRANSFER_CHANNELS for why this one list is not fetched.
    if (kind === "mobile_money") return MOMO_TRANSFER_CHANNELS;

    const cached = bankCache.get(kind);
    if (cached && cached.expiresAt > Date.now()) return cached.banks;

    const envelope = await this.call<BankEntry[]>(
      "GET",
      "/open/transact/data?country=gha&data=banks",
      { idempotent: true },
    );

    const banks = (envelope.data ?? [])
      .filter(
        (entry): entry is { name: string; code: string } =>
          typeof entry.name === "string" && typeof entry.code === "string",
      )
      .map((entry) => ({ code: entry.code, name: entry.name, kind }));

    if (banks.length === 0) {
      // Not cached: an empty list would otherwise be served for an hour and
      // make every seller's onboarding form look broken.
      throw new PaymentProviderError(
        this.name,
        "Moolre returned no banks for Ghana",
        { retryable: true },
      );
    }

    bankCache.set(kind, { banks, expiresAt: Date.now() + BANK_CACHE_TTL_MS });
    return banks;
  }

  /**
   * Wallet balance, in pesewas.
   *
   * Not part of the provider interface: it exists because this rail is
   * prefunded. Collections credit the same wallet transfers debit, so a balance
   * that cannot cover a payout means float has to be moved, and that is
   * operational news worth surfacing rather than a payout failure to retry.
   */
  async walletBalanceMinor(): Promise<number | null> {
    const envelope = await this.call<AccountStatusData>(
      "POST",
      "/open/account/status",
      {
        idempotent: true,
        body: { type: 1, accountnumber: this.accountNumber },
      },
    );

    return toPesewas(envelope.data?.balance ?? null);
  }

  // -------------------------------------------------------------------------
  // Callbacks
  // -------------------------------------------------------------------------

  /**
   * Verifies a callback.
   *
   * **This is weaker than Paystack's and the difference matters.** Paystack
   * signs the raw bytes with HMAC-SHA512, so the body cannot be altered without
   * detection. Moolre echoes a shared secret *inside* the payload, which proves
   * the sender knows the secret but binds nothing to the content — anyone who
   * has ever seen one valid callback can replay it with different numbers.
   *
   * What actually protects us is the rule that predates this driver: a webhook
   * is only a hint that something changed, and `confirmTicketPayment`
   * re-queries the provider for the authoritative amount before a single
   * ledger entry is written. Do not "optimise" that away for this provider.
   */
  verifyWebhook(
    rawBody: Buffer,
    _headers: Record<string, string | string[] | undefined>,
  ): WebhookEnvelope | null {
    // Refused outright when unconfigured, rather than accepting everything:
    // the same stance env.ts takes on JOBS_TRIGGER_SECRET.
    if (!this.webhookSecret) return null;

    let parsed: {
      code?: unknown;
      status?: unknown;
      secret?: unknown;
      data?: TransactionData;
    };
    try {
      parsed = JSON.parse(rawBody.toString("utf8")) as typeof parsed;
    } catch {
      return null;
    }

    const given = typeof parsed.secret === "string" ? parsed.secret : null;
    if (!given) return null;

    const a = Buffer.from(given, "utf8");
    const b = Buffer.from(this.webhookSecret, "utf8");
    // timingSafeEqual throws on a length mismatch, so compare lengths first.
    if (a.length !== b.length) return null;
    if (!timingSafeEqual(a, b)) return null;

    const code = typeof parsed.code === "string" ? parsed.code : null;
    if (!code) return null;

    const entity = parsed.data?.externalref ?? parsed.data?.transactionid ?? "unknown";

    return {
      // Same shape as the Paystack driver's: Moolre sends no delivery id
      // either, so the event code plus the entity it concerns is the dedupe
      // key. P01 and P02 for one payment cannot collide.
      eventId: `moolre:${code}:${entity}`,
      eventType: code,
      payload: parsed,
    };
  }
}

/**
 * The payer's destination, lifted from a verified callback.
 *
 * Exported because this is the *only* place a payer's number is ever
 * disclosed to us: the status endpoint returns an empty `payer`. If this is
 * not captured when the callback arrives, that payment can never be refunded
 * automatically — which is why `services/payments.ts` stores it rather than
 * reading it twice.
 */
export function payerDestinationFromWebhook(payload: unknown): {
  accountNumber: string;
  bankCode: string;
  accountName: string | null;
} | null {
  if (typeof payload !== "object" || payload === null) return null;
  const data = (payload as { data?: TransactionData }).data;
  if (!data?.payer) return null;

  const network = (data.payernetwork ?? "").toUpperCase();
  const channel = MOMO_TRANSFER_CHANNELS.find((entry) =>
    network.startsWith(entry.name.split(" ")[0]?.toUpperCase() ?? " "),
  );
  if (!channel) return null;

  try {
    return {
      accountNumber: normaliseAccountNumber(data.payer, "mobile_money"),
      bankCode: channel.code,
      accountName: data.payername ?? null,
    };
  } catch {
    // An unparseable payer number is worth recording nothing for: a refund
    // blocked on a missing destination is visible, a refund sent to a mangled
    // number is not.
    return null;
  }
}
