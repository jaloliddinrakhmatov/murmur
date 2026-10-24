// Deterministic baseline: what regexes alone achieve, with no model and ~0 ms latency.
import type { CleanupOutput, CleanupProvider } from "../types.ts";

const FILLERS =
  /(^|[\s,])(?:um+|uh+|erm|er|ah|hmm+|ee|you know)(?=[\s,.!?]|$)[,]?/gi;
const BACKTRACK = /[^.!?]*?\b(?:scratch that|no wait)\b[,]?\s*/gi;
const SPOKEN: [RegExp, string][] = [
  [/\s*\bcomma\b/gi, ","],
  [/\s*\bperiod\b/gi, "."],
  [/\s*\bquestion mark\b/gi, "?"],
  [/\s*\bnew paragraph\b\s*/gi, "\n\n"],
  [/\s*\bnew line\b\s*/gi, "\n"],
];

export function rulesCleanup(raw: string): string {
  let t = raw.replace(FILLERS, "$1").replace(BACKTRACK, "");
  for (const [re, sub] of SPOKEN) t = t.replace(re, sub);
  t = t
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/,([.!?])/g, "$1")
    .replace(/^[\s,]+/, "")
    .trim();
  t = t.replace(
    /(^|[.!?]\s+|\n)(\p{Ll})/gu,
    (_m, p: string, c: string) => p + c.toUpperCase(),
  );
  if (t && !/[.!?:]$/.test(t)) t += ".";
  return t;
}

export class RulesProvider implements CleanupProvider {
  readonly id = "rules-baseline";
  readonly kind = "rules";
  readonly usdPerMTok = { input: 0, output: 0 };

  async cleanup(raw: string): Promise<CleanupOutput> {
    return { text: rulesCleanup(raw) };
  }
}
