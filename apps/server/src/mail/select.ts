import type { AppConfig } from "../config/env.ts";
import { CompositeMailer } from "./composite.mailer.ts";
import type { Mailer } from "./mailer.ts";
import { SmtpMailer } from "./smtp.mailer.ts";

/**
 * Chooses the mailer. An explicit override wins. Otherwise SMTP when configured (in development
 * also written to the dev outbox), else the dev outbox alone. Production never gets the outbox.
 */
export function selectMailer(
  config: Pick<AppConfig, "production" | "smtp">,
  override: Mailer | undefined,
  devOutbox: Mailer,
  createSmtp: (smtp: NonNullable<AppConfig["smtp"]>) => Mailer = (c) =>
    new SmtpMailer(c),
): Mailer {
  if (override) return override;
  const smtp = config.smtp ? createSmtp(config.smtp) : undefined;
  if (config.production) {
    if (!smtp) {
      throw new Error(
        "No email provider is configured. Set MURMUR_SMTP_USER and MURMUR_SMTP_PASS (the development outbox mailer is not allowed in production).",
      );
    }
    return smtp;
  }
  return smtp ? new CompositeMailer(devOutbox, smtp) : devOutbox;
}
