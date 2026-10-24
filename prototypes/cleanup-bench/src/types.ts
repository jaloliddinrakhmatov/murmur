export interface CleanupOutput {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

/** Provider-independent dictation-cleanup contract. */
export interface CleanupProvider {
  readonly id: string;
  readonly kind: "rules" | "local" | "cloud";
  /** List price per million tokens, if known. Used only to estimate cost from measured usage. */
  readonly usdPerMTok: { input: number; output: number } | null;
  start?(): Promise<void>;
  stop?(): Promise<void>;
  cleanup(
    raw: string,
    options: { signal: AbortSignal },
  ): Promise<CleanupOutput>;
}
