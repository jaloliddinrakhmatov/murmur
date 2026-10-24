// The one plan catalog: the server's billing routes, the public website routes and (through
// them) the desktop app and the marketing site all show exactly this.
//
// PLACEHOLDERS: every price, discount, feature line and the sales address below is made up for
// development. Replace them with the real, user-approved ones before any launch.
import type { BillingInterval, PlanId } from "./index.ts";

export interface CatalogPlan {
  id: PlanId;
  name: string;
  audience: string;
  /** Monthly price per user in cents; null = contact us. */
  monthlyCents: number | null;
  priceIsFrom: boolean;
  /** Discount for annual billing, in percent. */
  annualDiscountPct: number;
  features: string[];
}

export const PLAN_CATALOG: {
  currency: string;
  salesEmail: string;
  plans: CatalogPlan[];
} = {
  currency: "usd",
  salesEmail: "sales@murmur.example",
  plans: [
    {
      id: "free",
      name: "Free",
      audience: "For trying Murmur on your own",
      monthlyCents: 0,
      priceIsFrom: false,
      annualDiscountPct: 0,
      features: [
        "Dictate in any app",
        "Dictionary and snippets",
        "Local history",
      ],
    },
    {
      id: "pro",
      name: "Pro",
      audience: "For people who write all day",
      monthlyCents: 1000,
      priceIsFrom: false,
      annualDiscountPct: 20,
      features: [
        "Everything in Free",
        "AI cleanup and transforms",
        "Meeting notes",
        "Team sharing",
      ],
    },
    {
      id: "enterprise",
      name: "Enterprise",
      audience: "For organizations with security needs",
      monthlyCents: null,
      priceIsFrom: true,
      annualDiscountPct: 0,
      features: [
        "Everything in Pro",
        "Single sign-on",
        "Admin controls",
        "Priority support",
      ],
    },
  ],
};

/** The catalog as the `PlansResponse` shape, priced for one billing interval. */
export function plansFor(interval: BillingInterval) {
  return {
    interval,
    currency: PLAN_CATALOG.currency,
    plans: PLAN_CATALOG.plans.map((p) => {
      const discountPct = interval === "annual" ? p.annualDiscountPct : 0;
      return {
        id: p.id,
        name: p.name,
        audience: p.audience,
        priceCents:
          p.monthlyCents === null
            ? null
            : Math.round((p.monthlyCents * (100 - discountPct)) / 100),
        priceIsFrom: p.priceIsFrom,
        discountPct,
        features: [...p.features],
      };
    }),
  };
}
