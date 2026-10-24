import { Controller, Get, Inject, Query } from "@nestjs/common";
import { z } from "zod";
import { Public } from "../common/auth.ts";
import { ZodPipe } from "../common/zod.pipe.ts";
import { PrismaService } from "../prisma/prisma.service.ts";

const OutboxQuery = z.object({
  to: z.string().trim().toLowerCase().max(254).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** Registered only when MURMUR_DEV_OUTBOX=1 and not in production (see app.module.ts). */
@Controller("v1/dev")
export class DevController {
  private readonly prisma: PrismaService;
  constructor(@Inject(PrismaService) prisma: PrismaService) {
    this.prisma = prisma;
  }

  @Public()
  @Get("outbox")
  async outbox(
    @Query(new ZodPipe(OutboxQuery)) q: z.output<typeof OutboxQuery>,
  ) {
    const rows = await this.prisma.outboxEmail.findMany({
      where: q.to ? { to: q.to } : {},
      orderBy: { createdAt: "desc" },
      take: q.limit,
    });
    return {
      emails: rows.map((r) => ({
        id: r.id,
        to: r.to,
        subject: r.subject,
        kind: r.kind,
        code: r.code,
        body: r.body,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }
}
