import type { HelpProviderKind } from "../config/env.ts";
import { HelpProviderError } from "./model.ts";
import type { HelpModel } from "./model.ts";
import type { ChatMessage } from "./prompt.ts";
import { UpstreamParser } from "./sse.ts";

export const UPSTREAM_TIMEOUT_MS = 30_000;

export interface OpenAiCompatibleOptions {
  kind: Exclude<HelpProviderKind, "fake">;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * Streaming chat completions for Groq, Gemini (its OpenAI-compatible endpoint) and OpenAI, with
 * plain fetch. Request quirks follow packages/refine: GPT-OSS models reason first (kept short,
 * out of the reply, with extra token room so the answer is not cut off) and Gemini models think
 * by default (kept at the minimum). Errors carry only a coarse reason; the provider's text, which
 * can echo the request, is never read into a message.
 */
export class OpenAiCompatibleHelpModel implements HelpModel {
  private readonly o: OpenAiCompatibleOptions;
  constructor(options: OpenAiCompatibleOptions) {
    this.o = options;
  }

  requestBody(messages: ChatMessage[], maxTokens: number) {
    const { kind, model } = this.o;
    const gptOss = /^openai\/gpt-oss-/.test(model);
    return {
      model,
      stream: true,
      messages,
      ...(kind === "openai"
        ? { max_completion_tokens: maxTokens }
        : { max_tokens: gptOss ? maxTokens + 1024 : maxTokens }),
      // Reasoning models reject a custom temperature.
      ...(kind !== "openai" || /^gpt-4/.test(model)
        ? { temperature: 0.2 }
        : {}),
      ...(gptOss
        ? { reasoning_effort: "low", include_reasoning: false }
        : kind === "gemini"
          ? { reasoning_effort: "minimal" }
          : {}),
    };
  }

  async *stream(
    messages: ChatMessage[],
    { signal, maxTokens }: { signal: AbortSignal; maxTokens: number },
  ): AsyncGenerator<string> {
    const timeout = AbortSignal.timeout(
      this.o.timeoutMs ?? UPSTREAM_TIMEOUT_MS,
    );
    const both = AbortSignal.any([signal, timeout]);
    const fail = (e: unknown): never => {
      if (signal.aborted) throw e;
      if (timeout.aborted) throw new HelpProviderError("timeout");
      throw new HelpProviderError("upstream");
    };
    let res: Response;
    try {
      res = await (this.o.fetch ?? fetch)(
        `${this.o.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.o.apiKey}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify(this.requestBody(messages, maxTokens)),
          signal: both,
        },
      );
    } catch (e) {
      return fail(e);
    }
    if (!res.ok) {
      // Cancel without reading: the body may repeat parts of the request.
      void res.body?.cancel().catch(() => {});
      if (res.status === 401 || res.status === 403)
        throw new HelpProviderError("auth");
      if (res.status === 402 || res.status === 429)
        throw new HelpProviderError("quota");
      throw new HelpProviderError("upstream");
    }
    if (!res.body) throw new HelpProviderError("upstream");

    const parser = new UpstreamParser();
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let produced = false;
    let finished = false;
    const handle = function* (items: ReturnType<UpstreamParser["push"]>) {
      for (const item of items) {
        if (item.kind === "delta") {
          produced = true;
          yield item.text;
        } else if (item.kind === "finish" || item.kind === "done") {
          finished = true;
        } else {
          throw new HelpProviderError("upstream");
        }
      }
    };
    try {
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (e) {
          return fail(e);
        }
        if (chunk.done) break;
        yield* handle(
          parser.push(decoder.decode(chunk.value, { stream: true })),
        );
        if (finished && produced) break;
      }
      yield* handle(parser.push(decoder.decode()));
      yield* handle(parser.end());
    } finally {
      void reader.cancel().catch(() => {});
    }
    if (!produced) throw new HelpProviderError("empty");
    // A stream that stops without a finish marker was cut off.
    if (!finished) throw new HelpProviderError("upstream");
  }
}
