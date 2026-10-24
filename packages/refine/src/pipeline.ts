// The full transcript pipeline: dictionary corrections → cleanup (deterministic, or guarded LLM
// with deterministic fallback) → dictionary casing → snippet expansion. Deterministic cleanup is
// the default; the LLM path can only ever improve on it or fall back to it.
import {
  applyDictionary,
  cleanup,
  expandSnippets,
  type DictionaryEntry,
  type Snippet,
} from "@murmur/text";
import { refine, type FallbackReason } from "./refine.ts";
import type { CleanupProvider } from "./types.ts";

export type CleanupMode = "off" | "deterministic" | "ai";

export interface PipelineOptions {
  mode: CleanupMode;
  dictionary?: DictionaryEntry[];
  snippets?: Snippet[];
  ai?: { provider: CleanupProvider; timeoutMs: number };
  /** The dictation language ("" or omitted = automatic); English fillers go only for English. */
  language?: string;
}

export interface PipelineResult {
  text: string;
  /** Which cleanup produced `text`. "deterministic" also covers an AI request that fell back. */
  cleanupUsed: CleanupMode;
  /** Why the AI result was not used, when mode was "ai". */
  aiFallbackReason?: FallbackReason | "not-ready";
  /** The AI model's own output when it was rejected, for History's comparison view. */
  aiRejectedText?: string;
  aiLatencyMs?: number;
  dictionaryHits: Record<string, number>;
  snippetHits: Record<string, number>;
}

export async function processTranscript(
  raw: string,
  options: PipelineOptions,
): Promise<PipelineResult> {
  const dictionary = options.dictionary ?? [];
  const snippets = options.snippets ?? [];
  const hits: Record<string, number> = {};
  const merge = (h: Record<string, number>) => {
    for (const [k, v] of Object.entries(h)) hits[k] = (hits[k] ?? 0) + v;
  };

  const corrected = applyDictionary(raw, dictionary);
  merge(corrected.hits);
  let text = corrected.text;
  let cleanupUsed: CleanupMode = options.mode;
  let aiFallbackReason: PipelineResult["aiFallbackReason"];
  let aiRejectedText: string | undefined;
  let aiLatencyMs: number | undefined;

  if (options.mode === "ai" && options.ai) {
    const notReady = await options.ai.provider.readiness();
    if (notReady) {
      aiFallbackReason = "not-ready";
      cleanupUsed = "deterministic";
      text = cleanup(text, "light", { language: options.language }).text;
    } else {
      const r = await refine(text, options.ai.provider, {
        timeoutMs: options.ai.timeoutMs,
      });
      aiLatencyMs = r.latencyMs;
      if (r.usedFallback) {
        aiFallbackReason = r.reason;
        aiRejectedText = r.modelText;
        cleanupUsed = "deterministic";
        text = cleanup(text, "light", { language: options.language }).text;
      } else {
        text = r.text;
      }
    }
  } else if (options.mode === "deterministic" || options.mode === "ai") {
    cleanupUsed = "deterministic";
    text = cleanup(text, "light", { language: options.language }).text;
  } else {
    text = text.trim();
  }

  // Casing pass after cleanup (idempotent, single pass) so an LLM cannot un-case "NestJS". Only
  // the casing rules run: a second pass of misheard-as rules would chain ("cube netes" →
  // "Kubernetes" → "KubeCon" when another entry hears "Kubernetes" as "KubeCon").
  const cased = applyDictionary(
    text,
    dictionary.map((e) => ({ ...e, misheardAs: null })),
  );
  text = cased.text;
  const expanded = expandSnippets(text, snippets);
  merge(expanded.hits);
  return {
    text: expanded.text,
    cleanupUsed,
    aiFallbackReason,
    aiRejectedText,
    aiLatencyMs,
    dictionaryHits: corrected.hits,
    snippetHits: expanded.hits,
  };
}
