import { Inject, Injectable } from "@nestjs/common";
import { Clock } from "../common/clock.ts";
import { apiError } from "../common/errors.ts";
import { addDays } from "../domain/dates.ts";
import { PrismaService } from "../prisma/prisma.service.ts";
import { ReferralService } from "./referral.service.ts";

/** Accepted range for a reported day, relative to now (clients report their local date). */
const MAX_DAYS_BACK = 31;
const MAX_DAYS_AHEAD = 2;

@Injectable()
export class UsageService {
  private readonly prisma: PrismaService;
  private readonly clock: Clock;
  private readonly referrals: ReferralService;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(Clock) clock: Clock,
    @Inject(ReferralService) referrals: ReferralService,
  ) {
    this.prisma = prisma;
    this.clock = clock;
    this.referrals = referrals;
  }

  /** Keeps the largest word count reported for the day (idempotent), then checks referrals. */
  async report(userId: string, day: string, words: number) {
    const now = this.clock.now();
    const parsed = new Date(`${day}T00:00:00.000Z`);
    if (
      Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== day
    ) {
      throw apiError("bad-request", "day: not a real calendar date");
    }
    if (
      parsed < addDays(now, -MAX_DAYS_BACK) ||
      parsed > addDays(now, MAX_DAYS_AHEAD)
    ) {
      throw apiError("bad-request", "day: too far from today");
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "Usage" ("userId", "day", "words") VALUES (${userId}, ${day}, ${words})
        ON CONFLICT ("userId", "day") DO UPDATE SET "words" = GREATEST("Usage"."words", EXCLUDED."words")`;
      await this.referrals.rewardIfQualified(tx, userId, now);
    });
  }
}
