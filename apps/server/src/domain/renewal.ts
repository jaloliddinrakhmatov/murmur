import { addMonths } from "./dates.ts";
import type { CreditState, SubscriptionState } from "./plan-state.ts";

const MAX_PERIODS = 600;

export interface RenewalResult {
  subscription: SubscriptionState;
  credit: CreditState;
  /** How many periods were rolled over. */
  renewals: number;
}

/**
 * Pure renewal logic (test mode: nothing is charged). A subscription whose period has ended
 * either lapses (cancelAtPeriodEnd) or rolls into the next period. Referral credit that is
 * waiting (not started) extends the period at renewal instead of being used on its own.
 */
export function renewSubscription(
  sub: SubscriptionState,
  credit: CreditState,
  now: Date,
): RenewalResult {
  let current = { ...sub };
  let remainingCredit = { ...credit };
  let renewals = 0;
  while (
    current.status === "active" &&
    current.currentPeriodEnd <= now &&
    renewals < MAX_PERIODS
  ) {
    if (current.cancelAtPeriodEnd) {
      current = { ...current, status: "canceled" };
      break;
    }
    const start = current.currentPeriodEnd;
    let end = addMonths(start, current.interval === "annual" ? 12 : 1);
    if (remainingCredit.anchor === null && remainingCredit.months > 0) {
      end = addMonths(end, remainingCredit.months);
      remainingCredit = { months: 0, anchor: null };
    }
    current = { ...current, currentPeriodStart: start, currentPeriodEnd: end };
    renewals++;
  }
  return { subscription: current, credit: remainingCredit, renewals };
}
