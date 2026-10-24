import type { Case } from "./cases.ts";

const fold = (s: string) => s.toLowerCase().replace(/[‘’ʻʼ`´]/g, "'");

export interface CaseScore {
  pass: boolean;
  missing: string[];
  forbidden: string[];
  fillersLeft: string[];
  listFormatted: boolean | null;
  terminalPunctuation: boolean;
  /** Word-level edit distance to the reference, divided by reference length. */
  distanceToReference: number;
}

function wordsOf(s: string): string[] {
  return (
    fold(s)
      .match(/[\p{L}\p{N}][\p{L}\p{N}'.,%$:-]*/gu)
      ?.map((w) => w.replace(/[.,:]+$/, "")) ?? []
  );
}

function editDistance(a: string[], b: string[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    prev = cur;
  }
  return prev[b.length];
}

export function scoreCase(c: Case, output: string): CaseScore {
  const out = fold(output);
  const missing = c.contains
    .filter(
      (need) =>
        !(Array.isArray(need) ? need : [need]).some((n) =>
          out.includes(fold(n)),
        ),
    )
    .map((need) => (Array.isArray(need) ? need.join(" | ") : need));
  const outWords = new Set(wordsOf(output));
  // Single tokens are matched as whole words so "2" does not match "2024"; phrases as substrings.
  const forbidden = (c.absent ?? []).filter((a) =>
    /^[\p{L}\p{N}]+$/u.test(a) ? outWords.has(fold(a)) : out.includes(fold(a)),
  );
  const fillersLeft = (c.fillers ?? []).filter((f) =>
    new RegExp(`(^|[^\\p{L}])${f}([^\\p{L}]|$)`, "iu").test(output),
  );
  const listFormatted = c.expectList
    ? /\n\s*(?:\d+[.)]|[-*•])\s+/.test(output)
    : null;
  const terminalPunctuation = /[.!?:]["”)]?\s*$/.test(output.trim());
  const ref = wordsOf(c.reference);
  return {
    pass:
      missing.length === 0 &&
      forbidden.length === 0 &&
      fillersLeft.length === 0,
    missing,
    forbidden,
    fillersLeft,
    listFormatted,
    terminalPunctuation,
    distanceToReference: ref.length
      ? +(editDistance(wordsOf(output), ref) / ref.length).toFixed(3)
      : 0,
  };
}
