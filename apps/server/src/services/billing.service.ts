import { Inject, Injectable } from "@nestjs/common";
import { PLAN_CATALOG } from "@murmur/account-api";
import type { BillingInterval } from "@murmur/account-api";
import { Clock } from "../common/clock.ts";
import { apiError } from "../common/errors.ts";
import { PROMOS } from "../config/plans.ts";
import { addMonths } from "../domain/dates.ts";
import type { PaymentProvider } from "../payments/payment-provider.ts";
import { PrismaService } from "../prisma/prisma.service.ts";
import { PAYMENTS } from "../tokens.ts";
import { lockUser } from "./credit.ts";
import { PlanService } from "./plan.service.ts";
import type { BillingView } from "./types.ts";

export function periodEnd(start: Date, interval: BillingInterval): Date {
  return addMonths(start, interval === "annual" ? 12 : 1);
}

@Injectable()
export class BillingService {
  private readonly prisma: PrismaService;
  private readonly clock: Clock;
  private readonly plans: PlanService;
  private readonly payments: PaymentProvider;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(Clock) clock: Clock,
    @Inject(PlanService) plans: PlanService,
    @Inject(PAYMENTS) payments: PaymentProvider,
  ) {
    this.prisma = prisma;
    this.clock = clock;
    this.plans = plans;
    this.payments = payments;
  }

  async get(userId: string): Promise<BillingView> {
    const synced = await this.plans.sync(userId);
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const promo = user.promoCode ? PROMOS[user.promoCode] : undefined;
    const sub = synced.subscription;
    return {
      plan: synced.plan,
      subscription: sub
        ? {
            plan: sub.plan,
            interval: sub.interval,
            seats: sub.seats,
            status: sub.status,
            currentPeriodEnd: sub.currentPeriodEnd.toISOString(),
            cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
          }
        : null,
      creditMonths: synced.creditMonths,
      promo:
        user.promoCode && promo
          ? { code: user.promoCode, description: promo.description }
          : null,
      testMode: this.payments.testMode,
    };
  }

  async checkout(
    userId: string,
    req: {
      plan: "pro" | "enterprise";
      interval: BillingInterval;
      seats: number;
    },
  ) {
    if (req.plan === "enterprise") {
      return { kind: "contact" as const, email: PLAN_CATALOG.salesEmail };
    }
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const outcome = await this.payments.startCheckout({
      userId,
      email: user.email,
      plan: "pro",
      interval: req.interval,
      seats: req.seats,
      promoCode: user.promoCode,
    });
    if (outcome.kind === "redirect") return outcome;

    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const data = {
        plan: "pro",
        interval: req.interval,
        seats: req.seats,
        status: "active",
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd(now, req.interval),
        cancelAtPeriodEnd: false,
      };
      await tx.subscription.upsert({
        where: { userId },
        create: { userId, ...data },
        update: data,
      });
    });
    return { kind: "activated" as const, billing: await this.get(userId) };
  }

  async cancel(userId: string): Promise<BillingView> {
    const synced = await this.plans.sync(userId);
    if (!synced.subscription || synced.subscription.status !== "active") {
      throw apiError("conflict", "You don't have an active subscription");
    }
    await this.prisma.subscription.update({
      where: { userId },
      data: { cancelAtPeriodEnd: true },
    });
    return this.get(userId);
  }

  async applyPromo(userId: string, code: string): Promise<BillingView> {
    if (!Object.hasOwn(PROMOS, code)) {
      throw apiError("promo-invalid", "That promo code isn't valid");
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { promoCode: code },
    });
    return this.get(userId);
  }
}
