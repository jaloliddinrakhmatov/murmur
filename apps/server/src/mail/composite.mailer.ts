import type { EmailMessage, Mailer } from "./mailer.ts";

/** Development: keep every email in the dev outbox, then also send it for real. */
export class CompositeMailer implements Mailer {
  readonly delivery = "email" as const;
  private readonly first: Mailer;
  private readonly second: Mailer;
  constructor(first: Mailer, second: Mailer) {
    this.first = first;
    this.second = second;
  }

  async send(message: EmailMessage): Promise<void> {
    await this.first.send(message);
    await this.second.send(message);
  }
}
