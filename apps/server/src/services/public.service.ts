import { Inject, Injectable } from "@nestjs/common";
import type { BillingInterval } from "@murmur/account-api";
import { plansFor } from "@murmur/account-api";
import { Clock } from "../common/clock.ts";
import { hashSecret, normalizeInviteToken } from "../common/crypto.ts";
import { apiError } from "../common/errors.ts";
import { RateLimiter } from "../common/rate-limiter.ts";
import type { AppConfig } from "../config/env.ts";
import { canonicalEmail } from "../domain/email.ts";
import { PrismaService } from "../prisma/prisma.service.ts";
import { CONFIG } from "../tokens.ts";

const REFERRAL_CODE = /^[A-Z0-9]{4,20}$/;

/**
 * What the marketing website may ask without signing in. Nothing here returns an email address
 * or anything about a person beyond what the page needs to render: a referrer's first name (if
 * they set one) and a team's name (only for a valid, unexpired invite token).
 */
@Injectable()
export class PublicService {
  private readonly config: AppConfig;
  private readonly prisma: PrismaService;
  private readonly clock: Clock;
  private readonly limiter: RateLimiter;

  constructor(
    @Inject(CONFIG) config: AppConfig,
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(Clock) clock: Clock,
    @Inject(RateLimiter) limiter: RateLimiter,
  ) {
    this.config = config;
    this.prisma = prisma;
    this.clock = clock;
    this.limiter = limiter;
  }

  private limit(
    key: string,
    rule: { max: number; windowMs: number },
    message = "Too many requests. Try again later.",
  ) {
    if (!this.limiter.hit(key, rule.max, rule.windowMs).allowed) {
      throw apiError("rate-limited", message);
    }
  }

  plans(interval: BillingInterval, ip: string) {
    this.limit(`public-read:${ip}`, this.config.limits.publicRead);
    return plansFor(interval);
  }

  async referral(
    rawCode: string,
    ip: string,
  ): Promise<{ valid: boolean; firstName?: string }> {
    this.limit(`public-lookup:${ip}`, this.config.limits.publicLookup);
    const code = rawCode.trim().toUpperCase();
    if (!REFERRAL_CODE.test(code)) return { valid: false };
    const user = await this.prisma.user.findUnique({
      where: { referralCode: code },
      select: { firstName: true },
    });
    if (!user) return { valid: false };
    // Only the first name, and only if the person set one: the gift page says "Gifted by <name>".
    // Never the last name or the address. Guessing codes is what the lookup limit above stops.
    const firstName = user.firstName.trim();
    return firstName ? { valid: true, firstName } : { valid: true };
  }

  async invite(
    rawToken: string,
    ip: string,
  ): Promise<{ valid: boolean; teamName?: string; expired?: boolean }> {
    this.limit(`public-lookup:${ip}`, this.config.limits.publicLookup);
    const token = normalizeInviteToken(rawToken);
    if (token.length < 8 || token.length > 64) return { valid: false };
    const invite = await this.prisma.teamInvite.findUnique({
      where: { tokenHash: hashSecret(this.config.pepper, "invite", token) },
      select: {
        status: true,
        expiresAt: true,
        team: { select: { name: true } },
      },
    });
    if (!invite || invite.status !== "pending") return { valid: false };
    if (invite.expiresAt <= this.clock.now()) {
      return { valid: false, expired: true };
    }
    return { valid: true, teamName: invite.team.name };
  }

  async joinWaitlist(
    email: string,
    source: string | undefined,
    ip: string,
  ): Promise<{ ok: true }> {
    this.limit(
      `waitlist:${ip}`,
      this.config.limits.waitlistPerIpDaily,
      "Too many sign-ups from here today. Try again tomorrow.",
    );
    await this.prisma.waitlistEntry.createMany({
      data: [
        {
          emailHash: hashSecret(
            this.config.pepper,
            "waitlist",
            canonicalEmail(email),
          ),
          email,
          source: source ?? "web",
        },
      ],
      // A repeat (or the same address with a +tag) changes nothing and answers the same.
      skipDuplicates: true,
    });
    return { ok: true };
  }
}
