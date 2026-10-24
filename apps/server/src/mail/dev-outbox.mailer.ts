import { Inject, Injectable, Logger } from "@nestjs/common";
import { maskEmail } from "../common/mask.ts";
import { PrismaService } from "../prisma/prisma.service.ts";
import type { EmailMessage, Mailer } from "./mailer.ts";

/** Development mailer: stores the email in the OutboxEmail table instead of sending it. */
@Injectable()
export class DevOutboxMailer implements Mailer {
  readonly delivery = "outbox" as const;
  private readonly logger = new Logger("Mailer");
  private readonly prisma: PrismaService;

  constructor(@Inject(PrismaService) prisma: PrismaService) {
    this.prisma = prisma;
  }

  async send(message: EmailMessage): Promise<void> {
    await this.prisma.outboxEmail.create({
      data: {
        to: message.to,
        subject: message.subject,
        body: message.text,
        kind: message.kind,
        code: message.secret ?? null,
      },
    });
    this.logger.log(
      `email queued to ${maskEmail(message.to)} (${message.kind})`,
    );
  }
}
