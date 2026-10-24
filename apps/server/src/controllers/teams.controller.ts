import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { z } from "zod";
import {
  CreateTeamRequest,
  InviteRequest,
  JoinTeamRequest,
  SetRoleRequest,
  UpdateTeamRequest,
} from "@murmur/account-api";
import { Auth } from "../common/auth.ts";
import type { AuthInfo } from "../common/auth.ts";
import { ZodPipe } from "../common/zod.pipe.ts";
import { TeamService } from "../services/team.service.ts";

const Id = new ZodPipe(z.string().min(1).max(64));

@Controller("v1/teams")
export class TeamsController {
  private readonly teams: TeamService;
  constructor(@Inject(TeamService) teams: TeamService) {
    this.teams = teams;
  }

  @Get("current")
  async current(@Auth() auth: AuthInfo) {
    return { team: await this.teams.current(auth.userId) };
  }

  @Post()
  create(
    @Auth() auth: AuthInfo,
    @Body(new ZodPipe(CreateTeamRequest))
    body: z.output<typeof CreateTeamRequest>,
  ) {
    return this.teams.create(auth.userId, body.name, body.invites);
  }

  @Post("join")
  @HttpCode(200)
  join(
    @Auth() auth: AuthInfo,
    @Body(new ZodPipe(JoinTeamRequest)) body: z.output<typeof JoinTeamRequest>,
  ) {
    return this.teams.join(auth.userId, body.token);
  }

  @Patch("current")
  rename(
    @Auth() auth: AuthInfo,
    @Body(new ZodPipe(UpdateTeamRequest))
    body: z.output<typeof UpdateTeamRequest>,
  ) {
    return this.teams.rename(auth.userId, body.name);
  }

  @Post("current/invites")
  @HttpCode(200)
  invite(
    @Auth() auth: AuthInfo,
    @Body(new ZodPipe(InviteRequest)) body: z.output<typeof InviteRequest>,
  ) {
    return this.teams.invite(auth.userId, body.emails);
  }

  @Delete("current/invites/:inviteId")
  revokeInvite(
    @Auth() auth: AuthInfo,
    @Param("inviteId", Id) inviteId: string,
  ) {
    return this.teams.revokeInvite(auth.userId, inviteId);
  }

  @Patch("current/members/:userId")
  setRole(
    @Auth() auth: AuthInfo,
    @Param("userId", Id) userId: string,
    @Body(new ZodPipe(SetRoleRequest)) body: z.output<typeof SetRoleRequest>,
  ) {
    return this.teams.setRole(auth.userId, userId, body.role);
  }

  @Delete("current/members/:userId")
  removeMember(@Auth() auth: AuthInfo, @Param("userId", Id) userId: string) {
    return this.teams.removeMember(auth.userId, userId);
  }

  @Post("current/leave")
  @HttpCode(200)
  async leave(@Auth() auth: AuthInfo) {
    return { team: await this.teams.leave(auth.userId) };
  }
}
