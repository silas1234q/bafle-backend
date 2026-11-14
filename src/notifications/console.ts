import type { EmailMessage, EmailProvider, EmailResult } from "./provider.js";

/**
 * Development driver. Logs instead of sending.
 *
 * `delivers` is false, and the production guard refuses to boot with it, so a
 * deployment can never silently swallow every notification while reporting
 * success.
 */
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = "console" as const;
  readonly delivers = false;

  send(message: EmailMessage): Promise<EmailResult> {
    console.log(
      `[email:console] to=${message.to} subject="${message.subject}"\n${message.text}`,
    );
    return Promise.resolve({ providerMessageId: null });
  }
}
