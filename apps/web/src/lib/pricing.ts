/** Pricing maths and the comparison table, pure so they can be tested without a browser. */

export type Interval = "monthly" | "annual";

export interface PlanData {
  id: string;
  name: string;
  audience: string;
  priceCents: number | null;
  priceIsFrom: boolean;
  discountPct: number;
  features: string[];
}

export interface PlansData {
  interval: Interval;
  currency: string;
  plans: PlanData[];
}

/** "$10", "$9.50": whole amounts drop the cents. */
export function formatMoney(cents: number, currency = "usd"): string {
  const whole = cents % 100 === 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export interface PriceDisplay {
  /** The big number: "$10", "$0" or "Custom". */
  amount: string;
  /** What it is per, or null when there is nothing to add. */
  unit: string | null;
  /** The annual total, when billed annually. */
  billedNote: string | null;
  /** "Save 20%" for annual billing. */
  badge: string | null;
  /** "From" prefix for prices that start at an amount. */
  prefix: string | null;
}

export function priceDisplay(
  plan: PlanData,
  interval: Interval,
  currency = "usd",
): PriceDisplay {
  if (plan.priceCents === null) {
    return {
      amount: "Custom",
      unit: null,
      billedNote: null,
      badge: null,
      prefix: null,
    };
  }
  const prefix = plan.priceIsFrom ? "From" : null;
  if (plan.priceCents === 0) {
    return {
      amount: formatMoney(0, currency),
      unit: "free to use",
      billedNote: null,
      badge: null,
      prefix,
    };
  }
  const annual = interval === "annual" && plan.discountPct > 0;
  return {
    amount: formatMoney(plan.priceCents, currency),
    unit: "per user, per month",
    billedNote: annual
      ? `Billed annually at ${formatMoney(annualTotalCents(plan.priceCents), currency)} per user`
      : null,
    badge: annual ? `Save ${plan.discountPct}%` : null,
    prefix,
  };
}

/** What a user pays over twelve months at a monthly-equivalent price. */
export function annualTotalCents(monthlyEquivalentCents: number): number {
  return monthlyEquivalentCents * 12;
}

/** Cents saved over a year by paying annually instead of monthly (never negative). */
export function yearlySavingsCents(
  monthly: PlanData,
  annual: PlanData,
): number | null {
  if (monthly.priceCents === null || annual.priceCents === null) return null;
  return Math.max(
    0,
    annualTotalCents(monthly.priceCents) - annualTotalCents(annual.priceCents),
  );
}

export interface ComparisonRow {
  feature: string;
  /** One flag per plan, in the order of the catalog. */
  included: boolean[];
}

const INHERIT = /^everything in /i;

/**
 * The comparison table follows the catalog: a feature listed on a plan belongs to it and to every
 * plan after it, because each higher plan starts with "Everything in <previous plan>".
 */
export function comparisonRows(plans: PlanData[]): ComparisonRow[] {
  const rows: ComparisonRow[] = [];
  plans.forEach((plan, index) => {
    for (const feature of plan.features) {
      if (INHERIT.test(feature)) continue;
      rows.push({
        feature,
        included: plans.map((_, i) => i >= index),
      });
    }
  });
  return rows;
}
