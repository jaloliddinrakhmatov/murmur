// Claude adapter. UNTESTED in M0: no Anthropic credentials were available in the benchmark
// environment. Enabled only when the SDK can resolve credentials from ANTHROPIC_API_KEY.
//
// Latency settings per model (thinking adds latency and is unnecessary for cleanup):
//   claude-haiku-5-5   thinking disabled (allowed at effort ≤ high), effort low
//   claude-sonnet-5-5  thinking off via `between_tools`, effort low
//   claude-opus-5-5    thinking cannot be disabled; effort low is the only lever
// Opus/Sonnet requests enable server-side refusal fallbacks (`fallbacks: "default"`).
// The system prompt is far below the minimum cacheable prefix, so prompt caching is not used.
import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT, userMessage } from "../prompt.ts";
import type { CleanupOutput, CleanupProvider } from "../types.ts";

/** List prices (USD per MTok) from the Claude API reference cached 2026-10-06; not measured. */
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
};

export const CLAUDE_MODELS = Object.keys(PRICES);

export class AnthropicProvider implements CleanupProvider {
  readonly kind = "cloud";
  readonly id: string;
  readonly usdPerMTok: { input: number; output: number } | null;
  private readonly model: string;
  private readonly client: Anthropic;

  constructor(model: string) {
    this.model = model;
    this.id = `anthropic:${model}`;
    this.usdPerMTok = PRICES[model] ?? null;
    // Retries would hide latency spikes the benchmark is meant to measure; refine() owns the timeout.
    this.client = new Anthropic({ maxRetries: 0 });
  }

  async cleanup(
    raw: string,
    { signal }: { signal: AbortSignal },
  ): Promise<CleanupOutput> {
    const base = {
      model: this.model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user" as const, content: userMessage(raw) }],
      output_config: { effort: "low" as const },
    };
    let message: Anthropic.Message | Anthropic.Beta.BetaMessage;
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
    if (message.stop_reason === "refusal")
      throw new Error(`${this.id}: refusal`);
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
