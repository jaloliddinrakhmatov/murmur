import { Body, Controller, HttpCode, Inject, Post } from "@nestjs/common";
import type { z } from "zod";
import { UsageRequest } from "@murmur/account-api";
import { Auth } from "../common/auth.ts";
import type { AuthInfo } from "../common/auth.ts";
import { ZodPipe } from "../common/zod.pipe.ts";
import { UsageService } from "../services/usage.service.ts";

@Controller("v1/usage")
export class UsageController {
  private readonly usage: UsageService;
  constructor(@Inject(UsageService) usage: UsageService) {
    this.usage = usage;
  }

  @Post()
  @HttpCode(200)
  async report(
    @Auth() auth: AuthInfo,
    @Body(new ZodPipe(UsageRequest)) body: z.output<typeof UsageRequest>,
  ) {
    await this.usage.report(auth.userId, body.day, body.words);
    return { ok: true as const };
  }
}
