import type { BillingInterval } from "@murmur/account-api";

export interface CheckoutInput {
  userId: string;
  email: string;
  plan: "pro";
  interval: BillingInterval;
  seats: number;
  promoCode: string | null;
}

export type CheckoutOutcome =
  /** The plan is active now (test mode). */
  | { kind: "activated" }
  /** Pay in the browser; the provider's webhook then creates the subscription. */
  | { kind: "redirect"; url: string };

/**
 * Takes payment. EMPTY SLOT for a real provider (e.g. Stripe): implement this interface, verify
 * its webhooks, and write the Subscription row from the webhook. Needs the user's approval
 * (provider account, legal entity, tax setup).
 */
export interface PaymentProvider {
  /** True while nothing is really charged. */
  readonly testMode: boolean;
  startCheckout(input: CheckoutInput): Promise<CheckoutOutcome>;
}
