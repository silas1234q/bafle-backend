import { env } from "../env.js";
import { BrevoProvider } from "./brevo.js";
import { ConsoleEmailProvider } from "./console.js";
import { SmtpProvider } from "./smtp.js";
import type { EmailProvider } from "./provider.js";

export * from "./provider.js";
export * from "./templates.js";
export { SmtpProvider } from "./smtp.js";

let instance: EmailProvider | null = null;

/**
 * The active email driver.
 *
 * Lazy, like the payment provider: missing email config must not stop the API
 * from booting during development.
 */
export function emailProvider(): EmailProvider {
  if (instance) return instance;

  switch (env.EMAIL_PROVIDER) {
    case "brevo": {
      if (!env.BREVO_API_KEY) {
        throw new Error(
          "EMAIL_PROVIDER=brevo but BREVO_API_KEY is not set. " +
            "Create a free Brevo account and verify a sender address.",
        );
      }
      if (!env.EMAIL_FROM) {
        throw new Error(
          "EMAIL_PROVIDER=brevo but EMAIL_FROM is not set. It must be the " +
            "sender address you verified with Brevo, or every send is rejected.",
        );
      }
      instance = new BrevoProvider({
        apiKey: env.BREVO_API_KEY,
        fromEmail: env.EMAIL_FROM,
        fromName: env.EMAIL_FROM_NAME ?? "Bafle",
      });
      return instance;
    }

    case "smtp": {
      if (!env.SMTP_USER || !env.SMTP_PASS) {
        throw new Error(
          "EMAIL_PROVIDER=smtp but SMTP_USER/SMTP_PASS are not both set. For " +
            "Gmail, SMTP_PASS must be a 16-character App Password from " +
            "Google account Security > 2-Step Verification > App passwords; " +
            "the account password itself will not authenticate, and Google " +
            "removed plain-password SMTP in 2022.",
        );
      }
      instance = new SmtpProvider({
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        // Unlike Brevo, an unset EMAIL_FROM is not fatal here: the driver
        // falls back to the authenticated mailbox, which is the only sender
        // Gmail would have accepted anyway.
        fromEmail: env.EMAIL_FROM,
        fromName: env.EMAIL_FROM_NAME,
      });
      return instance;
    }

    case "console": {
      instance = new ConsoleEmailProvider();
      return instance;
    }
  }
}

/** Replaces the cached driver. Tests only. */
export function setEmailProviderForTesting(provider: EmailProvider | null): void {
  instance = provider;
}

/** For /health, so a deployment that cannot email is visible. */
export function emailProviderStatus(): {
  provider: string;
  configured: boolean;
  delivers: boolean | null;
} {
  try {
    const provider = emailProvider();
    return { provider: provider.name, configured: true, delivers: provider.delivers };
  } catch {
    return { provider: env.EMAIL_PROVIDER, configured: false, delivers: null };
  }
}
