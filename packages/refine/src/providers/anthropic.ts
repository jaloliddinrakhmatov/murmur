// Claude cleanup through the official SDK. Thinking is unnecessary for cleanup and adds latency:
// Haiku 5.5 runs with thinking disabled at low effort; Sonnet 5.5 uses `between_tools` (its way to
// turn thinking off); Opus 5.5 cannot disable thinking, so effort low is the only lever. Opus and
// Sonnet requests enable server-side refusal fallbacks.
import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT, userMessage } from "../prompt.ts";
import {
  CleanupProviderError,
  type CleanupOutput,
  type CleanupProvider,
} from "../types.ts";

export const CLAUDE_MODELS = [
  "claude-haiku-5-5",
  "claude-sonnet-5-5",
  "claude-opus-5-5",
] as const;

export class AnthropicCleanupProvider implements CleanupProvider {
  readonly kind = "cloud";
  readonly id: string;
  private readonly model: string;
  private readonly apiKey: string;
  private client: Anthropic | null = null;

  constructor(opts: { apiKey: string; model?: string }) {
    this.model = opts.model || CLAUDE_MODELS[0];
    this.id = `anthropic:${this.model}`;
    this.apiKey = opts.apiKey;
  }

  async readiness(): Promise<string | null> {
    return this.apiKey ? null : "anthropic: API key is not configured";
  }

  async cleanup(
    raw: string,
    { signal }: { signal: AbortSignal },
  ): Promise<CleanupOutput> {
    return this.generate(SYSTEM_PROMPT, userMessage(raw), { signal });
  }

  /** One message with the given instructions and input (cleanup, Transforms, Insights). */
  async generate(
    system: string,
    user: string,
    { signal, maxTokens = 1024 }: { signal: AbortSignal; maxTokens?: number },
  ): Promise<CleanupOutput> {
    // No SDK retries: refine() owns the timeout and a retry would hide latency spikes.
    this.client ??= new Anthropic({ apiKey: this.apiKey, maxRetries: 0 });
    const base = {
      model: this.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user" as const, content: user }],
      output_config: { effort: "low" as const },
    };
    let message: Anthropic.Message | Anthropic.Beta.BetaMessage;
    try {
      if (this.model === "claude-haiku-5-5") {
        message = await this.client.messages.create(
          { ...base, thinking: { type: "disabled" } },
          { signal },
        );
      } else {
        message = await this.client.beta.messages.create(
          {
            ...base,
            ...(this.model === "claude-sonnet-5-5"
              ? { thinking: { type: "between_tools" as const } }
              : {}),
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
          },
          { signal },
        );
      }
    } catch (err) {
      // The SDK wraps an abort in its own error: surface the signal's reason (a "TimeoutError"
      // for AbortSignal.timeout) so callers can tell a timeout from a failure.
      if (signal.aborted) throw signal.reason ?? err;
      if ((err as Error)?.name === "AbortError") throw err;
      if (err instanceof Anthropic.APIError)
        throw new CleanupProviderError(this.id, err.message, err.status);
      throw err;
    }
    if (message.stop_reason === "refusal")
      throw new CleanupProviderError(this.id, "refusal");
    const text = message.content
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join("");
    return {
      text,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    };
  }
}
