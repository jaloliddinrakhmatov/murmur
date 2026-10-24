import { AnthropicCleanupProvider } from "./providers/anthropic.ts";
import { OpenAICompatibleCleanupProvider } from "./providers/openai-compatible.ts";
import type { CleanupProvider, FetchLike } from "./types.ts";

export type AiProviderKind = "groq" | "openai" | "anthropic" | "gemini";

export interface AiCleanupConfig {
  provider: AiProviderKind;
  apiKey?: string;
  model?: string;
}

export const DEFAULT_AI_MODELS: Record<AiProviderKind, string> = {
  // llama-3.3-70b-versatile was shut down on 2026-08-16 (HTTP 404); Groq's replacement.
  groq: "openai/gpt-oss-120b",
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-5-5",
  gemini: "gemini-3.5-flash-lite",
};

class UnconfiguredCleanup implements CleanupProvider {
  readonly kind = "cloud";
  readonly id: string;
  private readonly reason: string;
  constructor(id: string, reason: string) {
    this.id = id;
    this.reason = reason;
  }
  async readiness() {
    return this.reason;
  }
  async cleanup(): Promise<never> {
    throw new Error(this.reason);
  }
}

export function createCleanupProvider(
  config: AiCleanupConfig,
  fetchFn?: FetchLike,
): CleanupProvider {
  const model = config.model || DEFAULT_AI_MODELS[config.provider];
  if (!config.apiKey)
    return new UnconfiguredCleanup(
      config.provider,
      `${config.provider} API key is not set. Open Settings → AI cleanup.`,
    );
  switch (config.provider) {
    case "groq":
      return new OpenAICompatibleCleanupProvider({
        id: `groq:${model}`,
        baseUrl: "https://api.groq.com/openai/v1",
        apiKey: config.apiKey,
        model,
        fetch: fetchFn,
      });
    case "openai":
      return new OpenAICompatibleCleanupProvider({
        id: `openai:${model}`,
        baseUrl: "https://api.openai.com/v1",
        apiKey: config.apiKey,
        model,
        fetch: fetchFn,
      });
    case "gemini":
      return new OpenAICompatibleCleanupProvider({
        id: `gemini:${model}`,
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        apiKey: config.apiKey,
        model,
        // Gemini models think before answering; cleanup needs the least ("minimal"; the Lite
        // models reject "none").
        reasoningEffort: "minimal",
        fetch: fetchFn,
      });
    case "anthropic":
      return new AnthropicCleanupProvider({ apiKey: config.apiKey, model });
  }
}
