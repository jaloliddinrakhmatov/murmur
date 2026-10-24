import { Module } from "@nestjs/common";
import type { DynamicModule, Type } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthGuard } from "./common/auth.ts";
import { Clock } from "./common/clock.ts";
import { RateLimiter } from "./common/rate-limiter.ts";
import type { AppConfig } from "./config/env.ts";
import { AuthController } from "./controllers/auth.controller.ts";
import { BillingController } from "./controllers/billing.controller.ts";
import { HelpController } from "./controllers/help.controller.ts";
import { MeController } from "./controllers/me.controller.ts";
import { PublicController } from "./controllers/public.controller.ts";
import { ReferralsController } from "./controllers/referrals.controller.ts";
import { TeamsController } from "./controllers/teams.controller.ts";
import { UsageController } from "./controllers/usage.controller.ts";
import { HelpService } from "./help/help.service.ts";
import { createHelpModel } from "./help/model.ts";
import type { HelpModel } from "./help/model.ts";
import { loadKnowledge } from "./help/prompt.ts";
import { DevOutboxMailer } from "./mail/dev-outbox.mailer.ts";
import { DevController } from "./mail/dev.controller.ts";
import type { Mailer } from "./mail/mailer.ts";
import { selectMailer } from "./mail/select.ts";
import type { PaymentProvider } from "./payments/payment-provider.ts";
import { TestPaymentProvider } from "./payments/test-payment.provider.ts";
import { PrismaService } from "./prisma/prisma.service.ts";
import { AuthService } from "./services/auth.service.ts";
import { BillingService } from "./services/billing.service.ts";
import { MeService } from "./services/me.service.ts";
import { PlanService } from "./services/plan.service.ts";
import { PublicService } from "./services/public.service.ts";
import { ReferralService } from "./services/referral.service.ts";
import { TeamService } from "./services/team.service.ts";
import { TokenService } from "./services/token.service.ts";
import { UsageService } from "./services/usage.service.ts";
import {
  CONFIG,
  HELP_KNOWLEDGE,
  HELP_MODEL,
  MAILER,
  PAYMENTS,
} from "./tokens.ts";

export interface AppOptions {
  config: AppConfig;
  /** Tests inject a controllable clock. */
  clock?: Clock;
  /** Replace the development mailer / payment provider (the slots for real providers). */
  mailer?: Mailer;
  payments?: PaymentProvider;
  /** Replaces the help chat's AI model (tests); null = chat unavailable. */
  helpModel?: HelpModel | null;
  /** No framework logging (tests). */
  quiet?: boolean;
}

@Module({})
export class AppModule {
  static register(options: AppOptions): DynamicModule {
    const { config } = options;
    if (config.production && !options.mailer && !config.smtp) {
      throw new Error(
        "No email provider is configured. Set MURMUR_SMTP_USER and MURMUR_SMTP_PASS (the development outbox mailer is not allowed in production).",
      );
    }
    if (config.production && !options.payments) {
      throw new Error(
        "No payment provider is configured. The test payment provider is not allowed in production.",
      );
    }
    const clock = options.clock ?? new Clock();
    const controllers: Type[] = [
      AuthController,
      MeController,
      TeamsController,
      ReferralsController,
      UsageController,
      BillingController,
      PublicController,
      HelpController,
    ];
    const knowledge = loadKnowledge();
    if (config.devOutbox) controllers.push(DevController);
    return {
      module: AppModule,
      controllers,
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: Clock, useValue: clock },
        {
          provide: RateLimiter,
          useValue: new RateLimiter(() => clock.now().getTime()),
        },
        DevOutboxMailer,
        {
          provide: MAILER,
          useFactory: (dev: DevOutboxMailer) =>
            selectMailer(config, options.mailer, dev),
          inject: [DevOutboxMailer],
        },
        TestPaymentProvider,
        {
          provide: PAYMENTS,
          useFactory: (test: TestPaymentProvider) => options.payments ?? test,
          inject: [TestPaymentProvider],
        },
        PrismaService,
        TokenService,
        PlanService,
        MeService,
        AuthService,
        TeamService,
        ReferralService,
        UsageService,
        BillingService,
        PublicService,
        { provide: HELP_KNOWLEDGE, useValue: knowledge },
        {
          provide: HELP_MODEL,
          useValue:
            options.helpModel !== undefined
              ? options.helpModel
              : config.help
                ? createHelpModel(config.help, knowledge)
                : null,
        },
        HelpService,
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    };
  }
}
