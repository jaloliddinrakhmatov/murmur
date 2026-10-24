import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import type { Request } from "express";
import type { z } from "zod";
import { PublicPlansQuery, WaitlistRequest } from "@murmur/account-api";
import { Public } from "../common/auth.ts";
import { ZodPipe } from "../common/zod.pipe.ts";
import { PublicService } from "../services/public.service.ts";

/** Website routes: no sign-in, rate-limited per IP, CORS for the website origin only. */
@Public()
@Controller("v1/public")
export class PublicController {
  private readonly service: PublicService;
  constructor(@Inject(PublicService) service: PublicService) {
    this.service = service;
  }

  @Get("plans")
  plans(
    @Query(new ZodPipe(PublicPlansQuery)) q: z.output<typeof PublicPlansQuery>,
    @Req() req: Request,
  ) {
    return this.service.plans(q.interval, req.ip ?? "unknown");
  }

  @Get("referral/:code")
  referral(@Param("code") code: string, @Req() req: Request) {
    return this.service.referral(code, req.ip ?? "unknown");
  }

  @Get("invite/:token")
  invite(@Param("token") token: string, @Req() req: Request) {
    return this.service.invite(token, req.ip ?? "unknown");
  }

  @Post("waitlist")
  @HttpCode(200)
  waitlist(
    @Body(new ZodPipe(WaitlistRequest)) body: z.output<typeof WaitlistRequest>,
    @Req() req: Request,
  ) {
    return this.service.joinWaitlist(
      body.email,
      body.source,
      req.ip ?? "unknown",
    );
  }
}
