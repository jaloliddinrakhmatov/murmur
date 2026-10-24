// Deterministic cleanup for M1 (approved: no LLM in M1). Measured in M0 against 36 cases: this
// rule set passed everything except semantic self-corrections, which it deliberately leaves
// untouched rather than guess (the M0 "scratch that" regex deleted real content).

export type CleanupLevel = "off" | "light";

export interface CleanupResult {
  text: string;
  /** Edits applied, for History and debugging. */
  edits: string[];
}

// Hesitation sounds. The ones that are also real words or abbreviations ("er" in Uzbek, "ER",
// "ah", "mm" as millimetres) match in lowercase only; the others also with a capital ("Um, ...").
const FILLER_SOUNDS = ["um", "umm", "uh", "uhh", "erm", "hmm", "mhm"];
const FILLER_SOUNDS_LOWERCASE_ONLY = ["er", "ah", "hm", "mm"];
// "you know" and "I mean" are removed only as asides, never inside a clause ("do you know where").
const ASIDE = "(?:you know|i mean)";

// Spoken punctuation. Longer phrases first so "question mark" wins over "mark".
const SPOKEN: [RegExp, string, boolean][] = [
  [/\s*\bnew paragraph\b[,.]?\s*/gi, "\n\n", false],
  [/\s*\b(?:new line|next line|line break)\b[,.]?\s*/gi, "\n", false],
  [/\s*\bquestion mark\b/gi, "?", true],
  [/\s*\bexclamation (?:point|mark)\b/gi, "!", true],
  [/\s*\b(?:full stop|period)\b/gi, ".", true],
  [/\s*\bcomma\b/gi, ",", false],
  [/\s*\bsemicolon\b/gi, ";", false],
  [/\s*\bcolon\b/gi, ":", false],
  [/\s*\bopen paren(?:thesis)?\b\s*/gi, " (", false],
  [/\s*\bclose paren(?:thesis)?\b/gi, ")", false],
  [/\s*\bopen quote\b\s*/gi, ' "', false],
  [/\s*\bclose quote\b/gi, '"', false],
];

// "period", "full stop", "question mark" and "exclamation point" are also ordinary words ("the
// trial period ends Friday"), so they count as commands only at the end of the dictation or right
// before another command, and never straight after a determiner ("what is the period").
const COMMAND_AHEAD =
  /^[\s,.!?;:)"]*(?:$|\n|new paragraph|new line|next line|line break|period|full stop|comma|question mark|exclamation (?:point|mark)|semicolon|colon|close (?:paren|parenthesis|quote)|open (?:paren|parenthesis|quote))/i;
const DETERMINER_BEFORE =
  /\b(?:the|a|an|this|that|these|those|my|your|our|his|her|their|its|per|each|every|any|no)\s*$/i;

export interface CleanupOptions {
  /**
   * The dictation language (BCP-47 such as "en", "uz", "ru-RU"; "" or omitted = automatic).
   * English hesitation sounds and asides are removed only for English or automatic, because in
   * other languages they are real words (Uzbek "er" means "man").
   */
  language?: string;
}

/** Whether English filler words apply: English, or a language that isn't known. */
function englishFillers(language: string | undefined): boolean {
  const l = (language ?? "").trim();
  return l === "" || /^en(?:[-_]|$)/i.test(l);
}

function removeFillers(text: string, edits: string[]): string {
  let out = text;
  const aside = (re: RegExp, sub: string) =>
    (out = out.replace(re, (_m, ...rest: unknown[]) => {
      edits.push("filler:phrase");
      return sub.replace("$1", String(rest[0] ?? ""));
    }));
  // ", you know, next" → ", next"; "good, you know." → "good."; "I mean, it works" → "it works".
  aside(new RegExp(`\\s*,\\s*${ASIDE}\\s*,`, "gi"), ",");
  aside(new RegExp(`\\s*,\\s*${ASIDE}(?=\\s*(?:[.!?]|$))`, "gi"), "");
  aside(new RegExp(`(^|[.!?]\\s+)${ASIDE}\\s*,\\s*`, "gi"), "$1");
  const sounds = [
    ...FILLER_SOUNDS.flatMap((w) => [w, w[0].toUpperCase() + w.slice(1)]),
    ...FILLER_SOUNDS_LOWERCASE_ONLY,
  ].join("|");
  const re = new RegExp(`(^|[\\s,])(?:${sounds})(?=[\\s,.!?]|$),?`, "g");
  out = out.replace(re, (all, pre: string, offset: number, whole: string) => {
    // "5 mm": a unit after a number is not a hesitation.
    if (/\d\s*$/.test(whole.slice(0, offset + pre.length))) return all;
    edits.push("filler:word");
    return pre;
  });
  return out;
}

function applySpokenPunctuation(text: string, edits: string[]): string {
  let out = text;
  for (const [re, sub, ambiguous] of SPOKEN) {
    out = out.replace(re, (match, offset: number, whole: string) => {
      if (
        ambiguous &&
        (DETERMINER_BEFORE.test(whole.slice(0, offset)) ||
          !COMMAND_AHEAD.test(whole.slice(offset + match.length)))
      )
        return match;
      edits.push(`spoken:${sub.trim() || "break"}`);
      return sub;
    });
  }
  return out;
}

/** "period." → "."; but "..." and "?!" are deliberate. */
function collapsePunctuationRun(run: string): string {
  return /^\.{3,}$/.test(run) || run === "?!" || run === "!?" ? run : run[0];
}

function tidyWhitespace(text: string): string {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ ([,;:!?)]|\.(?![\p{L}\p{N}]))/gu, "$1")
    .replace(/([(]) /g, "$1")
    .replace(/,([.!?])/g, "$1")
    .replace(/[.!?]{2,}/g, collapsePunctuationRun)
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^[\s,]+/, "")
    .trim();
}

function capitalizeSentences(text: string): string {
  return text.replace(
    /(^|[.!?]\s+|\n+)(\p{Ll})/gu,
    (_m, pre: string, c: string) => pre + c.toUpperCase(),
  );
}

/** Capitalizes the pronoun "i" when it stands alone or in contractions. */
function capitalizeI(text: string): string {
  return text.replace(/(^|[\s(])i(?=['’\s,.!?]|$)/g, "$1I");
}

function ensureTerminalPunctuation(text: string): string {
  if (!text) return text;
  // Any script's sentence-final mark, closing quote or bracket (。？！ । ؟ …) ends a sentence.
  return /[.!?:;,"')\]…،؛؟۔।॥。！？、，；：\p{Pf}\p{Pe}]$/u.test(text)
    ? text
    : `${text}.`;
}

/**
 * Cleans a raw transcript. Never drops content other than filler words and spoken-punctuation
 * commands, so the output is always a faithful rendering of what was said.
 */
export function cleanup(
  raw: string,
  level: CleanupLevel = "light",
  options: CleanupOptions = {},
): CleanupResult {
  const edits: string[] = [];
  const base = raw.replace(/\r\n?/g, "\n").trim();
  if (level === "off" || !base) return { text: base, edits };
  let text = englishFillers(options.language)
    ? removeFillers(base, edits)
    : base;
  text = applySpokenPunctuation(text, edits);
  text = tidyWhitespace(text);
  if (!text) return { text: "", edits };
  text = capitalizeSentences(text);
  text = capitalizeI(text);
  text = ensureTerminalPunctuation(text);
  return { text, edits };
}
