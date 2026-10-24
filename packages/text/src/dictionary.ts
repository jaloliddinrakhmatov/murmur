// Post-transcription dictionary corrections. Two kinds of entry:
//   phrase + misheardAs  → the misheard spelling is replaced by the phrase ("macro point" → "Macropoint")
//   phrase only          → the phrase's exact casing is enforced ("nestjs" → "NestJS", "eld" → "ELD")
// Safeguards: whole words only (Unicode-aware), case-insensitive, longest source first, ONE pass (a
// replacement is never re-scanned, so rules cannot chain), and tokens that look like URLs, emails
// or paths are never touched.

export interface DictionaryEntry {
  id: string;
  phrase: string;
  misheardAs?: string | null;
  enabled?: boolean;
}

export interface DictionaryResult {
  text: string;
  /** Entry ids that fired, with counts. */
  hits: Record<string, number>;
}

export const normalizeKey = (s: string) =>
  s.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();

const escape = (s: string) =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
const PROTECTED_TOKEN = /(@|:\/\/|^\/|^~\/|\\)/;

interface Rule {
  source: string;
  target: string;
  id: string;
}

export function dictionaryRules(entries: DictionaryEntry[]): Rule[] {
  const rules: Rule[] = [];
  for (const e of entries) {
    if (e.enabled === false) continue;
    const phrase = e.phrase.normalize("NFC").trim().replace(/\s+/g, " ");
    if (phrase.length < 2) continue;
    const misheard = e.misheardAs?.normalize("NFC").trim().replace(/\s+/g, " ");
    if (
      misheard &&
      misheard.length >= 2 &&
      normalizeKey(misheard) !== normalizeKey(phrase)
    )
      rules.push({ source: misheard, target: phrase, id: e.id });
    rules.push({ source: phrase, target: phrase, id: e.id });
  }
  // Longest source first so "bill of lading" beats "lading"; stable for equal lengths.
  return rules.sort((a, b) => b.source.length - a.source.length);
}

export function applyDictionary(
  text: string,
  entries: DictionaryEntry[],
): DictionaryResult {
  const rules = dictionaryRules(entries);
  const hits: Record<string, number> = {};
  if (rules.length === 0 || !text) return { text, hits };
  // Rules are NFC: decomposed input ("cafe" + U+0301) must meet them as the same letters.
  text = text.normalize("NFC");
  // Two entries with the same source: an explicit misheard-as rule beats another entry's casing
  // rule; otherwise the entry listed first wins.
  const byKey = new Map<string, Rule>();
  for (const r of rules) {
    const key = normalizeKey(r.source);
    const existing = byKey.get(key);
    const casingOnly = (x: Rule) => normalizeKey(x.target) === key;
    if (!existing || (casingOnly(existing) && !casingOnly(r)))
      byKey.set(key, r);
  }
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{M}\\p{N}_])(?:${rules.map((r) => escape(r.source)).join("|")})(?![\\p{L}\\p{M}\\p{N}_])`,
    "giu",
  );
  // Process whitespace-separated runs so protected tokens (URLs, emails, paths) are skipped whole.
  const out = text.replace(/\S+(?:[ \t]+\S+)*/g, (run) => {
    const tokens = run.split(/([ \t]+)/);
    return tokens
      .map((tok, i) => {
        if (i % 2 === 1 || PROTECTED_TOKEN.test(tok)) return tok;
        return tok;
      })
      .join("")
      .replace(pattern, (match, offset: number, whole: string) => {
        // Re-check protection for the token containing this match.
        const tokStart = whole.lastIndexOf(" ", offset) + 1;
        const tokEnd = whole.indexOf(" ", offset);
        const token = whole.slice(tokStart, tokEnd === -1 ? undefined : tokEnd);
        if (PROTECTED_TOKEN.test(token)) return match;
        const rule = byKey.get(normalizeKey(match));
        if (!rule) return match;
        hits[rule.id] = (hits[rule.id] ?? 0) + 1;
        return rule.target;
      });
  });
  return { text: out, hits };
}
