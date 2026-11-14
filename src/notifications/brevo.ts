import {
  EmailProviderError,
  type EmailMessage,
  type EmailProvider,
  type EmailResult,
} from "./provider.js";

const API_URL = "https://api.brevo.com/v3/smtp/email";
const TIMEOUT_MS = 15_000;

/**
 * Brevo driver.
 *
 * Chosen over Resend specifically because Resend's free tier will only deliver
 * to the account owner's own address until a custom domain is DNS-verified,
 * which would make winner notifications impossible without buying a domain.
 * Brevo verifies a single sender with a code emailed to it, so a plain Gmail
 * address works.
 */
export class BrevoProvider implements EmailProvider {
  readonly name = "brevo" as const;
  readonly delivers = true;

  private readonly apiKey: string;
  private readonly fromEmail: string;
  private readonly fromName: string;
  private readonly baseUrl: string;

  constructor(config: {
    apiKey: string;
    fromEmail: string;
    fromName?: string;
    baseUrl?: string;
  }) {
    this.apiKey = config.apiKey;
    this.fromEmail = config.fromEmail;
    this.fromName = config.fromName ?? "Bafle";
    this.baseUrl = config.baseUrl ?? API_URL;
  }

  async send(message: EmailMessage): Promise<EmailResult> {
    let response: Response;
    try {
      response = await fetch(this.baseUrl, {
        method: "POST",
        headers: {
          "api-key": this.apiKey,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          sender: { email: this.fromEmail, name: this.fromName },
          to: [{ email: message.to, ...(message.toName ? { name: message.toName } : {}) }],
          subject: message.subject,
          textContent: message.text,
          htmlContent: message.html,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      // Network or timeout: worth another attempt from the job runner.
      throw new EmailProviderError(this.name, "Brevo request did not complete", {
        retryable: true,
        cause: error,
      });
    }

    const body = await response.text();

    if (!response.ok) {
      // 4xx is a bad address or a rejected sender and will fail identically on
      // retry; 429 and 5xx are worth retrying.
      const retryable = response.status === 429 || response.status >= 500;
      throw new EmailProviderError(
        this.name,
        `Brevo rejected the message with ${response.status}: ${body.slice(0, 300)}`,
        { retryable, status: response.status },
      );
    }

    let messageId: string | null = null;
    try {
      const parsed = JSON.parse(body) as { messageId?: unknown };
      if (typeof parsed.messageId === "string") messageId = parsed.messageId;
    } catch {
      // A 2xx with an unparseable body still means it was accepted.
    }

    return { providerMessageId: messageId };
  }
}
