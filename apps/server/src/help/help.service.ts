import { Inject, Injectable, Logger } from "@nestjs/common";
import { HELP_LIMITS } from "@murmur/account-api";
import { apiError } from "../common/errors.ts";
import { RateLimiter } from "../common/rate-limiter.ts";
import type { AppConfig } from "../config/env.ts";
import { CONFIG, HELP_KNOWLEDGE, HELP_MODEL } from "../tokens.ts";
import { HelpProviderError } from "./model.ts";
import type { HelpFailure, HelpModel } from "./model.ts";
import { buildMessages, buildSystemPrompt } from "./prompt.ts";
import type { HelpRequest } from "./prompt.ts";
import type { HelpEvent } from "./sse.ts";

/** About 700 tokens in English; the cap also keeps every answer valid as a later assistant message. */
export const MAX_OUTPUT_TOKENS = 700;
const DAY_MS = 24 * 60 * 60_000;
const GLOBAL_KEY = "help-global";

const UNAVAILABLE = "The help assistant isn't available right now.";
const BUSY = "The help assistant is busy right now. Please try again later.";
const PROBLEM = "The help assistant had a problem. Please try again.";

/**
 * The website's help chat. Questions are limited per IP and, together, per day. Nothing the
 * visitor writes or the assistant answers is stored or logged: the log has only counts, the
 * latency and the outcome.
 */
@Injectable()
export class HelpService {
  private readonly config: AppConfig;
  private readonly model: HelpModel | null;
  private readonly knowledge: string;
  private readonly limiter: RateLimiter;
  private readonly logger = new Logger("Help");

  constructor(
    @Inject(CONFIG) config: AppConfig,
    @Inject(HELP_MODEL) model: HelpModel | null,
    @Inject(HELP_KNOWLEDGE) knowledge: string,
    @Inject(RateLimiter) limiter: RateLimiter,
  ) {
    this.config = config;
    this.model = model;
    this.knowledge = knowledge;
    this.limiter = limiter;
  }

  private get dailyLimit(): number {
    return this.config.help?.dailyLimit ?? 0;
  }

  /** Whether the chat can answer now: configured, and today's budget is not used up. */
  status(ip: string): { available: boolean } {
    const rule = this.config.limits.publicRead;
    if (
      !this.limiter.hit(`public-read:${ip}`, rule.max, rule.windowMs).allowed
    ) {
      throw apiError("rate-limited", "Too many requests. Try again later.");
    }
    return {
      available:
        this.model !== null &&
        this.limiter.remaining(GLOBAL_KEY, this.dailyLimit, DAY_MS) > 0,
    };
  }

  /**
   * Admits one question or throws the ordinary error (503, 429) while the response has not
   * started. On success the caller streams the returned events.
   */
  open(
    ip: string,
    request: HelpRequest,
    signal: AbortSignal,
  ): AsyncGenerator<HelpEvent> {
    if (!this.model) throw apiError("help-unavailable", UNAVAILABLE);
    const { helpPerIpShort: short, helpPerIpDaily: daily } = this.config.limits;
    const shortKey = `help-short:${ip}`;
    const dailyKey = `help-daily:${ip}`;
    if (
      this.limiter.remaining(shortKey, short.max, short.windowMs) < 1 ||
      this.limiter.remaining(dailyKey, daily.max, daily.windowMs) < 1
    ) {
      const today =
        this.limiter.remaining(dailyKey, daily.max, daily.windowMs) < 1;
      this.logger.log(`question refused: ${today ? "ip-daily" : "ip-short"}`);
      throw apiError(
        "rate-limited",
        today
          ? "You've reached today's limit for the help assistant. Please try again tomorrow."
          : "You've asked a lot of questions in a short time. Please wait a few minutes and try again.",
      );
    }
    if (!this.limiter.hit(GLOBAL_KEY, this.dailyLimit, DAY_MS).allowed) {
      this.logger.warn("question refused: daily budget used up");
      throw apiError("help-unavailable", BUSY);
    }
    this.limiter.hit(shortKey, short.max, short.windowMs);
    this.limiter.hit(dailyKey, daily.max, daily.windowMs);
    return this.run(this.model, ip, request, signal);
  }

  private refund(ip: string) {
    this.limiter.refund(GLOBAL_KEY);
    this.limiter.refund(`help-short:${ip}`);
    this.limiter.refund(`help-daily:${ip}`);
  }

  private async *run(
    model: HelpModel,
    ip: string,
    request: HelpRequest,
    signal: AbortSignal,
  ): AsyncGenerator<HelpEvent> {
    const started = Date.now();
    const system = buildSystemPrompt({
      knowledge: this.knowledge,
      contact: this.config.help?.contact,
      page: request.page,
    });
    let chars = 0;
    let outcome = "ok";
    try {
      for await (const text of model.stream(
        buildMessages(system, request.messages),
        { signal, maxTokens: MAX_OUTPUT_TOKENS },
      )) {
        const room = HELP_LIMITS.maxAssistantChars - chars;
        const piece = text.slice(0, room);
        if (piece) {
          chars += piece.length;
          yield { type: "delta", text: piece };
        }
        if (chars >= HELP_LIMITS.maxAssistantChars) {
          outcome = "truncated";
          break;
        }
      }
      if (signal.aborted) {
        outcome = "client-aborted";
        return;
      }
      yield { type: "done" };
    } catch (error) {
      if (signal.aborted) {
        outcome = "client-aborted";
        return;
      }
      const failure: HelpFailure =
        error instanceof HelpProviderError ? error.failure : "upstream";
      outcome = `provider-${failure}`;
      if (chars === 0) this.refund(ip);
      yield failure === "auth"
        ? { type: "error", code: "help-unavailable", message: UNAVAILABLE }
        : failure === "quota"
          ? { type: "error", code: "help-unavailable", message: BUSY }
          : { type: "error", code: "server-error", message: PROBLEM };
    } finally {
      const line = `answer outcome=${outcome} messages=${request.messages.length} chars=${chars} ms=${Date.now() - started}`;
      if (outcome.startsWith("provider-")) this.logger.error(line);
      else this.logger.log(line);
    }
  }
}
