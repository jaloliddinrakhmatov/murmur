import { Inject, Injectable, Logger } from "@nestjs/common";
import { RULES } from "@murmur/account-api";
import type { z } from "zod";
import type { DeviceSchema } from "@murmur/account-api";
import { Clock } from "../common/clock.ts";
import {
  decryptSecret,
  encryptSecret,
  hashSecret,
  randomSignInCode,
  safeEqual,
} from "../common/crypto.ts";
import { apiError } from "../common/errors.ts";
import { maskEmail } from "../common/mask.ts";
import { RateLimiter } from "../common/rate-limiter.ts";
import type { AppConfig } from "../config/env.ts";
import { addressHash } from "./tombstone.ts";
import { referralCodeCandidate } from "../domain/referral.ts";
import type { Mailer } from "../mail/mailer.ts";
import { PrismaService } from "../prisma/prisma.service.ts";
import { CONFIG, MAILER } from "../tokens.ts";
import { MeService } from "./me.service.ts";
import { TokenService } from "./token.service.ts";

type Device = z.infer<typeof DeviceSchema>;

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger("Auth");
  private readonly config: AppConfig;
  private readonly prisma: PrismaService;
  private readonly clock: Clock;
  private readonly limiter: RateLimiter;
  private readonly mailer: Mailer;
  private readonly tokens: TokenService;
  private readonly me: MeService;

  constructor(
    @Inject(CONFIG) config: AppConfig,
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(Clock) clock: Clock,
    @Inject(RateLimiter) limiter: RateLimiter,
    @Inject(MAILER) mailer: Mailer,
    @Inject(TokenService) tokens: TokenService,
    @Inject(MeService) me: MeService,
  ) {
    this.config = config;
    this.prisma = prisma;
    this.clock = clock;
    this.limiter = limiter;
    this.mailer = mailer;
    this.tokens = tokens;
    this.me = me;
  }

  private codeHash(email: string, code: string) {
    return hashSecret(this.config.pepper, `code:${email}`, code);
  }

  private limit(key: string, rule: { max: number; windowMs: number }) {
    const d = this.limiter.hit(key, rule.max, rule.windowMs);
    if (!d.allowed) {
      throw apiError(
        "rate-limited",
        `Too many attempts. Try again in ${Math.max(1, Math.ceil(d.retryAfterMs / 60_000))} minutes.`,
      );
    }
  }

  /**
   * Daily cap per normalized address, persisted so restarts don't reset it, with exponential
   * backoff once `after` attempts were made. Blocked attempts are not recorded. The advisory lock
   * serializes parallel attempts for the same address.
   */
  private async dailyGate(
    email: string,
    kind: "start" | "verify",
    rule: { max: number; windowMs: number },
    backoff: { after: number; baseMs: number; maxMs: number },
  ) {
    const now = this.clock.now();
    const key = addressHash(this.config.pepper, email);
    const since = new Date(now.getTime() - rule.windowMs);
    const waitMs = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${kind}:${key}`}, 0))`;
      await tx.authAttempt.deleteMany({
        where: { emailHash: key, kind, at: { lt: since } },
      });
      const recent = await tx.authAttempt.findMany({
        where: { emailHash: key, kind },
        orderBy: { at: "asc" },
        select: { at: true },
      });
      let wait = 0;
      if (recent.length >= rule.max) {
        wait = recent[0].at.getTime() + rule.windowMs - now.getTime();
      } else if (recent.length >= backoff.after) {
        const gap = Math.min(
          backoff.baseMs * 2 ** (recent.length - backoff.after),
          backoff.maxMs,
        );
        wait = recent[recent.length - 1].at.getTime() + gap - now.getTime();
      }
      if (wait > 0) return wait;
      await tx.authAttempt.create({ data: { emailHash: key, kind, at: now } });
      return 0;
    });
    if (waitMs > 0) {
      throw apiError(
        "rate-limited",
        `Too many attempts. Try again in ${Math.max(1, Math.ceil(waitMs / 60_000))} minutes.`,
      );
    }
  }

  /** Always answers the same, whether or not the account exists. */
  async start(email: string, ip: string) {
    const l = this.config.limits;
    this.limit(`start:ip:${ip}`, l.startPerIp);
    this.limit(`start:email:${email}`, l.startPerEmail);
    await this.dailyGate(
      email,
      "start",
      l.startPerEmailDaily,
      this.config.backoff.start,
    );

    const now = this.clock.now();
    const code = randomSignInCode();
    await this.prisma.$transaction([
      this.prisma.signInCode.deleteMany({ where: { email } }),
      this.prisma.signInCode.create({
        data: {
          email,
          codeHash: this.codeHash(email, code),
          expiresAt: new Date(now.getTime() + RULES.signInCodeMinutes * 60_000),
        },
      }),
    ]);
    try {
      await this.sendCode(email, code);
    } catch (error) {
      // Nothing was delivered, so the attempt shouldn't count against the sender's budget.
      await this.undoStart(email, ip, code);
      throw error;
    }
    return {
      ok: true as const,
      expiresInSec: RULES.signInCodeMinutes * 60,
      delivery: this.mailer.delivery ?? ("email" as const),
    };
  }

  private async undoStart(email: string, ip: string, code: string) {
    this.limiter.refund(`start:ip:${ip}`);
    this.limiter.refund(`start:email:${email}`);
    try {
      const emailHash = addressHash(this.config.pepper, email);
      const latest = await this.prisma.authAttempt.findFirst({
        where: { emailHash, kind: "start" },
        orderBy: { at: "desc" },
        select: { id: true },
      });
      await this.prisma.$transaction([
        this.prisma.signInCode.deleteMany({
          where: { email, codeHash: this.codeHash(email, code) },
        }),
        ...(latest
          ? [this.prisma.authAttempt.delete({ where: { id: latest.id } })]
          : []),
      ]);
    } catch {
      // Keeping the attempt on record is the safe direction; the send error is what matters.
    }
  }

  private sendCode(email: string, code: string) {
    return this.mailer.send({
      to: email,
      kind: "sign-in-code",
      subject: "Your Murmur sign-in code",
      text: `Your Murmur sign-in code is ${code}. It works for ${RULES.signInCodeMinutes} minutes. If you didn't ask for it, ignore this email.`,
      secret: code,
      highlight: code,
    });
  }

  async verify(email: string, code: string, device: Device, ip: string) {
    const l = this.config.limits;
    this.limit(`verify:ip:${ip}`, l.verifyPerIp);
    this.limit(`verify:email:${email}`, l.verifyPerEmail);
    await this.dailyGate(
      email,
      "verify",
      l.verifyPerEmailDaily,
      this.config.backoff.verify,
    );

    const now = this.clock.now();
    const row = await this.prisma.signInCode.findFirst({
      where: { email, consumedAt: null },
      orderBy: { createdAt: "desc" },
    });
    if (!row)
      throw apiError(
        "code-invalid",
        "That code isn't right. Request a new one.",
      );
    if (row.expiresAt <= now) {
      throw apiError(
        "code-expired",
        "That code has expired. Request a new one.",
      );
    }
    // Count the attempt first and atomically, so parallel guesses can't exceed the limit.
    const counted = await this.prisma.signInCode.updateMany({
      where: {
        id: row.id,
        consumedAt: null,
        attempts: { lt: RULES.signInCodeAttempts },
      },
      data: { attempts: { increment: 1 } },
    });
    if (counted.count === 0) {
      throw apiError(
        "code-invalid",
        "Too many wrong codes. Request a new one.",
      );
    }
    if (!safeEqual(this.codeHash(email, code), row.codeHash)) {
      throw apiError(
        "code-invalid",
        "That code isn't right. Check it and try again.",
      );
    }
    const consumed = await this.prisma.signInCode.updateMany({
      where: { id: row.id, consumedAt: null },
      data: { consumedAt: now },
    });
    if (consumed.count === 0) {
      throw apiError(
        "code-invalid",
        "That code was already used. Request a new one.",
      );
    }

    const userId = await this.findOrCreateUser(email);
    const created = await this.prisma.$transaction(async (tx) => {
      const dev = await tx.device.create({
        data: {
          userId,
          name: device.name,
          platform: device.platform,
          appVersion: device.appVersion,
        },
      });
      return this.tokens.issue({ userId, deviceId: dev.id }, tx);
    });
    this.logger.log(`signed in ${maskEmail(email)}`);
    return { tokens: created, me: await this.me.get(userId) };
  }

  private async findOrCreateUser(email: string): Promise<string> {
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) return existing.id;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const user = await this.prisma.user.create({
          data: { email, referralCode: referralCodeCandidate(email, attempt) },
        });
        return user.id;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // Either the address was created in parallel, or the referral code collided.
        const raced = await this.prisma.user.findUnique({ where: { email } });
        if (raced) return raced.id;
      }
    }
    throw new Error("could not allocate a referral code");
  }

  /**
   * Rotates the refresh token. The row is locked so parallel requests with the same token are
   * serialized. A rotated token presented again within `refreshGraceMs` (the client never got the
   * response) gets the same successor back; later, or if the successor was already used, it is
   * treated as theft and the whole device session ends.
   */
  async refresh(refreshToken: string) {
    const now = this.clock.now();
    const hash = this.tokens.hashRefresh(refreshToken);
    const grace = this.config.refreshGraceMs;
    const outcome = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM "RefreshToken" WHERE "tokenHash" = ${hash} FOR UPDATE`;
      if (locked.length === 0) return { kind: "ended" as const };
      const row = await tx.refreshToken.findUniqueOrThrow({
        where: { id: locked[0].id },
        include: { device: true },
      });
      if (row.device.revokedAt) return { kind: "ended" as const };
      const claims = { userId: row.device.userId, deviceId: row.deviceId };

      if (row.usedAt) {
        if (now.getTime() - row.usedAt.getTime() <= grace && row.successorEnc) {
          const successor = decryptSecret(
            this.config.tokenSecret,
            "refresh-grace",
            row.id,
            row.successorEnc,
          );
          const successorRow = successor
            ? await tx.refreshToken.findUnique({
                where: { tokenHash: this.tokens.hashRefresh(successor) },
              })
            : null;
          if (
            successor &&
            successorRow &&
            !successorRow.usedAt &&
            successorRow.expiresAt > now
          ) {
            return {
              kind: "ok" as const,
              tokens: {
                ...this.tokens.accessFor(claims),
                refreshToken: successor,
              },
            };
          }
        }
        await tx.device.update({
          where: { id: row.deviceId },
          data: { revokedAt: now },
        });
        await tx.refreshToken.updateMany({
          where: { deviceId: row.deviceId, successorEnc: { not: null } },
          data: { successorEnc: null },
        });
        return { kind: "reuse" as const };
      }
      if (row.expiresAt <= now) return { kind: "ended" as const };

      const tokens = await this.tokens.issue(claims, tx);
      await tx.refreshToken.update({
        where: { id: row.id },
        data: {
          usedAt: now,
          successorEnc: encryptSecret(
            this.config.tokenSecret,
            "refresh-grace",
            row.id,
            tokens.refreshToken,
          ),
        },
      });
      await tx.device.update({
        where: { id: row.deviceId },
        data: { lastSeenAt: now },
      });
      // Older rotations are past their grace window: drop their encrypted successors.
      await tx.refreshToken.updateMany({
        where: {
          deviceId: row.deviceId,
          successorEnc: { not: null },
          usedAt: { lt: new Date(now.getTime() - grace) },
        },
        data: { successorEnc: null },
      });
      return { kind: "ok" as const, tokens };
    });
    if (outcome.kind === "reuse") {
      this.logger.warn("refresh token reuse detected; session revoked");
    }
    if (outcome.kind !== "ok") {
      throw apiError("unauthorized", "Your session ended. Sign in again.");
    }
    return { tokens: outcome.tokens };
  }

  /** Ends the caller's session: the device is revoked and its refresh tokens are deleted. */
  async signOut(deviceId: string) {
    await this.prisma.$transaction([
      this.prisma.device.update({
        where: { id: deviceId },
        data: { revokedAt: this.clock.now() },
      }),
      this.prisma.refreshToken.deleteMany({ where: { deviceId } }),
    ]);
  }
}
