import type { BillingInterval, PlanId } from "@murmur/account-api";
import { addMonths } from "./dates.ts";

export interface CreditState {
  /** Months earned and not yet consumed as of `anchor`. */
  months: number;
  /** When consumption started; null while the credit is waiting to be used. */
  anchor: Date | null;
}

export interface SubscriptionState {
  plan: PlanId;
  interval: BillingInterval;
  status: "active" | "canceled" | "past_due";
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
}

export interface ResolvedPlan {
  tier: PlanId;
  source: "none" | "subscription" | "trial" | "referral";
  until: Date | null;
}

export type CreditWindow =
  | { phase: "none"; remaining: 0 }
  | { phase: "pending"; remaining: number }
  | { phase: "active"; remaining: number; end: Date }
  | { phase: "exhausted"; remaining: 0 };

/** Credit is consumed month by month from the moment it is first used. */
export function creditWindow(credit: CreditState, now: Date): CreditWindow {
  if (credit.months <= 0) return { phase: "none", remaining: 0 };
  if (!credit.anchor) return { phase: "pending", remaining: credit.months };
  const end = addMonths(credit.anchor, credit.months);
  if (now >= end) return { phase: "exhausted", remaining: 0 };
  let elapsed = 0;
  while (
    elapsed < credit.months &&
    addMonths(credit.anchor, elapsed + 1) <= now
  ) {
    elapsed++;
  }
  return { phase: "active", remaining: credit.months - elapsed, end };
}

/** Adds months of credit; a fully consumed balance starts over instead of counting old months. */
export function grantCredit(
  credit: CreditState,
  months: number,
  now: Date,
): CreditState {
  const w = creditWindow(credit, now);
  if (w.phase === "exhausted" || w.phase === "none") {
    return { months, anchor: null };
  }
  return { months: credit.months + months, anchor: credit.anchor };
}

export function isSubscriptionActive(
  sub: SubscriptionState,
  now: Date,
): boolean {
  return sub.status === "active" && sub.currentPeriodEnd > now;
}

/**
 * Plan precedence: active subscription > team trial > referral credit > free.
 * `subscription` must already be renewed (see renewSubscription). `startCredit` is true when
 * the credit is about to be used for the first time, so the caller should persist the anchor.
 */
export function resolvePlanState(input: {
  now: Date;
  subscription: SubscriptionState | null;
  teamTrialEndsAt: Date | null;
  credit: CreditState;
}): { plan: ResolvedPlan; startCredit: boolean } {
  const { now, subscription, teamTrialEndsAt, credit } = input;
  if (subscription && isSubscriptionActive(subscription, now)) {
    return {
      plan: {
        tier: subscription.plan,
        source: "subscription",
        until: subscription.currentPeriodEnd,
      },
      startCredit: false,
    };
  }
  if (teamTrialEndsAt && teamTrialEndsAt > now) {
    return {
      plan: { tier: "pro", source: "trial", until: teamTrialEndsAt },
      startCredit: false,
    };
  }
  const w = creditWindow(credit, now);
  if (w.phase === "active") {
    return {
      plan: { tier: "pro", source: "referral", until: w.end },
      startCredit: false,
    };
  }
  if (w.phase === "pending") {
    return {
      plan: {
        tier: "pro",
        source: "referral",
        until: addMonths(now, credit.months),
      },
      startCredit: true,
    };
  }
  return {
    plan: { tier: "free", source: "none", until: null },
    startCredit: false,
  };
}
