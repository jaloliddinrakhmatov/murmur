import { Body, Controller, HttpCode, Inject, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import type { z } from "zod";
import {
  AuthRefreshRequest,
  AuthSignOutRequest,
  AuthStartRequest,
  AuthVerifyRequest,
} from "@murmur/account-api";
import { Auth, Public } from "../common/auth.ts";
import type { AuthInfo } from "../common/auth.ts";
import { ZodPipe } from "../common/zod.pipe.ts";
import { AuthService } from "../services/auth.service.ts";

@Controller("v1/auth")
export class AuthController {
  private readonly auth: AuthService;
  constructor(@Inject(AuthService) auth: AuthService) {
    this.auth = auth;
  }

  @Public()
  @Post("start")
  @HttpCode(200)
  start(
    @Body(new ZodPipe(AuthStartRequest))
    body: z.output<typeof AuthStartRequest>,
    @Req() req: Request,
  ) {
    return this.auth.start(body.email, req.ip ?? "unknown");
  }

  @Public()
  @Post("verify")
  @HttpCode(200)
  verify(
    @Body(new ZodPipe(AuthVerifyRequest))
    body: z.output<typeof AuthVerifyRequest>,
    @Req() req: Request,
  ) {
    return this.auth.verify(
      body.email,
      body.code,
      body.device,
      req.ip ?? "unknown",
    );
  }

  @Public()
  @Post("refresh")
  @HttpCode(200)
  refresh(
    @Body(new ZodPipe(AuthRefreshRequest))
    body: z.output<typeof AuthRefreshRequest>,
  ) {
    return this.auth.refresh(body.refreshToken);
  }

  @Post("signout")
  @HttpCode(200)
  async signOut(
    @Auth() auth: AuthInfo,
    @Body(new ZodPipe(AuthSignOutRequest))
    _body: z.output<typeof AuthSignOutRequest>,
  ) {
    await this.auth.signOut(auth.deviceId);
    return { ok: true as const };
  }
}
