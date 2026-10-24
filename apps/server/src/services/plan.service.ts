import { Inject, Injectable } from "@nestjs/common";
import type { PlanState } from "./types.ts";
import { Clock } from "../common/clock.ts";
import { creditWindow, resolvePlanState } from "../domain/plan-state.ts";
import type { SubscriptionState } from "../domain/plan-state.ts";
import { renewSubscription } from "../domain/renewal.ts";
import { PrismaService } from "../prisma/prisma.service.ts";
import type { Prisma } from "../prisma/prisma.service.ts";
import { lockUser } from "./credit.ts";

export interface SyncedPlan {
  plan: PlanState;
  /** Months of referral credit not yet consumed. */
  creditMonths: number;
  /** The user's own subscription after any due renewal. */
  subscription: (SubscriptionState & { seats: number }) | null;
}

export interface TeamPlan {
  ownerId: string;
  seats: number;
  subscription: SubscriptionState;
}

/** A stored subscription after any due renewal, or null unless it is active right now. */
export function liveSubscription(
  s: {
    plan: string;
    interval: string;
    status: string;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
  },
  now: Date,
): SubscriptionState | null {
  const renewed = renewSubscription(
    {
      plan: s.plan as SubscriptionState["plan"],
      interval: s.interval as SubscriptionState["interval"],
      status: s.status as SubscriptionState["status"],
      currentPeriodStart: s.currentPeriodStart,
      currentPeriodEnd: s.currentPeriodEnd,
      cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    },
    { months: 0, anchor: null },
    now,
  ).subscription;
  return renewed.status === "active" && renewed.currentPeriodEnd > now
    ? renewed
    : null;
}

/**
 * The paid plan a team currently has: the active subscription of one of its owners (the one that
 * ends last), after any due renewal. Null while the team has none (a trial doesn't count).
 */
export async function activeTeamPlan(
  db: PrismaService | Prisma.TransactionClient,
  teamId: string,
  now: Date,
): Promise<TeamPlan | null> {
  const ownerSubs = await db.subscription.findMany({
    where: { user: { membership: { teamId, role: "owner" } } },
  });
  let best: TeamPlan | null = null;
  for (const s of ownerSubs) {
    const renewed = liveSubscription(s, now);
    if (
      renewed &&
      (!best || renewed.currentPeriodEnd > best.subscription.currentPeriodEnd)
    ) {
      best = { ownerId: s.userId, seats: s.seats, subscription: renewed };
    }
  }
  return best;
}

/** Brings time-dependent state up to date (renewals, credit start) and resolves the plan. */
@Injectable()
export class PlanService {
  private readonly prisma: PrismaService;
  private readonly clock: Clock;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(Clock) clock: Clock,
  ) {
    this.prisma = prisma;
    this.clock = clock;
  }

  async sync(userId: string): Promise<SyncedPlan> {
    const now = this.clock.now();
    return this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const user = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        include: {
          subscription: true,
          membership: { include: { team: true } },
        },
      });

      let credit = { months: user.creditMonths, anchor: user.creditAnchor };
      let own: (SubscriptionState & { seats: number }) | null =
        user.subscription
          ? {
              plan: user.subscription.plan as SubscriptionState["plan"],
              interval: user.subscription
                .interval as SubscriptionState["interval"],
              status: user.subscription.status as SubscriptionState["status"],
              currentPeriodStart: user.subscription.currentPeriodStart,
              currentPeriodEnd: user.subscription.currentPeriodEnd,
              cancelAtPeriodEnd: user.subscription.cancelAtPeriodEnd,
              seats: user.subscription.seats,
            }
          : null;

      let dirty = false;
      if (own) {
        const renewed = renewSubscription(own, credit, now);
        if (
          renewed.subscription.status !== own.status ||
          renewed.subscription.currentPeriodEnd.getTime() !==
            own.currentPeriodEnd.getTime()
        ) {
          await tx.subscription.update({
            where: { userId },
            data: {
              status: renewed.subscription.status,
              currentPeriodStart: renewed.subscription.currentPeriodStart,
              currentPeriodEnd: renewed.subscription.currentPeriodEnd,
            },
          });
          own = { ...renewed.subscription, seats: own.seats };
          credit = renewed.credit;
          dirty = true;
        }
      }

      // A fully consumed balance is cleared so the next grant starts a fresh window.
      if (creditWindow(credit, now).phase === "exhausted") {
        credit = { months: 0, anchor: null };
        dirty = true;
      }

      // A team member also gets the plan the team owner pays for, but only if they hold one of
      // the paid seats (owner first, then by join date).
      let effective: SubscriptionState | null = own;
      if (user.membership) {
        const team = await activeTeamPlan(tx, user.membership.teamId, now);
        if (team && team.ownerId !== userId) {
          const members = await tx.membership.findMany({
            where: { teamId: user.membership.teamId },
            orderBy: [{ joinedAt: "asc" }, { userId: "asc" }],
            select: { userId: true },
          });
          const order = [
            team.ownerId,
            ...members.map((m) => m.userId).filter((id) => id !== team.ownerId),
          ];
          const renewed = team.subscription;
          if (
            order.indexOf(userId) < team.seats &&
            (!effective ||
              effective.status !== "active" ||
              renewed.currentPeriodEnd > effective.currentPeriodEnd)
          ) {
            effective = renewed;
          }
        }
      }

      const resolved = resolvePlanState({
        now,
        subscription: effective,
        teamTrialEndsAt: user.membership?.team.trialEndsAt ?? null,
        credit,
      });
      if (resolved.startCredit) {
        credit = { months: credit.months, anchor: now };
        dirty = true;
      }
      if (dirty) {
        await tx.user.update({
          where: { id: userId },
          data: { creditMonths: credit.months, creditAnchor: credit.anchor },
        });
      }

      return {
        plan: {
          tier: resolved.plan.tier,
          source: resolved.plan.source,
          until: resolved.plan.until ? resolved.plan.until.toISOString() : null,
        },
        creditMonths: creditWindow(credit, now).remaining,
        subscription: own,
      };
    });
  }
}
