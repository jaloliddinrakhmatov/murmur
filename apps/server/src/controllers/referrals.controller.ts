import { Body, Controller, Get, HttpCode, Inject, Post } from "@nestjs/common";
import type { z } from "zod";
import {
  ApplyReferralRequest,
  ReferralInviteRequest,
} from "@murmur/account-api";
import { Auth } from "../common/auth.ts";
import type { AuthInfo } from "../common/auth.ts";
import { ZodPipe } from "../common/zod.pipe.ts";
import { ReferralService } from "../services/referral.service.ts";

@Controller("v1/referrals")
export class ReferralsController {
  private readonly referrals: ReferralService;
  constructor(@Inject(ReferralService) referrals: ReferralService) {
    this.referrals = referrals;
  }

  @Get()
  list(@Auth() auth: AuthInfo) {
    return this.referrals.list(auth.userId);
  }

  @Post("invite")
  @HttpCode(200)
  invite(
    @Auth() auth: AuthInfo,
    @Body(new ZodPipe(ReferralInviteRequest))
    body: z.output<typeof ReferralInviteRequest>,
  ) {
    return this.referrals.invite(auth.userId, body.emails);
  }

  @Post("apply")
  @HttpCode(200)
  async apply(
    @Auth() auth: AuthInfo,
    @Body(new ZodPipe(ApplyReferralRequest))
    body: z.output<typeof ApplyReferralRequest>,
  ) {
    return { me: await this.referrals.apply(auth.userId, body.code) };
  }
}
