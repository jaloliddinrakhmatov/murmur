export interface CleanupOutput {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

/** An LLM (or rules) cleanup backend. The transcript it receives is untrusted data, never instructions. */
export interface CleanupProvider {
  readonly id: string;
  readonly kind: "rules" | "local" | "cloud";
  /** null when ready, otherwise why it cannot run (missing key, …). */
  readiness(): Promise<string | null>;
  cleanup(
    raw: string,
    options: { signal: AbortSignal },
  ): Promise<CleanupOutput>;
}

/** A provider that can also follow other instructions (Transforms, Insights voice profile). */
export interface TextGenerator {
  generate(
    system: string,
    user: string,
    options: { signal: AbortSignal; maxTokens?: number },
  ): Promise<CleanupOutput>;
}

export class CleanupProviderError extends Error {
  readonly providerId: string;
  readonly status?: number;
  constructor(providerId: string, message: string, status?: number) {
    super(`${providerId}: ${message}`);
    this.name = "CleanupProviderError";
    this.providerId = providerId;
    this.status = status;
  }
}

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;
