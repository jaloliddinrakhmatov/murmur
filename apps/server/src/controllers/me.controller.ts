import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Patch,
  Put,
} from "@nestjs/common";
import type { z } from "zod";
import {
  DeleteMeRequest,
  SetAvatarRequest,
  UpdateMeRequest,
} from "@murmur/account-api";
import { Auth } from "../common/auth.ts";
import type { AuthInfo } from "../common/auth.ts";
import { ZodPipe } from "../common/zod.pipe.ts";
import { MeService } from "../services/me.service.ts";

@Controller("v1/me")
export class MeController {
  private readonly me: MeService;
  constructor(@Inject(MeService) me: MeService) {
    this.me = me;
  }

  @Get()
  get(@Auth() auth: AuthInfo) {
    return this.me.get(auth.userId);
  }

  @Patch()
  update(
    @Auth() auth: AuthInfo,
    @Body(new ZodPipe(UpdateMeRequest)) body: z.output<typeof UpdateMeRequest>,
  ) {
    return this.me.update(auth.userId, body);
  }

  @Put("avatar")
  setAvatar(
    @Auth() auth: AuthInfo,
    @Body(new ZodPipe(SetAvatarRequest))
    body: z.output<typeof SetAvatarRequest>,
  ) {
    return this.me.setAvatar(auth.userId, body.dataUrl);
  }

  @Delete("avatar")
  removeAvatar(@Auth() auth: AuthInfo) {
    return this.me.removeAvatar(auth.userId);
  }

  @Delete()
  @HttpCode(200)
  async delete(
    @Auth() auth: AuthInfo,
    @Body(new ZodPipe(DeleteMeRequest)) body: z.output<typeof DeleteMeRequest>,
  ) {
    await this.me.delete(auth.userId, body.confirmEmail);
    return { ok: true as const };
  }
}
