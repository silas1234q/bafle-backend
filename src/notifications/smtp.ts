import nodemailer, { type NodemailerError } from "nodemailer";
import {
  EmailProviderError,
  type EmailMessage,
  type EmailProvider,
  type EmailResult,
} from "./provider.js";

/**
 * Gmail's relay, because this driver was added to get email working at no
 * cost: a Google account plus an App Password sends real mail with no signup,
 * no domain and no card. Host and port are still env-driven, so pointing this
 * at Brevo's or anyone else's SMTP relay later is config, not a code change.
 */
export const SMTP_DEFAULT_HOST = "smtp.gmail.com";
export const SMTP_DEFAULT_PORT = 465;

const TIMEOUT_MS = 15_000;

/**
 * Nodemailer error codes that will fail identically on every retry.
 *
 * `EAUTH` is the important one. A wrong App Password looks exactly like a
 * flaky network from the outside, so classifying it retryable would make the
 * queue back off and retry for hours over what is a one-line config fix — and
 * bury the real cause under attempt counts.
 */
const PERMANENT_CODES = new Set(["EAUTH", "ENOAUTH", "EENVELOPE", "ECONFIG"]);

type SmtpAddress = string | { name: string; address: string };

/**
 * The slice of a Nodemailer transporter this driver actually uses.
 *
 * Narrowed to one method so a test can inject a fake and assert the failure
 * classification below without standing up an SMTP server — the same reason
 * `BrevoProvider` takes an overridable `baseUrl`.
 */
export interface SmtpTransport {
  sendMail(message: {
    from: SmtpAddress;
    to: SmtpAddress;
    subject: string;
    text: string;
    html: string;
  }): Promise<{ messageId?: string | null }>;
}

export class SmtpProvider implements EmailProvider {
  readonly name = "smtp" as const;
  readonly delivers = true;

  private readonly fromEmail: string;
  private readonly fromName: string;
  private readonly transport: SmtpTransport;

  constructor(config: {
    user: string;
    pass: string;
    host?: string | null;
    port?: number | null;
    /**
     * Defaults to `user`. Gmail will not send as an address it has not
     * authenticated — it rewrites the header or rejects the message outright —
     * so a mismatch here is almost always a mistake. Left overridable because
     * other relays legitimately allow a different sender.
     */
    fromEmail?: string | null;
    fromName?: string | null;
    transport?: SmtpTransport;
  }) {
    this.fromEmail = config.fromEmail ?? config.user;
    this.fromName = config.fromName ?? "Bafle";

    const port = config.port ?? SMTP_DEFAULT_PORT;
    this.transport =
      config.transport ??
      nodemailer.createTransport({
        host: config.host ?? SMTP_DEFAULT_HOST,
        port,
        // Implicit TLS on 465, STARTTLS on anything else (587 being the other
        // port Gmail answers on). Derived from the port rather than taken as
        // its own setting: a `secure` that disagrees with the port hangs until
        // it times out, which reads like a network fault rather than the
        // config error it is.
        secure: port === 465,
        auth: { user: config.user, pass: config.pass },
        connectionTimeout: TIMEOUT_MS,
        greetingTimeout: TIMEOUT_MS,
        socketTimeout: TIMEOUT_MS,
      });
  }

  async send(message: EmailMessage): Promise<EmailResult> {
    try {
      const info = await this.transport.sendMail({
        from: { name: this.fromName, address: this.fromEmail },
        to: message.toName ? { name: message.toName, address: message.to } : message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });

      return { providerMessageId: info.messageId ?? null };
    } catch (error) {
      throw this.classify(error);
    }
  }

  /**
   * Decides whether the job runner should try again.
   *
   * Same stakes as the Brevo driver: `retryable` is what `sendNotification`
   * rethrows on, so getting it wrong either abandons a deliverable "you won"
   * email or retries an impossible one forever.
   */
  private classify(error: unknown): EmailProviderError {
    const err = (error ?? {}) as NodemailerError;
    const status = typeof err.responseCode === "number" ? err.responseCode : null;
    const detail = (err.response ?? err.message ?? "unknown error").slice(0, 300);

    // Nodemailer sets `permanent` from the reply class whenever the server
    // actually answered, and it already handles the case a bare 4xx/5xx split
    // gets wrong: 503 is a 5xx but means "bad sequence of commands", so the
    // same message succeeds on a fresh connection. Trust it where it exists
    // rather than re-deriving it worse.
    if (typeof err.permanent === "boolean") {
      return new EmailProviderError(this.name, `SMTP rejected the message: ${detail}`, {
        retryable: !err.permanent,
        status,
        cause: error,
      });
    }

    // No SMTP reply at all: the connection failed, timed out, or the message
    // never reached the wire. Retryable unless the code says the configuration
    // itself is wrong.
    const code = typeof err.code === "string" ? err.code : "";
    return new EmailProviderError(
      this.name,
      `SMTP send failed${code ? ` (${code})` : ""}: ${detail}`,
      { retryable: !PERMANENT_CODES.has(code), status, cause: error },
    );
  }
}
