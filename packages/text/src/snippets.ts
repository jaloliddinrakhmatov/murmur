// Snippet expansion after cleanup. A trigger phrase spoken alone yields exactly the replacement;
// spoken inside a sentence it is replaced in place. Whole words, case-insensitive, longest trigger
// wins, ONE pass over the text (replacements are never re-scanned, so expansion cannot recurse).
import { normalizeKey } from "./dictionary.ts";

export interface Snippet {
  id: string;
  trigger: string;
  replacement: string;
  enabled?: boolean;
}

export interface SnippetResult {
  text: string;
  hits: Record<string, number>;
}

const escape = (s: string) =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
const stripEdgePunctuation = (s: string) =>
  s.replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "");

export function triggerKey(trigger: string): string {
  return normalizeKey(stripEdgePunctuation(trigger));
}

export function expandSnippets(
  text: string,
  snippets: Snippet[],
): SnippetResult {
  const active = snippets.filter(
    (s) => s.enabled !== false && triggerKey(s.trigger).length > 0,
  );
  const hits: Record<string, number> = {};
  if (active.length === 0 || !text.trim()) return { text, hits };
  text = text.normalize("NFC");
  const byKey = new Map<string, Snippet>();
  for (const s of active)
    if (!byKey.has(triggerKey(s.trigger))) byKey.set(triggerKey(s.trigger), s);

  // Spoken alone: ignore capitalization and surrounding punctuation, output the replacement verbatim.
  const alone = byKey.get(triggerKey(text));
  if (alone) {
    hits[alone.id] = 1;
    return { text: alone.replacement, hits };
  }

  const sorted = [...byKey.values()].sort(
    (a, b) => triggerKey(b.trigger).length - triggerKey(a.trigger).length,
  );
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{M}\\p{N}_])(?:${sorted.map((s) => escape(stripEdgePunctuation(s.trigger))).join("|")})(?![\\p{L}\\p{M}\\p{N}_])`,
    "giu",
  );
  const out = text.replace(pattern, (match) => {
    const snippet = byKey.get(normalizeKey(match));
    if (!snippet) return match;
    hits[snippet.id] = (hits[snippet.id] ?? 0) + 1;
    return snippet.replacement;
  });
  return { text: out, hits };
}

export type SnippetIssue =
  | {
      level: "error";
      code:
        | "empty-trigger"
        | "empty-replacement"
        | "duplicate-trigger"
        | "trigger-is-dictionary-phrase"
        | "trigger-too-long"
        | "replacement-too-long";
    }
  | {
      level: "warning";
      code:
        | "trigger-overlaps"
        | "trigger-common-word"
        | "replacement-contains-trigger";
      detail?: string;
    };

export const TRIGGER_MAX = 60;
export const REPLACEMENT_MAX = 4000;
const COMMON = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "to",
  "of",
  "in",
  "on",
  "is",
  "it",
  "i",
  "you",
  "we",
  "my",
  "me",
  "yes",
  "no",
  "ok",
  "okay",
  "thanks",
  "hello",
  "hi",
]);

/** Problems with saving `candidate` given the other snippets and the dictionary phrases. */
export function checkSnippet(
  candidate: Snippet,
  others: Snippet[],
  dictionaryPhrases: string[] = [],
): SnippetIssue[] {
  const issues: SnippetIssue[] = [];
  const key = triggerKey(candidate.trigger);
  if (!key) issues.push({ level: "error", code: "empty-trigger" });
  if (!candidate.replacement.trim())
    issues.push({ level: "error", code: "empty-replacement" });
  if (candidate.trigger.trim().length > TRIGGER_MAX)
    issues.push({ level: "error", code: "trigger-too-long" });
  if (candidate.replacement.length > REPLACEMENT_MAX)
    issues.push({ level: "error", code: "replacement-too-long" });
  if (!key) return issues;
  for (const o of others) {
    if (o.id === candidate.id) continue;
    const ok = triggerKey(o.trigger);
    if (ok === key) issues.push({ level: "error", code: "duplicate-trigger" });
    else if (containsWords(ok, key) || containsWords(key, ok))
      issues.push({
        level: "warning",
        code: "trigger-overlaps",
        detail: o.trigger,
      });
  }
  if (dictionaryPhrases.some((p) => normalizeKey(p) === key))
    issues.push({ level: "error", code: "trigger-is-dictionary-phrase" });
  if (COMMON.has(key) || key.length < 3)
    issues.push({ level: "warning", code: "trigger-common-word" });
  if (containsWords(normalizeKey(candidate.replacement), key))
    issues.push({ level: "warning", code: "replacement-contains-trigger" });
  return issues;
}

function containsWords(haystack: string, needle: string): boolean {
  return new RegExp(
    `(?<![\\p{L}\\p{M}\\p{N}_])${escape(needle)}(?![\\p{L}\\p{M}\\p{N}_])`,
    "iu",
  ).test(haystack);
}
