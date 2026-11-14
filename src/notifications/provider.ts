/**
 * The boundary between Bafle and whoever delivers email.
 *
 * Same reasoning as the payment layer: kept narrow and domain-shaped so a
 * second provider drops in without touching the raffle or order code. Email
 * providers are swapped often — for deliverability, for pricing, or because a
 * free tier changes its rules.
 */

export type EmailProviderName = "brevo" | "console" | "smtp";

export interface EmailMessage {
  to: string;
  /** Shown instead of the bare address where the client supports it. */
  toName?: string | null;
  subject: string;
  text: string;
  html: string;
}

export interface EmailResult {
  /** Provider-side id, kept for support requests. */
  providerMessageId: string | null;
}

export interface EmailProvider {
  readonly name: EmailProviderName;
  /** False for drivers that only log, so guards can refuse them in production. */
  readonly delivers: boolean;
  send(message: EmailMessage): Promise<EmailResult>;
}

export class EmailProviderError extends Error {
  readonly provider: EmailProviderName;
  readonly retryable: boolean;
  readonly status: number | null;

  constructor(
    provider: EmailProviderName,
    message: string,
    options: { retryable?: boolean; status?: number | null; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "EmailProviderError";
    this.provider = provider;
    this.retryable = options.retryable ?? false;
    this.status = options.status ?? null;
  }
}
