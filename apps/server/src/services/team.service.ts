import { Inject, Injectable } from "@nestjs/common";
import { RULES } from "@murmur/account-api";
import { Clock } from "../common/clock.ts";
import {
  formatInviteToken,
  hashSecret,
  normalizeInviteToken,
  randomInviteToken,
} from "../common/crypto.ts";
import { apiError } from "../common/errors.ts";
import { RateLimiter } from "../common/rate-limiter.ts";
import type { AppConfig } from "../config/env.ts";
import { addDays } from "../domain/dates.ts";
import { plainForEmail } from "../common/text.ts";
import type { Mailer } from "../mail/mailer.ts";
import { PrismaService } from "../prisma/prisma.service.ts";
import type { Prisma } from "../prisma/prisma.service.ts";
import { CONFIG, MAILER } from "../tokens.ts";
import { activeTeamPlan, liveSubscription } from "./plan.service.ts";
import { claimTombstone } from "./tombstone.ts";
import type { TeamView } from "./types.ts";

type Role = "owner" | "admin" | "member";
type Db = PrismaService | Prisma.TransactionClient;

const seatsFull = (seats: number) =>
  apiError(
    "seats-full",
    `Your team's plan has ${seats} ${seats === 1 ? "seat" : "seats"} and all are taken. Add seats in Billing first.`,
  );

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

@Injectable()
export class TeamService {
  private readonly config: AppConfig;
  private readonly prisma: PrismaService;
  private readonly clock: Clock;
  private readonly limiter: RateLimiter;
  private readonly mailer: Mailer;

  constructor(
    @Inject(CONFIG) config: AppConfig,
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(Clock) clock: Clock,
    @Inject(RateLimiter) limiter: RateLimiter,
    @Inject(MAILER) mailer: Mailer,
  ) {
    this.config = config;
    this.prisma = prisma;
    this.clock = clock;
    this.limiter = limiter;
    this.mailer = mailer;
  }

  private inviteHash(token: string) {
    return hashSecret(this.config.pepper, "invite", token);
  }

  /** The team as seen by `viewerId`; invites only for owners and admins. */
  private async view(
    db: Db,
    teamId: string,
    viewerId: string,
  ): Promise<TeamView> {
    const now = this.clock.now();
    const team = await db.team.findUniqueOrThrow({
      where: { id: teamId },
      include: {
        members: { include: { user: true }, orderBy: { joinedAt: "asc" } },
      },
    });
    const me = team.members.find((m) => m.userId === viewerId);
    if (!me) throw apiError("not-found", "You're not in a team");
    const role = me.role as Role;
    const invites =
      role === "member"
        ? []
        : await db.teamInvite.findMany({
            where: { teamId },
            orderBy: { createdAt: "desc" },
            take: 100,
          });
    return {
      id: team.id,
      name: team.name,
      role,
      trialEndsAt: team.trialEndsAt ? team.trialEndsAt.toISOString() : null,
      members: team.members.map((m) => ({
        userId: m.userId,
        email: m.user.email,
        name: `${m.user.firstName} ${m.user.lastName}`.trim(),
        role: m.role as Role,
        joinedAt: m.joinedAt.toISOString(),
      })),
      invites: invites.map((i) => ({
        id: i.id,
        email: i.email,
        status:
          i.status === "pending" && i.expiresAt <= now
            ? ("expired" as const)
            : (i.status as "pending" | "accepted" | "revoked"),
        createdAt: i.createdAt.toISOString(),
        expiresAt: i.expiresAt.toISOString(),
      })),
    };
  }

  private async membershipOf(userId: string, db: Db = this.prisma) {
    const m = await db.membership.findUnique({
      where: { userId },
      include: { team: true },
    });
    if (!m) throw apiError("not-found", "You're not in a team");
    return m;
  }

  private requireManager(role: string) {
    if (role !== "owner" && role !== "admin") {
      throw apiError("forbidden", "Only team owners and admins can do that");
    }
  }

  async current(userId: string): Promise<TeamView | null> {
    const m = await this.prisma.membership.findUnique({ where: { userId } });
    return m ? this.view(this.prisma, m.teamId, userId) : null;
  }

  async create(
    userId: string,
    name: string,
    inviteEmails: string[],
  ): Promise<TeamView> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const emails = this.cleanEmails(inviteEmails, user.email);
    const now = this.clock.now();
    const own = await this.prisma.subscription.findUnique({
      where: { userId },
    });
    if (own && emails.length > 0) {
      if (liveSubscription(own, now) && 1 + emails.length > own.seats) {
        throw seatsFull(own.seats);
      }
    }
    this.chargeInvites(userId, emails.length);
    let teamId: string;
    try {
      teamId = await this.prisma.$transaction(async (tx) => {
        if (await tx.membership.findUnique({ where: { userId } })) {
          throw apiError("team-exists", "You're already in a team");
        }
        // One trial per person, so leaving and re-creating teams can't extend it.
        // The tombstone remembers the address after account deletion.
        const trial =
          user.trialClaimedAt === null &&
          (await claimTombstone(
            tx,
            this.config.pepper,
            user.email,
            "trialClaimedAt",
            now,
          ));
        const team = await tx.team.create({
          data: {
            name,
            trialEndsAt: trial ? addDays(now, RULES.teamTrialDays) : null,
            members: { create: { userId, role: "owner" } },
          },
        });
        if (user.trialClaimedAt === null) {
          await tx.user.update({
            where: { id: userId },
            data: { trialClaimedAt: now },
          });
        }
        return team.id;
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw apiError("team-exists", "You're already in a team");
      throw error;
    }
    if (emails.length) await this.createInvites(teamId, userId, name, emails);
    return this.view(this.prisma, teamId, userId);
  }

  async rename(userId: string, name: string): Promise<TeamView> {
    const m = await this.membershipOf(userId);
    this.requireManager(m.role);
    await this.prisma.team.update({ where: { id: m.teamId }, data: { name } });
    return this.view(this.prisma, m.teamId, userId);
  }

  async invite(userId: string, rawEmails: string[]): Promise<TeamView> {
    const m = await this.membershipOf(userId);
    this.requireManager(m.role);
    const me = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const emails = this.cleanEmails(rawEmails, me.email);
    this.chargeInvites(userId, emails.length);
    await this.createInvites(m.teamId, userId, m.team.name, emails);
    return this.view(this.prisma, m.teamId, userId);
  }

  async revokeInvite(userId: string, inviteId: string): Promise<TeamView> {
    const m = await this.membershipOf(userId);
    this.requireManager(m.role);
    const invite = await this.prisma.teamInvite.findFirst({
      where: { id: inviteId, teamId: m.teamId },
    });
    if (!invite) throw apiError("not-found", "That invite doesn't exist");
    if (invite.status === "accepted") {
      throw apiError("conflict", "That invite was already accepted");
    }
    await this.prisma.teamInvite.update({
      where: { id: invite.id },
      data: { status: "revoked" },
    });
    return this.view(this.prisma, m.teamId, userId);
  }

  async join(userId: string, rawToken: string): Promise<TeamView> {
    const j = this.config.limits.joinPerUser;
    const d = this.limiter.hit(`join:${userId}`, j.max, j.windowMs);
    if (!d.allowed)
      throw apiError("rate-limited", "Too many attempts. Try again later.");

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    if (await this.prisma.membership.findUnique({ where: { userId } })) {
      throw apiError(
        "team-exists",
        "You're already in a team. Leave it before joining another.",
      );
    }
    const invalid = () =>
      apiError("not-found", "That invite code isn't valid or has expired");
    const invite = await this.prisma.teamInvite.findUnique({
      where: { tokenHash: this.inviteHash(normalizeInviteToken(rawToken)) },
    });
    if (
      !invite ||
      invite.status !== "pending" ||
      invite.expiresAt <= this.clock.now()
    ) {
      throw invalid();
    }
    if (invite.email !== user.email) {
      throw apiError(
        "forbidden",
        "This invite was sent to a different email address",
      );
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        // Serialize joins to this team so two people can't take the last paid seat together.
        await tx.$queryRaw`SELECT id FROM "Team" WHERE id = ${invite.teamId} FOR UPDATE`;
        const claimed = await tx.teamInvite.updateMany({
          where: { id: invite.id, status: "pending" },
          data: { status: "accepted" },
        });
        if (claimed.count === 0) throw invalid();
        const paid = await activeTeamPlan(tx, invite.teamId, this.clock.now());
        if (paid) {
          const members = await tx.membership.count({
            where: { teamId: invite.teamId },
          });
          if (members >= paid.seats) throw seatsFull(paid.seats);
        }
        await tx.membership.create({
          data: { userId, teamId: invite.teamId, role: "member" },
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw apiError("team-exists", "You're already in a team");
      }
      throw error;
    }
    return this.view(this.prisma, invite.teamId, userId);
  }

  async setRole(
    userId: string,
    targetId: string,
    role: "admin" | "member",
  ): Promise<TeamView> {
    const m = await this.membershipOf(userId);
    if (m.role !== "owner")
      throw apiError("forbidden", "Only the team owner can change roles");
    return this.prisma.$transaction(async (tx) => {
      const target = await tx.membership.findFirst({
        where: { userId: targetId, teamId: m.teamId },
      });
      if (!target)
        throw apiError("not-found", "That person isn't in your team");
      if (target.role === "owner") {
        const owners = await tx.membership.count({
          where: { teamId: m.teamId, role: "owner" },
        });
        if (owners <= 1) {
          throw apiError("team-last-owner", "A team needs at least one owner");
        }
      }
      await tx.membership.update({
        where: { userId: targetId },
        data: { role },
      });
      return this.view(tx, m.teamId, userId);
    });
  }

  async removeMember(userId: string, targetId: string): Promise<TeamView> {
    const m = await this.membershipOf(userId);
    this.requireManager(m.role);
    if (targetId === userId) {
      throw apiError("bad-request", "Use Leave team to remove yourself");
    }
    const target = await this.prisma.membership.findFirst({
      where: { userId: targetId, teamId: m.teamId },
    });
    if (!target) throw apiError("not-found", "That person isn't in your team");
    if (target.role === "owner") {
      throw apiError("forbidden", "A team owner can't be removed");
    }
    if (target.role === "admin" && m.role !== "owner") {
      throw apiError("forbidden", "Only the team owner can remove an admin");
    }
    await this.prisma.membership.delete({ where: { userId: targetId } });
    return this.view(this.prisma, m.teamId, userId);
  }

  async leave(userId: string): Promise<null> {
    const m = await this.membershipOf(userId);
    await this.prisma.$transaction(async (tx) => {
      const others = await tx.membership.findMany({
        where: { teamId: m.teamId, NOT: { userId } },
      });
      if (others.length === 0) {
        await tx.team.delete({ where: { id: m.teamId } });
        return;
      }
      if (m.role === "owner" && !others.some((o) => o.role === "owner")) {
        throw apiError(
          "team-last-owner",
          "You're the only owner. Make someone else an owner or remove the other members first.",
        );
      }
      await tx.membership.delete({ where: { userId } });
    });
    return null;
  }

  private cleanEmails(emails: string[], ownEmail: string): string[] {
    return [...new Set(emails)].filter((e) => e !== ownEmail);
  }

  private chargeInvites(userId: string, count: number) {
    if (count === 0) return;
    const r = this.config.limits.invitesPerDay;
    const d = this.limiter.hitMany(
      `invites:${userId}`,
      count,
      r.max,
      r.windowMs,
    );
    if (!d.allowed) {
      throw apiError(
        "rate-limited",
        "You've sent too many invitations today. Try again tomorrow.",
      );
    }
  }

  /** Skips people who are already members or already have a live invite. */
  private async createInvites(
    teamId: string,
    inviterId: string,
    teamName: string,
    emails: string[],
  ) {
    const now = this.clock.now();
    const members = await this.prisma.membership.findMany({
      where: { teamId },
      include: { user: { select: { email: true } } },
    });
    const memberEmails = new Set(members.map((m) => m.user.email));
    const pending = await this.prisma.teamInvite.findMany({
      where: { teamId, status: "pending", expiresAt: { gt: now } },
      select: { email: true },
    });
    const pendingEmails = new Set(pending.map((p) => p.email));
    const fresh = emails.filter(
      (e) => !memberEmails.has(e) && !pendingEmails.has(e),
    );
    const paid = await activeTeamPlan(this.prisma, teamId, now);
    if (
      paid &&
      members.length + pendingEmails.size + fresh.length > paid.seats
    ) {
      throw seatsFull(paid.seats);
    }
    const team = plainForEmail(teamName);
    for (const email of fresh) {
      const token = randomInviteToken();
      const invite = await this.prisma.teamInvite.create({
        data: {
          teamId,
          email,
          tokenHash: this.inviteHash(token),
          invitedById: inviterId,
          expiresAt: addDays(now, RULES.teamInviteDays),
        },
      });
      const code = formatInviteToken(token);
      try {
        await this.mailer.send({
          to: email,
          kind: "team-invite",
          subject: "You're invited to join a team on Murmur",
          text: `You've been invited to join the team "${team}" on Murmur.\n\nYour invite code: ${code}\n\nTo join: open Murmur, go to Settings > Team > Join, paste the code, and sign in with this email address (${email}).\n\nThe code works for ${RULES.teamInviteDays} days.`,
          secret: token,
          highlight: code,
        });
      } catch (error) {
        await this.prisma.teamInvite.update({
          where: { id: invite.id },
          data: { status: "revoked" },
        });
        throw error;
      }
    }
  }
}
