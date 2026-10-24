import { Inject, Injectable } from "@nestjs/common";
import { RULES } from "@murmur/account-api";
import { apiError } from "../common/errors.ts";
import { PrismaService } from "../prisma/prisma.service.ts";
import { claimTombstone } from "./tombstone.ts";
import type { TombstoneField } from "./tombstone.ts";
import type { AppConfig } from "../config/env.ts";
import { CONFIG } from "../tokens.ts";
import { PlanService } from "./plan.service.ts";
import type { MeView } from "./types.ts";

const AVATAR_PREFIX = /^data:image\/(png|jpeg);base64,/;

/** Decodes an avatar data URL; the bytes must really be the image type the URL claims. */
export function parseAvatar(dataUrl: string): {
  mime: "image/png" | "image/jpeg";
  bytes: Buffer;
} {
  const m = AVATAR_PREFIX.exec(dataUrl);
  if (!m)
    throw apiError("bad-request", "The avatar must be a PNG or JPEG image");
  const bytes = Buffer.from(dataUrl.slice(m[0].length), "base64");
  if (bytes.length === 0 || bytes.length > RULES.avatarMaxBytes) {
    throw apiError("bad-request", "The avatar must be smaller than 1 MB");
  }
  const isPng =
    bytes.length > 8 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpeg =
    bytes.length > 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff;
  const mime = m[1] === "png" ? "image/png" : "image/jpeg";
  if ((mime === "image/png" && !isPng) || (mime === "image/jpeg" && !isJpeg)) {
    throw apiError("bad-request", "That file isn't a valid PNG or JPEG image");
  }
  return { mime, bytes };
}

@Injectable()
export class MeService {
  private readonly prisma: PrismaService;
  private readonly plans: PlanService;
  private readonly config: AppConfig;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(PlanService) plans: PlanService,
    @Inject(CONFIG) config: AppConfig,
  ) {
    this.config = config;
    this.prisma = prisma;
    this.plans = plans;
  }

  async get(userId: string): Promise<MeView> {
    const synced = await this.plans.sync(userId);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { membership: { include: { team: true } } },
    });
    if (!user)
      throw apiError("unauthorized", "Your session ended. Sign in again.");
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      avatar:
        user.avatar && user.avatarMime
          ? `data:${user.avatarMime};base64,${Buffer.from(user.avatar).toString("base64")}`
          : null,
      createdAt: user.createdAt.toISOString(),
      plan: synced.plan,
      referralCode: user.referralCode,
      team: user.membership
        ? {
            id: user.membership.team.id,
            name: user.membership.team.name,
            role: user.membership.role as "owner" | "admin" | "member",
          }
        : null,
    };
  }

  async update(
    userId: string,
    patch: { firstName?: string; lastName?: string },
  ) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { firstName: patch.firstName, lastName: patch.lastName },
    });
    return this.get(userId);
  }

  async setAvatar(userId: string, dataUrl: string) {
    const { mime, bytes } = parseAvatar(dataUrl);
    await this.prisma.user.update({
      where: { id: userId },
      data: { avatar: new Uint8Array(bytes), avatarMime: mime },
    });
    return this.get(userId);
  }

  async removeAvatar(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { avatar: null, avatarMime: null },
    });
    return this.get(userId);
  }

  /** Deletes the account and everything it owns. A team with other members is handed over. */
  async delete(userId: string, confirmEmail: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { referralAsReferee: true },
    });
    if (!user)
      throw apiError("unauthorized", "Your session ended. Sign in again.");
    if (user.email !== confirmEmail) {
      throw apiError("bad-request", "Type your account email to confirm");
    }
    await this.prisma.$transaction(async (tx) => {
      // What this address used stays on record (as a hash) so a new account can't repeat it.
      // Normally written when it happened; this covers accounts that predate the tombstones.
      const marks: [TombstoneField, Date | null | undefined][] = [
        ["trialClaimedAt", user.trialClaimedAt],
        ["referredAt", user.referralAsReferee?.createdAt],
        [
          "rewardPaidAt",
          user.referralAsReferee?.status === "rewarded"
            ? user.referralAsReferee.rewardedAt
            : null,
        ],
      ];
      for (const [field, at] of marks) {
        if (at)
          await claimTombstone(tx, this.config.pepper, user.email, field, at);
      }
      const membership = await tx.membership.findUnique({ where: { userId } });
      if (membership) {
        const others = await tx.membership.findMany({
          where: { teamId: membership.teamId, NOT: { userId } },
          orderBy: { joinedAt: "asc" },
        });
        if (others.length === 0) {
          await tx.team.delete({ where: { id: membership.teamId } });
        } else if (
          membership.role === "owner" &&
          !others.some((o) => o.role === "owner")
        ) {
          const heir = others.find((o) => o.role === "admin") ?? others[0];
          await tx.membership.update({
            where: { userId: heir.userId },
            data: { role: "owner" },
          });
        }
      }
      await tx.signInCode.deleteMany({ where: { email: user.email } });
      await tx.outboxEmail.deleteMany({ where: { to: user.email } });
      await tx.user.delete({ where: { id: userId } });
    });
  }
}
