export type EmailKind =
  "sign-in-code" | "team-invite" | "referral-invite" | "test";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  kind: EmailKind;
  /** The sign-in code or invite token inside the message. Only the dev outbox keeps it. */
  secret?: string;
  /** The code as shown to the reader; the HTML version prints it large. */
  highlight?: string;
}

/**
 * Sends email: DevOutboxMailer (development) or SmtpMailer. A failed send throws an ApiError
 * ("server-error", 502) that reaches the client as is. Chosen in mail/select.ts.
 */
export interface Mailer {
  /** Where mail really goes: "email" (default) or only the development "outbox". */
  readonly delivery?: "email" | "outbox";
  send(message: EmailMessage): Promise<void>;
}
