import { Injectable } from "@nestjs/common";
import type {
  CheckoutInput,
  CheckoutOutcome,
  PaymentProvider,
} from "./payment-provider.ts";

/** Test mode: checkout activates the plan immediately; nothing is charged. */
@Injectable()
export class TestPaymentProvider implements PaymentProvider {
  readonly testMode = true;

  async startCheckout(_input: CheckoutInput): Promise<CheckoutOutcome> {
    return { kind: "activated" };
  }
}
