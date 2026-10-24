import { Logger } from "@nestjs/common";
import { createTransport } from "nodemailer";
import { apiError } from "../common/errors.ts";
import { maskEmail } from "../common/mask.ts";
import { renderHtml } from "./html.ts";
import type { EmailMessage, Mailer } from "./mailer.ts";
import type { SmtpConfig } from "./smtp.config.ts";

export const MAIL_FAILED_MESSAGE =
  "Couldn't send the email. Try again in a minute.";

/** The part of a nodemailer transport that SmtpMailer uses (tests pass a fake). */
export interface SmtpTransport {
  verify(): Promise<unknown>;
  sendMail(mail: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<unknown>;
}

// A connection that timed out or was refused (a blocked port, a firewall) won't work a second
// later, and retrying doubles the wait past the app's request timeout; only failures after the
// connection was made are worth one more try.
const TRANSIENT_CODES = new Set(["ESOCKET", "ECONNRESET", "EDNS", "EAI_AGAIN"]);

/** Timeouts, dropped connections and 4xx replies are worth one more try; bad logins are not. */
export function isTransient(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, responseCode } = error as {
    code?: unknown;
    responseCode?: unknown;
  };
  if (typeof responseCode === "number") {
    return responseCode >= 400 && responseCode < 500;
  }
  return typeof code === "string" && TRANSIENT_CODES.has(code);
}

export function createSmtpTransport(config: SmtpConfig): SmtpTransport {
  return createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: true,
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    auth: { user: config.user, pass: config.pass },
    connectionTimeout: 8_000,
    greetingTimeout: 8_000,
    socketTimeout: 20_000,
    pool: true,
    maxConnections: 2,
  });
}

/** Sends real email over SMTP (Gmail with an app password, or any provider's SMTP). */
export class SmtpMailer implements Mailer {
  readonly delivery = "email" as const;
  private readonly logger = new Logger("Mailer");
  private readonly config: SmtpConfig;
  private readonly transport: SmtpTransport;
  private readonly retryDelayMs: number;
  private verified = false;

  constructor(
    config: SmtpConfig,
    transport: SmtpTransport = createSmtpTransport(config),
    retryDelayMs = 1_000,
  ) {
    this.config = config;
    this.transport = transport;
    this.retryDelayMs = retryDelayMs;
  }

  async send(message: EmailMessage): Promise<void> {
    const to = maskEmail(message.to);
    try {
      try {
        await this.attempt(message);
      } catch (error) {
        if (!isTransient(error)) throw error;
        await new Promise((r) => setTimeout(r, this.retryDelayMs));
        await this.attempt(message);
      }
    } catch (error) {
      // Names and codes only: SMTP replies can echo the address or the login.
      const detail =
        typeof error === "object" && error !== null
          ? ((error as { code?: unknown }).code ??
            (error as { responseCode?: unknown }).responseCode ??
            (error as { name?: unknown }).name)
          : undefined;
      this.logger.error(
        `email to ${to} failed (${message.kind}${typeof detail === "string" || typeof detail === "number" ? `, ${detail}` : ""})`,
      );
      throw apiError("server-error", MAIL_FAILED_MESSAGE, 502);
    }
    this.logger.log(`email sent to ${to} (${message.kind})`);
  }

  private async attempt(message: EmailMessage) {
    if (!this.verified) {
      await this.transport.verify();
      this.verified = true;
      this.logger.log(`SMTP connection to ${this.config.host} verified`);
    }
    await this.transport.sendMail({
      from: this.config.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: renderHtml(message.text, message.highlight),
    });
  }
}
