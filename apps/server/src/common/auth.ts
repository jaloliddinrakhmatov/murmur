import {
  createParamDecorator,
  Inject,
  Injectable,
  SetMetadata,
} from "@nestjs/common";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { PrismaService } from "../prisma/prisma.service.ts";
import { TokenService } from "../services/token.service.ts";
import { apiError } from "./errors.ts";

export interface AuthInfo {
  userId: string;
  deviceId: string;
}

export type AuthedRequest = Request & { auth?: AuthInfo };

const IS_PUBLIC = "murmur:public";
/** Routes that need no access token (sign-in, refresh, health, the dev outbox). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** The signed-in user and device. Only valid on routes that aren't @Public(). */
export const Auth = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const auth = ctx.switchToHttp().getRequest<AuthedRequest>().auth;
    if (!auth) throw apiError("unauthorized", "Sign in to continue");
    return auth;
  },
);

/** Default deny: every route needs a valid access token unless it is marked @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly reflector: Reflector;
  private readonly tokens: TokenService;
  private readonly prisma: PrismaService;

  constructor(
    @Inject(Reflector) reflector: Reflector,
    @Inject(TokenService) tokens: TokenService,
    @Inject(PrismaService) prisma: PrismaService,
  ) {
    this.reflector = reflector;
    this.tokens = tokens;
    this.prisma = prisma;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization ?? "";
    const match = /^Bearer (\S+)$/.exec(header);
    const claims = match ? this.tokens.verifyAccessToken(match[1]) : null;
    if (!claims) throw apiError("unauthorized", "Sign in to continue");

    // The device row is what makes sign-out, token reuse and account deletion take effect at once.
    const device = await this.prisma.device.findUnique({
      where: { id: claims.deviceId },
      select: { userId: true, revokedAt: true },
    });
    if (!device || device.revokedAt || device.userId !== claims.userId) {
      throw apiError("unauthorized", "Your session ended. Sign in again.");
    }
    req.auth = { userId: claims.userId, deviceId: claims.deviceId };
    return true;
  }
}
