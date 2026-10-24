// The production-shaped wrapper: configurable timeout, output sanitizing, guardrails, and a raw
// transcript fallback. Whatever the model does, the user always gets their words.
import type { CleanupProvider } from "./types.ts";

export interface RefineOptions {
  /** Target, not a hard product limit: configurable per user/app. */
  timeoutMs: number;
}

export type FallbackReason =
  | "empty-input"
  | "timeout"
  | "provider-error"
  | "empty-output"
  | "length-explosion"
  | "length-collapse"
  | "novel-content";

export interface RefineResult {
  text: string;
  usedFallback: boolean;
  reason?: FallbackReason;
  latencyMs: number;
  /** The model's sanitized output even when a guardrail rejected it (for evaluation). */
  modelText?: string;
  inputTokens?: number;
  outputTokens?: number;
}

const PREFACE =
  /^(here(?:'s| is) (?:the )?(?:cleaned(?:[- ]up)? |corrected |edited )?(?:text|transcript|version)[^:\n]*:\s*)/i;

/** Removes wrappers small models add despite instructions: tags, prefaces, surrounding quotes. */
export function sanitize(text: string): string {
  let t = text.replace(/<\/?transcript>/gi, "").trim();
  t = t.replace(PREFACE, "").trim();
  if (/^["“].*["”]$/s.test(t)) t = t.slice(1, -1).trim();
  return t;
}

function words(text: string): string[] {
  return (
    text
      .toLowerCase()
      .replace(/[‘’ʻʼ`´]/g, "'")
      .match(/\p{L}[\p{L}']*/gu) ?? []
  );
}

/** Words the cleanup may legitimately introduce (spoken commands become symbols, lists get labels). */
const ALLOWED_NEW = new Set([
  "i",
  "a",
  "an",
  "the",
  "and",
  "to",
  "is",
  "it",
  "of",
  "in",
  "that",
  "this",
  "s",
  "t",
  "it's",
  "i'm",
  "don't",
  "isn't",
]);

export function novelWordRatio(raw: string, output: string): number {
  const source = new Set(words(raw));
  const out = words(output).filter((w) => !ALLOWED_NEW.has(w));
  if (out.length === 0) return 0;
  return out.filter((w) => !source.has(w)).length / out.length;
}

/** Returns a reason when the output looks like an answer/rewrite rather than a cleanup. */
/** Tokens for length comparisons: words and numbers ("$60,000" counts, so backtracks to a figure are not "collapses"). */
function tokenCount(text: string): number {
  return (text.match(/[\p{L}\p{N}]+/gu) ?? []).length;
}

export function guardrail(raw: string, output: string): FallbackReason | null {
  if (!output.trim()) return "empty-output";
  const rawWords = tokenCount(raw);
  const outWords = tokenCount(output);
  if (outWords > rawWords * 1.4 + 6) return "length-explosion";
  // One-word "answers" ("Paris") and dropped sentences. Legitimate backtracks keep ≥ ~40% of words.
  if (rawWords >= 4 && outWords < rawWords * 0.35) return "length-collapse";
  if (outWords >= 4 && novelWordRatio(raw, output) > 0.3)
    return "novel-content";
  return null;
}

export async function refine(
  raw: string,
  provider: CleanupProvider,
  options: RefineOptions,
): Promise<RefineResult> {
  const t0 = performance.now();
  const elapsed = () => Math.round(performance.now() - t0);
  if (!raw.trim())
    return {
      text: raw,
      usedFallback: true,
      reason: "empty-input",
      latencyMs: 0,
    };
  try {
    const out = await provider.cleanup(raw, {
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    const modelText = sanitize(out.text);
    const usage = {
      inputTokens: out.inputTokens,
      outputTokens: out.outputTokens,
    };
    const reason = guardrail(raw, modelText);
    if (reason)
      return {
        text: raw,
        usedFallback: true,
        reason,
        latencyMs: elapsed(),
        modelText,
        ...usage,
      };
    return {
      text: modelText,
      usedFallback: false,
      latencyMs: elapsed(),
      modelText,
      ...usage,
    };
  } catch (err) {
    const name = (err as Error)?.name;
    const reason: FallbackReason =
      name === "TimeoutError" || name === "AbortError"
        ? "timeout"
        : "provider-error";
    return { text: raw, usedFallback: true, reason, latencyMs: elapsed() };
  }
}
