// Guarded LLM cleanup: configurable timeout, output sanitizing, and heuristics that detect a model
// acting on the transcript instead of cleaning it. Whatever the model does, the caller gets back
// either a plausible cleanup or the raw transcript — never an answer, a translation, or a rewrite.
import type { CleanupProvider } from "./types.ts";

export interface RefineOptions {
  /** Target, not a hard product limit: configurable per user. */
  timeoutMs: number;
}

export type FallbackReason =
  | "empty-input"
  | "timeout"
  | "provider-error"
  | "empty-output"
  | "length-explosion"
  | "length-collapse"
  | "novel-content"
  | "negation-changed"
  | "numbers-changed";

export interface RefineResult {
  text: string;
  usedFallback: boolean;
  reason?: FallbackReason;
  latencyMs: number;
  /** The model's sanitized output even when a guardrail rejected it (for evaluation and History). */
  modelText?: string;
  /** Provider error message when reason is "provider-error" (never includes the transcript). */
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
}

const PREFACE =
  /^(here(?:'s| is) (?:the )?(?:cleaned(?:[- ]up)? |corrected |edited )?(?:text|transcript|version)[^:\n]*:\s*)/i;

const QUOTE_OPEN = /^["“]/;
const QUOTE_CLOSE = /["”]$/;

/**
 * Removes wrappers models add despite instructions: tags, prefaces, surrounding quotes. Quotes
 * stay when the input itself was quoted or when the quoted stretch ends before the text does
 * (`"Hello," she said, "how are you?"`).
 */
export function sanitize(text: string, input = ""): string {
  let t = text.replace(/<\/?transcript>/gi, "").trim();
  t = t.replace(PREFACE, "").trim();
  const inputQuoted =
    QUOTE_OPEN.test(input.trim()) && QUOTE_CLOSE.test(input.trim());
  if (
    !inputQuoted &&
    t.length >= 2 &&
    QUOTE_OPEN.test(t) &&
    QUOTE_CLOSE.test(t) &&
    !/["“”]/.test(t.slice(1, -1))
  )
    t = t.slice(1, -1).trim();
  // Models write non-breaking hyphens and spaces (“555‑0142”): they look right but break when
  // pasted into forms and searches, so they become ordinary ones.
  return t.replace(/[\u2010\u2011]/g, "-").replace(/[\u00a0\u202f]/g, " ");
}

function words(text: string): string[] {
  return (
    text
      .toLowerCase()
      .replace(/[‘’ʻʼ`´]/g, "'")
      .match(/\p{L}[\p{L}']*/gu) ?? []
  );
}

/** Tokens for length comparisons: words and numbers ("$60,000" counts, so backtracks to a figure are not collapses). */
function tokenCount(text: string): number {
  return (text.match(/[\p{L}\p{N}]+/gu) ?? []).length;
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

// English, Russian and Uzbek. Boundaries are Unicode-aware (`\b` is ASCII-only and never fires on
// Cyrillic). The Uzbek negative verb suffix (-ma-: "kelmaydi") cannot be told from other words
// reliably, so only the separate words (emas, yo'q) are counted.
const NEGATION_WORDS = [
  "not",
  "no",
  "never",
  "none",
  "nothing",
  "nobody",
  "neither",
  "nor",
  "cannot",
  "can't",
  "don't",
  "doesn't",
  "didn't",
  "won't",
  "wouldn't",
  "shouldn't",
  "couldn't",
  "isn't",
  "aren't",
  "wasn't",
  "weren't",
  "hasn't",
  "haven't",
  "hadn't",
  "не",
  "нет",
  "ни",
  "нельзя",
  "никогда",
  "ничего",
  "никто",
  "emas",
  "yo'q",
  "yoq",
];
const NEGATIONS = new RegExp(
  `(?<![\\p{L}\\p{M}])(?:${NEGATION_WORDS.join("|")})(?![\\p{L}\\p{M}])`,
  "giu",
);

export function negationCount(text: string): number {
  return (text.replace(/[‘’ʻʼ`´]/g, "'").match(NEGATIONS) ?? []).length;
}

/** Digit sequences with thousands separators removed ("1,250.40" = "1250.40"); decimals stay distinct ("1.5" ≠ "15"). */
export function numberTokens(text: string): string[] {
  return (text.match(/\d[\d,.]*\d|\d/g) ?? []).map((n) =>
    n.replace(/[,.](?=\d{3}(?!\d))/g, ""),
  );
}

const UNITS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
const SCALES: Record<string, number> = {
  hundred: 100,
  thousand: 1000,
  million: 1e6,
  billion: 1e9,
};

/**
 * Values a spoken number can take as digits: each number word, each run read as one number
 * ("fifty thousand" → 50000), and runs of small groups written side by side ("ten thirty" →
 * 1030, "twenty twenty five" → 2025). Anything else in the output is a number nobody said.
 */
function spokenNumberValues(text: string): Set<string> {
  const out = new Set<string>();
  const groups: number[] = [];
  let total = 0;
  let current = 0;
  let open = false;
  let last = "";
  const closeGroup = () => {
    if (open) {
      groups.push(total + current);
      out.add(String(total + current));
    }
    total = 0;
    current = 0;
    open = false;
  };
  let whole: number | null = null;
  let fraction = "";
  const closeDecimal = () => {
    if (whole !== null && fraction) out.add(`${whole}.${fraction}`);
    whole = null;
    fraction = "";
  };
  const flush = () => {
    closeDecimal();
    closeGroup();
    if (groups.length > 1) out.add(groups.join(""));
    groups.length = 0;
    last = "";
  };
  for (const w of text.toLowerCase().match(/\p{L}+/gu) ?? []) {
    const small = UNITS[w] ?? TENS[w];
    if (whole !== null && UNITS[w] !== undefined && UNITS[w] < 10) {
      out.add(String(UNITS[w]));
      fraction += UNITS[w];
      continue;
    }
    if (w === "point" && open && whole === null) {
      whole = total + current;
      continue;
    }
    if (small !== undefined) {
      out.add(String(small));
      // "twenty" + "five" and "hundred" + "twenty" go on; "ten" + "thirty" starts a new group.
      const continues =
        SCALES[last] !== undefined ||
        last === "and" ||
        (TENS[last] !== undefined && UNITS[w] > 0 && UNITS[w] < 10);
      if (open && !continues) closeGroup();
      current += small;
      open = true;
      last = w;
    } else if (SCALES[w] !== undefined && open) {
      if (SCALES[w] === 100) current *= 100;
      else {
        total += current * SCALES[w];
        current = 0;
      }
      out.add(String(total + current));
      last = w;
    } else if (w === "and" && open && last === "hundred") last = "and";
    else flush();
  }
  flush();
  return out;
}

const BACKTRACK_AFTER =
  /^[\s,.:;\-–—]*(?:\p{L}+[\s,]+){0,2}?(?:(?:no[\s,]+)?(?:actually|scratch that|no wait|i mean|sorry))\b[\s,.:;\-–—]*(?:\p{L}+\s+){0,2}?(?:\d|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|(?:thir|four|fif|six|seven|eigh|nine)teen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million)/iu;

/** Raw numbers missing from the output that a backtrack right after them explains. */
function backtrackedAway(raw: string, number: string): boolean {
  for (const m of raw.matchAll(/\d[\d,.]*\d|\d/g)) {
    const n = m[0].replace(/[,.](?=\d{3}(?!\d))/g, "");
    if (n === number && BACKTRACK_AFTER.test(raw.slice(m.index + m[0].length)))
      return true;
  }
  return false;
}

/** Returns a reason when the output looks like an answer/rewrite rather than a cleanup. */
export function guardrail(raw: string, output: string): FallbackReason | null {
  if (!output.trim()) return "empty-output";
  const rawTokens = tokenCount(raw);
  const outTokens = tokenCount(output);
  if (outTokens > rawTokens * 1.4 + 6) return "length-explosion";
  // One-word "answers" ("Paris") and dropped sentences. Legitimate backtracks keep ≥ ~40% of tokens.
  if (rawTokens >= 4 && outTokens < rawTokens * 0.35) return "length-collapse";
  if (outTokens >= 4 && novelWordRatio(raw, output) > 0.3)
    return "novel-content";
  // A self-correction may legitimately drop one clause; a flipped or removed negation never is.
  const rawNeg = negationCount(raw);
  const outNeg = negationCount(output);
  if (rawNeg > 0 && outNeg === 0) return "negation-changed";
  if (outNeg > rawNeg + 1) return "negation-changed";
  // Every number in the input must survive, except one a backtrack directly after it replaced;
  // and the output may not contain a number that was neither said nor spelled out.
  const rawNums = numberTokens(raw);
  const outList = numberTokens(output);
  const outNums = new Set(outList);
  if (rawNums.some((n) => !outNums.has(n) && !backtrackedAway(raw, n)))
    return "numbers-changed";
  const known = new Set(rawNums);
  const spoken = spokenNumberValues(raw);
  if (outList.some((n) => !known.has(n) && !spoken.has(n)))
    return "numbers-changed";
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
  const signal = AbortSignal.timeout(options.timeoutMs);
  try {
    const out = await provider.cleanup(raw, { signal });
    const modelText = sanitize(out.text, raw);
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
      signal.aborted || name === "TimeoutError" || name === "AbortError"
        ? "timeout"
        : "provider-error";
    return {
      text: raw,
      usedFallback: true,
      reason,
      latencyMs: elapsed(),
      error: String((err as Error)?.message ?? err).slice(0, 300),
    };
  }
}
