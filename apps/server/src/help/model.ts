import type { HelpConfig, HelpProviderKind } from "../config/env.ts";
import { FakeHelpModel } from "./fake.ts";
import { OpenAiCompatibleHelpModel } from "./openai-compatible.ts";
import type { ChatMessage } from "./prompt.ts";

/** Why a provider call failed, without any text from the provider. */
export type HelpFailure =
  | "auth" // bad key or no access: the operator must fix it
  | "quota" // out of credit or rate limited
  | "upstream" // 5xx, network, or a stream that broke
  | "timeout"
  | "empty"; // streamed nothing

export class HelpProviderError extends Error {
  readonly failure: HelpFailure;
  constructor(failure: HelpFailure) {
    super(`help provider failed: ${failure}`);
    this.failure = failure;
  }
}

export interface HelpModel {
  /** Streams the answer's text deltas. Throws HelpProviderError; stops quietly when aborted. */
  stream(
    messages: ChatMessage[],
    opts: { signal: AbortSignal; maxTokens: number },
  ): AsyncIterable<string>;
}

export const HELP_ENDPOINTS: Record<
  Exclude<HelpProviderKind, "fake">,
  { baseUrl: string; model: string }
> = {
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    model: "openai/gpt-oss-120b",
  },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-3.5-flash-lite",
  },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
};

export function createHelpModel(
  config: HelpConfig,
  knowledge: string,
): HelpModel {
  if (config.provider === "fake") return new FakeHelpModel(knowledge);
  const endpoint = HELP_ENDPOINTS[config.provider];
  return new OpenAiCompatibleHelpModel({
    kind: config.provider,
    baseUrl: endpoint.baseUrl,
    apiKey: config.apiKey,
    model: config.model || endpoint.model,
  });
}
