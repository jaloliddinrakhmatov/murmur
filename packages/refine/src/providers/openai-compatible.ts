// Chat-completions cleanup for OpenAI-compatible hosts (OpenAI, Groq, Gemini). Plain fetch, no SDK.
import { SYSTEM_PROMPT, userMessage } from "../prompt.ts";
import {
  CleanupProviderError,
  type CleanupOutput,
  type CleanupProvider,
  type FetchLike,
} from "../types.ts";

/** Keys and bearer tokens an error body may echo back, removed before the text can be shown. */
function scrubSecrets(text: string): string {
  return text
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted]")
    .replace(/AQ\.[0-9A-Za-z_-]{20,}/g, "[redacted]")
    .replace(/Bearer\s+[0-9A-Za-z._~+/=-]{8,}/gi, "Bearer [redacted]");
}

export class OpenAICompatibleCleanupProvider implements CleanupProvider {
  readonly kind = "cloud";
  readonly id: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly reasoningEffort?: string;
  private readonly fetchFn: FetchLike;

  constructor(opts: {
    id: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    /** Sent as `reasoning_effort` for hosts whose models think by default (Gemini). */
    reasoningEffort?: string;
    fetch?: FetchLike;
  }) {
    this.id = opts.id;
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.reasoningEffort = opts.reasoningEffort;
    this.fetchFn = opts.fetch ?? fetch;
  }

  async readiness(): Promise<string | null> {
    if (!this.apiKey) return `${this.id}: API key is not configured`;
    if (!this.model) return `${this.id}: model is not configured`;
    return null;
  }

  async cleanup(
    raw: string,
    { signal }: { signal: AbortSignal },
  ): Promise<CleanupOutput> {
    return this.generate(SYSTEM_PROMPT, userMessage(raw), { signal });
  }

  /** One chat completion with the given instructions and input (cleanup, Transforms, Insights). */
  async generate(
    system: string,
    user: string,
    { signal, maxTokens = 1024 }: { signal: AbortSignal; maxTokens?: number },
  ): Promise<CleanupOutput> {
    // GPT-OSS models reason before answering: keep it brief, out of the reply, and give it
    // room so the answer isn't cut off by the token limit.
    const gptOss = /^openai\/gpt-oss-/.test(this.model);
    const res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      signal,
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        max_tokens: gptOss ? maxTokens + 1024 : maxTokens,
        ...(gptOss
          ? { reasoning_effort: "low", include_reasoning: false }
          : this.reasoningEffort
            ? { reasoning_effort: this.reasoningEffort }
            : {}),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) {
      const text = scrubSecrets(
        (await res.text().catch(() => "")).slice(0, 4000),
      );
      // Google answers a bad key with 400 "API key not valid", not 401.
      const status =
        res.status === 400 &&
        this.id.startsWith("gemini") &&
        /api key not valid|API_KEY_INVALID/i.test(text)
          ? 401
          : res.status;
      throw new CleanupProviderError(
        this.id,
        `HTTP ${status} ${text.slice(0, 300)}`,
        status,
      );
    }
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: body.choices?.[0]?.message?.content ?? "",
      inputTokens: body.usage?.prompt_tokens,
      outputTokens: body.usage?.completion_tokens,
    };
  }
}
