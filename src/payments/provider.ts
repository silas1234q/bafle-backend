import type { Currency } from "../lib/money.js";

// The boundary between Bafle and whoever moves the money.
//
// Deliberately domain-shaped: no provider vocabulary appears in any signature,
// so a second driver has to fit this shape without the raffle, ledger or payout
// code changing. That is the whole point, and it was collected on: Paystack
// refuses third-party transfers on a starter business, so Moolre replaced it
// without any of those layers moving.

export type ProviderName = "paystack" | "moolre" | "mock";

/** Lifecycle of money coming in. */
export type PaymentState =
  | "pending"
  | "succeeded"
  | "failed"
  | "abandoned"
  | "reversed";

/** Lifecycle of money going back out to a buyer. */
export type RefundState = "pending" | "processing" | "succeeded" | "failed";

/** Lifecycle of money going out to a seller. */
export type PayoutState =
  | "pending"
  | "processing"
  | "succeeded"
  | "failed"
  | "reversed";

export interface CheckoutRequest {
  /** Our own idempotency key. Replaying it must never double-charge. */
  reference: string;
  amountMinor: number;
  currency: Currency;
  customerEmail: string;
  /** Where the provider returns the buyer after payment. */
  callbackUrl?: string;
  /**
   * When this checkout stops being payable.
   *
   * Should track the reservation it belongs to. A link that outlives its hold
   * can take money for numbers that have already been released, and the buyer
   * gets `reservation_lost` — a real charge with no ticket and a human to
   * chase. Expressed as a moment; drivers convert to whatever unit they want.
   */
  expiresAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface CheckoutSession {
  reference: string;
  /** Send the buyer here to pay. */
  redirectUrl: string;
  /** Provider-side handle, stored for support and reconciliation. */
  providerRef: string | null;
}

/** Authoritative provider-side view of a payment. Never trust the client. */
export interface PaymentSnapshot {
  reference: string;
  state: PaymentState;
  amountMinor: number;
  currency: string;
  /**
   * Provider's own cut, deducted from what we collect. Escrow is therefore
   * LESS than the ticket total, and the ledger needs this to reconcile.
   */
  feeMinor: number | null;
  channel: string | null;
  paidAt: Date | null;
  providerRef: string | null;
  failureReason: string | null;
}

/**
 * Where a transfer actually has to land.
 *
 * Paystack took account details once and handed back an opaque recipient code,
 * so nothing outside the driver ever needed the number again. Moolre's transfer
 * endpoint takes the raw receiver on every single call, so the number has to
 * travel with the request.
 *
 * Optional because it is meaningless to a provider that holds its own
 * recipients: the Paystack driver ignores it entirely, and the Moolre driver
 * refuses the call without it rather than transferring to nowhere. Callers
 * decrypt it from storage at the last moment — see lib/payoutSecrets.ts.
 */
export interface TransferDestination {
  kind: "mobile_money" | "bank";
  accountNumber: string;
  bankCode: string;
}

export interface RefundRequest {
  /** Reference of the original payment. */
  paymentReference: string;
  /**
   * Our own reference for THIS refund, distinct from the payment's.
   *
   * Load-bearing for a provider that refunds by transferring back: the
   * transfer needs an idempotency key of its own, and reusing the payment's
   * would collide with the collection that already claimed it — leaving the
   * provider unable to tell a refund from the charge it reverses, and a status
   * lookup unable to say which one it is answering about.
   */
  refundReference: string;
  amountMinor: number;
  reason: string;
  /**
   * Required by providers that refund by transferring back rather than by
   * reversing the original charge. Moolre has no refund endpoint at all, so for
   * that driver a refund *is* an outbound transfer and this is mandatory.
   */
  destination?: TransferDestination;
}

export interface RefundSnapshot {
  providerRefundId: string | null;
  state: RefundState;
  amountMinor: number;
  /**
   * What the provider charged US to send this, where it says.
   *
   * Distinct from `PaymentSnapshot.feeMinor`, and the difference is the whole
   * reason both exist. A collection fee is deducted from what we receive, so
   * escrow holds less than the ticket total. An outbound fee is charged **on
   * top**: the recipient gets `amountMinor` and our balance drops by
   * `amountMinor + feeMinor`. Unbooked, that difference silently diverges our
   * cash from the provider's.
   *
   * Null where a provider does not report one; callers treat null as zero
   * rather than guessing a percentage.
   */
  feeMinor: number | null;
}

export interface RecipientRequest {
  /** Mobile money dominates in Ghana; bank accounts are the fallback. */
  kind: "mobile_money" | "bank";
  accountName: string;
  accountNumber: string;
  bankCode: string;
  currency: Currency;
}

export interface Recipient {
  /** Opaque handle we transfer to. We never store the full account number. */
  recipientCode: string;
  accountNumberLast4: string;
  /**
   * The name the provider holds for the account, when it returns one. Stored
   * as a snapshot so a seller can see which account they registered without
   * us keeping the number.
   */
  accountName: string | null;
}

/**
 * A destination a seller can be paid into.
 *
 * Fetched rather than hardcoded: the set of mobile money networks and banks
 * changes (Vodafone Cash became Telecel Cash in 2024), and a stale constant
 * would send a valid seller to a code the provider has stopped accepting.
 */
export interface PayoutBank {
  /** What `RecipientRequest.bankCode` must be set to. */
  code: string;
  name: string;
  kind: RecipientRequest["kind"];
}

export interface PayoutRequest {
  reference: string;
  amountMinor: number;
  /**
   * The provider's handle for the destination where there is one. Drivers
   * without a recipient concept derive this locally and need `destination`
   * as well — the code alone cannot be transferred to.
   */
  recipientCode: string;
  reason: string;
  destination?: TransferDestination;
}

export interface PayoutSnapshot {
  reference: string;
  providerRef: string | null;
  state: PayoutState;
  amountMinor: number;
  /** Charged on top of `amountMinor` — see `RefundSnapshot.feeMinor`. */
  feeMinor: number | null;
  failureReason: string | null;
}

/** A verified inbound provider event. */
export interface WebhookEnvelope {
  /**
   * Stable dedupe key. Paystack sends no delivery id, so drivers derive one
   * from the event type plus the entity reference.
   */
  eventId: string;
  eventType: string;
  payload: unknown;
}

export interface PaymentProvider {
  readonly name: ProviderName;

  /** Whether this driver moves real money. Guards refuse to mix the two. */
  readonly movesRealMoney: boolean;

  /**
   * Whether a transfer needs the destination account supplied with it.
   *
   * A capability rather than a provider check at the call sites, so services
   * never branch on a driver's name. It decides a real behavioural difference:
   * when true, onboarding has to retain the account number (encrypted) because
   * every payout and every refund will need it again; when false, the provider
   * holds the account itself and storing it here would be a liability for no
   * benefit.
   */
  readonly transfersNeedDestination: boolean;

  initiateCheckout(request: CheckoutRequest): Promise<CheckoutSession>;
  confirmPayment(reference: string): Promise<PaymentSnapshot>;
  refund(request: RefundRequest): Promise<RefundSnapshot>;
  createRecipient(request: RecipientRequest): Promise<Recipient>;
  /** Valid destinations of one kind, for the seller onboarding form. */
  listPayoutBanks(kind: RecipientRequest["kind"]): Promise<PayoutBank[]>;
  payout(request: PayoutRequest): Promise<PayoutSnapshot>;

  /**
   * Re-reads a payout or refund that was last seen in flight.
   *
   * Not a convenience. A provider that reports a transfer as `processing` and
   * sends no webhook for its completion leaves the row stranded forever, since
   * the sweep deliberately will not re-send a PROCESSING payout (that would
   * risk paying twice). Polling is the only thing that can settle it, so every
   * driver must answer this even when its own webhook usually gets there first.
   *
   * Keyed on OUR reference, never the provider's, so it works for a transfer
   * whose response never reached us.
   */
  checkPayoutStatus(reference: string): Promise<PayoutSnapshot>;
  /**
   * Takes both keys because providers disagree about which one identifies a
   * refund: one keyed by its own id, the other by the reference we chose. A
   * driver uses whichever it issued and ignores the other.
   */
  checkRefundStatus(args: {
    refundReference: string;
    providerRefundId: string | null;
  }): Promise<RefundSnapshot>;

  /**
   * Verifies a raw request body against its signature headers.
   * Returns null when the signature does not match — callers must treat null
   * as hostile and record nothing.
   */
  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookEnvelope | null;
}

/** Raised for provider-side failures, separating retryable from terminal. */
export class PaymentProviderError extends Error {
  readonly provider: ProviderName;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly providerMessage: string | null;
  /**
   * The provider's own result code, where it sends one.
   *
   * Needed because an HTTP status cannot distinguish the two refusals that
   * matter most: "this account does not exist" (a real validation result worth
   * showing a seller) and "this endpoint is not answering for you" (an
   * integration problem that must not be reported as a bad account number).
   * Both arrive as HTTP 200 with a failure body.
   */
  readonly providerCode: string | null;

  constructor(
    provider: ProviderName,
    message: string,
    options: {
      retryable?: boolean;
      status?: number | null;
      providerMessage?: string | null;
      providerCode?: string | null;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "PaymentProviderError";
    this.provider = provider;
    this.retryable = options.retryable ?? false;
    this.status = options.status ?? null;
    this.providerMessage = options.providerMessage ?? null;
    this.providerCode = options.providerCode ?? null;
  }
}
