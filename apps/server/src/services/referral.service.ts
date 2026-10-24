import { Inject, Injectable } from "@nestjs/common";
import { RULES } from "@murmur/account-api";
import { Clock } from "../common/clock.ts";
import { apiError } from "../common/errors.ts";
import { plainForEmail } from "../common/text.ts";
import { RateLimiter } from "../common/rate-limiter.ts";
import { REFERRAL_ANTI_FARMING } from "../config/env.ts";
import type { AppConfig } from "../config/env.ts";
import { addDays } from "../domain/dates.ts";
import {
  referralLabel,
  shouldReward,
  visibleWords,
} from "../domain/referral.ts";
import type { Mailer } from "../mail/mailer.ts";
import { PrismaService } from "../prisma/prisma.service.ts";
import type { Prisma } from "../prisma/prisma.service.ts";
import { CONFIG, MAILER } from "../tokens.ts";
import { addCreditMonths, lockUser } from "./credit.ts";
import { addressHash, claimTombstone, hasTombstone } from "./tombstone.ts";
import { MeService } from "./me.service.ts";
import { PlanService } from "./plan.service.ts";
import type { MeView, ReferralsView } from "./types.ts";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

@Injectable()
export class ReferralService {
  private readonly config: AppConfig;
  private readonly prisma: PrismaService;
  private readonly clock: Clock;
  private readonly limiter: RateLimiter;
  private readonly mailer: Mailer;
  private readonly plans: PlanService;
  private readonly me: MeService;

  constructor(
    @Inject(CONFIG) config: AppConfig,
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(Clock) clock: Clock,
    @Inject(RateLimiter) limiter: RateLimiter,
    @Inject(MAILER) mailer: Mailer,
    @Inject(PlanService) plans: PlanService,
    @Inject(MeService) me: MeService,
  ) {
    this.config = config;
    this.prisma = prisma;
    this.clock = clock;
    this.limiter = limiter;
    this.mailer = mailer;
    this.plans = plans;
    this.me = me;
  }

  private link(code: string) {
    return `${this.config.publicUrl}/r/${code}`;
  }

  async list(userId: string): Promise<ReferralsView> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { referralAsReferee: true },
    });
    const made = await this.prisma.referral.findMany({
      where: { referrerId: userId },
      include: {
        referee: { select: { id: true, firstName: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    const sums = made.length
      ? await this.prisma.usage.groupBy({
          by: ["userId"],
          where: { userId: { in: made.map((r) => r.refereeId) } },
          _sum: { words: true },
        })
      : [];
    const words = new Map(sums.map((s) => [s.userId, s._sum.words ?? 0]));
    const synced = await this.plans.sync(userId);
    return {
      code: user.referralCode,
      link: this.link(user.referralCode),
      referrals: made.map((r) => ({
        id: r.id,
        label: referralLabel(r.referee.firstName, r.referee.email),
        status: r.status as "signed-up" | "qualified" | "rewarded",
        words:
          r.status === "rewarded"
            ? RULES.referralRewardWords
            : visibleWords(words.get(r.refereeId) ?? 0),
        createdAt: r.createdAt.toISOString(),
        rewardedAt: r.rewardedAt ? r.rewardedAt.toISOString() : null,
      })),
      applied: user.referralAsReferee
        ? {
            code: user.referralAsReferee.code,
            at: user.referralAsReferee.createdAt.toISOString(),
          }
        : null,
      creditMonths: synced.creditMonths,
    };
  }

  async apply(userId: string, code: string): Promise<MeView> {
    const now = this.clock.now();
    const pep = this.config.pepper;
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { referralAsReferee: true },
    });
    if (user.referralAsReferee) {
      throw apiError(
        "referral-already-applied",
        "You've already used a referral code",
      );
    }
    if (code === user.referralCode) {
      throw apiError(
        "referral-own-code",
        "You can't use your own referral code",
      );
    }
    if (addDays(user.createdAt, RULES.referralApplyWindowDays) <= now) {
      throw apiError(
        "referral-too-late",
        `Referral codes can only be added in the first ${RULES.referralApplyWindowDays} days`,
      );
    }
    const referrer = await this.prisma.user.findUnique({
      where: { referralCode: code },
    });
    if (!referrer)
      throw apiError("not-found", "That referral code doesn't exist");
    // The same person under another alias (a+1@gmail.com, j.doe@gmail.com) is still "you".
    if (addressHash(pep, referrer.email) === addressHash(pep, user.email)) {
      throw apiError(
        "referral-own-code",
        "You can't use your own referral code",
      );
    }
    // Mutual referrals: the code's owner joined with your code.
    const mutual = await this.prisma.referral.findFirst({
      where: { referrerId: userId, refereeId: referrer.id },
    });
    if (mutual) {
      throw apiError(
        "conflict",
        "That person joined Murmur with your code, so you can't use theirs",
      );
    }

    const alreadyApplied = () =>
      apiError(
        "referral-already-applied",
        "You've already used a referral code",
      );
    try {
      await this.prisma.$transaction(async (tx) => {
        // Once per person, even after deleting the account and signing up again.
        if (!(await claimTombstone(tx, pep, user.email, "referredAt", now))) {
          throw alreadyApplied();
        }
        await tx.referral.create({
          data: { referrerId: referrer.id, refereeId: userId, code },
        });
        await addCreditMonths(tx, userId, RULES.referralRewardMonths, now);
        // Words reported before the code was applied count too.
        await this.rewardIfQualified(tx, userId, now);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw alreadyApplied();
      throw error;
    }
    return this.me.get(userId);
  }

  async invite(userId: string, rawEmails: string[]): Promise<{ sent: number }> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const emails = [...new Set(rawEmails)].filter((e) => e !== user.email);
    if (emails.length === 0) return { sent: 0 };
    const r = this.config.limits.invitesPerDay;
    const d = this.limiter.hitMany(
      `invites:${userId}`,
      emails.length,
      r.max,
      r.windowMs,
    );
    if (!d.allowed) {
      throw apiError(
        "rate-limited",
        "You've sent too many invitations today. Try again tomorrow.",
      );
    }
    const sender = plainForEmail(user.firstName) || "A friend";
    for (const to of emails) {
      await this.mailer.send({
        to,
        kind: "referral-invite",
        subject: "You've been invited to try Murmur",
        text: `${sender} thinks you'd like Murmur, dictation that works in any app.\n\nYour referral code: ${user.referralCode}\n\nAfter you sign up: open Murmur, choose "Get a free month", then "Apply referral", and paste the code. Do it within ${RULES.referralApplyWindowDays} days of signing up to get ${RULES.referralRewardMonths} month of Pro free.`,
        highlight: user.referralCode,
      });
    }
    return { sent: emails.length };
  }

  /**
   * Pays the referrer once, when the friend's total reported words reach the threshold.
   * Safe to call any number of times: the status flip is a conditional update, so the
   * credit month is granted exactly once even under concurrent calls.
   */
  async rewardIfQualified(
    tx: Prisma.TransactionClient,
    refereeId: string,
    now: Date,
  ) {
    const referral = await tx.referral.findUnique({
      where: { refereeId },
      include: { referee: { select: { email: true, createdAt: true } } },
    });
    if (!referral || referral.status === "rewarded") return;
    const pep = this.config.pepper;
    const usage = await tx.usage.aggregate({
      where: { userId: refereeId },
      _sum: { words: true },
    });
    const activeDays = await tx.usage.count({
      where: { userId: refereeId, words: { gt: 0 } },
    });
    // Serializes this referrer's payouts, so the yearly cap can't be beaten by parallel reports.
    await lockUser(tx, referral.referrerId);
    const yearAgo = new Date(now.getTime() - 365 * 86_400_000);
    const referrerRewardsThisYear = await tx.referral.count({
      where: {
        referrerId: referral.referrerId,
        status: "rewarded",
        rewardedAt: { gt: yearAgo },
      },
    });
    if (
      !shouldReward(
        {
          status: referral.status,
          totalWords: usage._sum.words ?? 0,
          activeDays,
          accountAgeMs: now.getTime() - referral.referee.createdAt.getTime(),
          referrerRewardsThisYear,
          alreadyPaidForAddress: await hasTombstone(
            tx,
            pep,
            referral.referee.email,
            "rewardPaidAt",
          ),
        },
        REFERRAL_ANTI_FARMING,
      )
    )
      return;
    // First claim wins; a concurrent report for the same address waits here, then finds it taken.
    if (
      !(await claimTombstone(
        tx,
        pep,
        referral.referee.email,
        "rewardPaidAt",
        now,
      ))
    )
      return;
    const flipped = await tx.referral.updateMany({
      where: { id: referral.id, status: { not: "rewarded" } },
      data: { status: "rewarded", rewardedAt: now },
    });
    if (flipped.count === 1) {
      await addCreditMonths(
        tx,
        referral.referrerId,
        RULES.referralRewardMonths,
        now,
      );
    }
  }
}
