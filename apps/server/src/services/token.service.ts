import { Inject, Injectable } from "@nestjs/common";
import { Clock } from "../common/clock.ts";
import {
  hashSecret,
  randomRefreshToken,
  safeEqual,
  sign,
} from "../common/crypto.ts";
import type { AppConfig } from "../config/env.ts";
import { CONFIG } from "../tokens.ts";
import { PrismaService } from "../prisma/prisma.service.ts";
import type { Prisma } from "../prisma/prisma.service.ts";

export interface AccessClaims {
  userId: string;
  deviceId: string;
}

/**
 * Access tokens are signed (HMAC-SHA256), short-lived (15 minutes) and carry the user and device.
 * They're checked against the device row on every request, so revocation is immediate; no token
 * table to grow. Refresh tokens are random, stored only as peppered hashes, and rotate on use.
 */
@Injectable()
export class TokenService {
  private readonly config: AppConfig;
  private readonly clock: Clock;
  private readonly prisma: PrismaService;

  constructor(
    @Inject(CONFIG) config: AppConfig,
    @Inject(Clock) clock: Clock,
    @Inject(PrismaService) prisma: PrismaService,
  ) {
    this.config = config;
    this.clock = clock;
    this.prisma = prisma;
  }

  hashRefresh(token: string): string {
    return hashSecret(this.config.pepper, "refresh", token);
  }

  private signAccess(claims: AccessClaims, expiresAt: Date): string {
    const payload = Buffer.from(
      JSON.stringify({
        u: claims.userId,
        d: claims.deviceId,
        e: Math.floor(expiresAt.getTime() / 1000),
      }),
    ).toString("base64url");
    return `${payload}.${sign(this.config.tokenSecret, payload)}`;
  }

  verifyAccessToken(token: string): AccessClaims | null {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra !== undefined) return null;
    if (!safeEqual(signature, sign(this.config.tokenSecret, payload)))
      return null;
    try {
      const data = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      );
      if (
        typeof data.u !== "string" ||
        typeof data.d !== "string" ||
        typeof data.e !== "number" ||
        data.e * 1000 <= this.clock.now().getTime()
      ) {
        return null;
      }
      return { userId: data.u, deviceId: data.d };
    } catch {
      return null;
    }
  }

  /** A fresh access token (no refresh token). */
  accessFor(claims: AccessClaims) {
    const accessExpiresAt = new Date(
      this.clock.now().getTime() + this.config.accessTtlSec * 1000,
    );
    return {
      accessToken: this.signAccess(claims, accessExpiresAt),
      accessExpiresAt: accessExpiresAt.toISOString(),
    };
  }

  /** Creates an access token and a new refresh token for a device. */
  async issue(
    claims: AccessClaims,
    db: PrismaService | Prisma.TransactionClient = this.prisma,
  ) {
    const now = this.clock.now();
    const refreshToken = randomRefreshToken();
    await db.refreshToken.create({
      data: {
        deviceId: claims.deviceId,
        tokenHash: this.hashRefresh(refreshToken),
        expiresAt: new Date(
          now.getTime() + this.config.refreshTtlDays * 86_400_000,
        ),
      },
    });
    return { ...this.accessFor(claims), refreshToken };
  }
}
