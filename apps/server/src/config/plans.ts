// Promo codes. PLACEHOLDERS: edit before launch. The plan catalog (prices, features) lives in
// packages/account-api (`PLAN_CATALOG`) so the website and the app show the same thing.
export interface Promo {
  description: string;
  percentOff: number;
}

export const PROMOS: Record<string, Promo> = {
  WELCOME10: {
    description: "Test code: 10% off your first year",
    percentOff: 10,
  },
};
