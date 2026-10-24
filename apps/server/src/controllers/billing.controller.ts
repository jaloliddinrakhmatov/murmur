import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
} from "@nestjs/common";
import { z } from "zod";
import {
  BillingIntervalSchema,
  CheckoutRequest,
  PromoRequest,
  plansFor,
} from "@murmur/account-api";
import { Auth } from "../common/auth.ts";
import type { AuthInfo } from "../common/auth.ts";
import { ZodPipe } from "../common/zod.pipe.ts";
import { BillingService } from "../services/billing.service.ts";

const PlansQuery = z.object({
  interval: BillingIntervalSchema.default("monthly"),
});

@Controller("v1/billing")
export class BillingController {
  private readonly billing: BillingService;
  constructor(@Inject(BillingService) billing: BillingService) {
    this.billing = billing;
  }

  @Get("plans")
  plans(@Query(new ZodPipe(PlansQuery)) q: z.output<typeof PlansQuery>) {
    return plansFor(q.interval);
  }

  @Get()
  get(@Auth() auth: AuthInfo) {
    return this.billing.get(auth.userId);
  }

  @Post("checkout")
  @HttpCode(200)
  checkout(
    @Auth() auth: AuthInfo,
    @Body(new ZodPipe(CheckoutRequest)) body: z.output<typeof CheckoutRequest>,
  ) {
    return this.billing.checkout(auth.userId, body);
  }

  @Post("cancel")
  @HttpCode(200)
  cancel(@Auth() auth: AuthInfo) {
    return this.billing.cancel(auth.userId);
  }

  @Post("promo")
  @HttpCode(200)
  promo(
    @Auth() auth: AuthInfo,
    @Body(new ZodPipe(PromoRequest)) body: z.output<typeof PromoRequest>,
  ) {
    return this.billing.applyPromo(auth.userId, body.code);
  }
}
