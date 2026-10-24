import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import type { z } from "zod";
import { HelpChatRequest } from "@murmur/account-api";
import { Public } from "../common/auth.ts";
import { ZodPipe } from "../common/zod.pipe.ts";
import { HelpService } from "../help/help.service.ts";
import { encodeEvent } from "../help/sse.ts";

/** The website's AI help chat: a status check and a streamed (server-sent events) answer. */
@Public()
@Controller("v1/public/help")
export class HelpController {
  private readonly service: HelpService;
  constructor(@Inject(HelpService) service: HelpService) {
    this.service = service;
  }

  @Get("status")
  status(@Req() req: Request) {
    return this.service.status(req.ip ?? "unknown");
  }

  @Post("chat")
  @HttpCode(200)
  async chat(
    @Body(new ZodPipe(HelpChatRequest)) body: z.output<typeof HelpChatRequest>,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const abort = new AbortController();
    // The visitor closed the tab or cancelled: stop the upstream request too.
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });
    // Throws the ordinary 429/503 error before anything is streamed.
    const events = this.service.open(req.ip ?? "unknown", body, abort.signal);
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.socket?.setNoDelay(true);
    res.flushHeaders();
    try {
      for await (const event of events) {
        if (res.destroyed || res.writableEnded) break;
        res.write(encodeEvent(event));
      }
    } finally {
      await events.return(undefined);
      if (!res.writableEnded) res.end();
    }
  }
}
