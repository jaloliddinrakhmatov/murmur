import type { z } from "zod";
import type {
  BillingResponse,
  MeSchema,
  PlanStateSchema,
  ReferralsResponse,
  TeamSchema,
} from "@murmur/account-api";

export type PlanState = z.infer<typeof PlanStateSchema>;
export type MeView = z.infer<typeof MeSchema>;
export type TeamView = z.infer<typeof TeamSchema>;
export type BillingView = z.infer<typeof BillingResponse>;
export type ReferralsView = z.infer<typeof ReferralsResponse>;
