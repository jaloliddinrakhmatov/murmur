// Stage E part 2 (M3): writing styles per kind of app, names from the text around the cursor
// (context awareness), and words the person corrected after a dictation (auto-add to the
// dictionary). Pure functions, no I/O: the app decides when to read text, and keeps none of it.

export type WritingStyle = "formal" | "casual" | "veryCasual";

// The lead-in is a lookbehind and the rest of a line break's whitespace is not consumed twice
// (`\n+\s*` backtracked cubically on long runs of newlines).
const SENTENCE_START = /(?<=(?:^|[.!?…]\s|\n)\s*)(\p{Lu})(\p{L}*)/gu;

/**
 * A cleaned-up dictation in a writing style:
 * - formal: as cleaned up (capitals and full stops);
 * - casual: the final full stop dropped (questions and exclamations kept);
 * - veryCasual: also lowercase sentence starts, except “I”, acronyms and words in `keep`
 *   (your dictionary: names you spell with a capital).
 */
export function applyStyle(
  text: string,
  style: WritingStyle,
  keep: Iterable<string> = [],
): string {
  if (style === "formal" || !text.trim()) return text;
  let out = text.replace(/\.(\s*)$/u, "$1");
  if (style === "veryCasual") {
    const kept = new Set([...keep].map((k) => k.toLowerCase()));
    out = out.replace(SENTENCE_START, (all, first: string, rest: string) => {
      const word = first + rest;
      // “I”, acronyms (“NASA”) and your dictionary's words keep their capitals.
      if (word === "I" || /\p{Lu}/u.test(rest) || kept.has(word.toLowerCase()))
        return all;
      return first.toLowerCase() + rest;
    });
    // “I'm”, “I'll”: the sentence-start rule above only sees letters; keep their capital.
    out = out.replace(/(^|\s)i(['’](m|ll|ve|d)\b)/gu, "$1I$2");
  }
  return out;
}

/** “Mr. Karimov”: a full stop after these doesn't start a sentence. */
const ABBREVIATION = /^(mr|mrs|ms|dr|prof|st|sr|jr|vs|etc|e\.g|i\.e)\.$/i;

/** Words that are capitalised anywhere in English text, so they say nothing about names. */
const COMMON = new Set(
  "i a an the this that these those it its he she we they you your our my me him her them is are was were be been am do does did have has had will would can could should may might must shall not no yes ok okay and or but if so then than as at by for from in into of on to up with about after before over under hi hello hey dear thanks thank please regards best sincerely".split(
    " ",
  ),
);

/**
 * Likely names and terms from the text around the cursor, as vocabulary hints for transcription:
 * capitalised words that don't start a sentence, and words with inner capitals (“iPhone”,
 * “McDonald”). At most `max`, in order of appearance, without duplicates.
 */
export function contextTerms(text: string, max = 30): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /[\p{L}][\p{L}\p{N}'’-]*/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && out.length < max) {
    const word = m[0].replace(/['’-]+$/u, "");
    if (word.length < 3 || COMMON.has(word.toLowerCase())) continue;
    const before = text.slice(0, m.index).trimEnd();
    const sentenceStart =
      !before ||
      /\n/.test(text.slice(before.length, m.index)) ||
      (/[.!?…:]$/u.test(before) &&
        !ABBREVIATION.test(before.split(/\s/).pop() ?? ""));
    const capitalised = /^\p{Lu}/u.test(word);
    const innerCapital = /\p{Ll}\p{Lu}/u.test(word);
    const acronym = /^\p{Lu}{2,}$/u.test(word);
    if (!innerCapital && !acronym && (!capitalised || sentenceStart)) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(word);
  }
  return out;
}

/** Frequent English words and the names of days and months: editing one of these is ordinary writing, not a name or term. */
const COMMON_ENGLISH = new Set(
  `monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december
about above across act add after again against ago all almost also always among and another any anyone anything are around ask at away back bad be because been before began being below best better between big both bring but buy by call came can case change come could day did different do does done down each early end enough even ever every example eye fact far feel few find first follow for form found four from get give go going good got great group had hand has have he head hear help her here high him his hold home hour house how however idea if important in into is it its just keep kind know large last late later learn leave left let life like line little live long look made make man many may me mean might more most move much must my name near need never new next night no not now number of off often old on once one only open or other our out over own page part people place plan play point put question read real right run said same saw say school see seem set she should show side small so some something soon sound still such take tell than thank that the their them then there these they thing think this those though thought three through time to together too took try turn two under until up us use very want was water way we well went were what when where which while who whole why will with without word work world would write year yes yet you young your
mark send sent whose wear weather whether`.split(/\s+/),
);

const hasDigit = (s: string) => /\p{N}/u.test(s);

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = up;
    }
  }
  return prev[b.length];
}

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
const tokens = (s: string) => s.match(WORD) ?? [];

/** Start of each word, to tell a capital that only marks a sentence from one in a name. */
const wordStarts = (s: string) => [...s.matchAll(WORD)].map((m) => m.index);

/**
 * Words the person corrected in what Murmur inserted: a word replaced by a close spelling
 * (“Jalolidin” → “Jaloliddin”) with the words around it unchanged. Rewrites, additions and
 * deletions are not corrections. `now` is the same stretch of the field read later.
 */
export function correctedWords(
  inserted: string,
  now: string,
): { heard: string; corrected: string }[] {
  const a = tokens(inserted);
  const b = tokens(now);
  const bStarts = wordStarts(now);
  if (!a.length || !b.length) return [];
  // Longest common subsequence, then the stretches between matched words: a stretch of exactly
  // one word on each side is a candidate correction.
  const L = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      L[i][j] =
        a[i] === b[j]
          ? L[i + 1][j + 1] + 1
          : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: { heard: string; corrected: string }[] = [];
  let removed: string[] = [];
  let added: string[] = [];
  let addedAt = 0;
  // Only names and terms: a capital that is not just a sentence start, no digits, and neither
  // word an ordinary English word, day or month ("Monday" → "Sunday", "form" → "from").
  const nameLike = (heard: string, corrected: string) => {
    if (hasDigit(heard) || hasDigit(corrected)) return false;
    if (COMMON_ENGLISH.has(heard.toLowerCase())) return false;
    const lower = corrected.toLowerCase();
    if (COMMON_ENGLISH.has(lower) || COMMON.has(lower)) return false;
    if (/\p{Ll}\p{Lu}|^\p{Lu}{2,}/u.test(corrected)) return true;
    if (!/^\p{Lu}/u.test(corrected)) return false;
    const before = now.slice(0, bStarts[addedAt]).trimEnd();
    return (
      before !== "" &&
      !/[.!?…:]$/u.test(before) &&
      !now.slice(before.length, bStarts[addedAt]).includes("\n")
    );
  };
  const close = () => {
    if (removed.length === 1 && added.length === 1) {
      const [heard] = removed;
      const [corrected] = added;
      const d = levenshtein(heard.toLowerCase(), corrected.toLowerCase());
      if (
        corrected.length >= 3 &&
        /\p{L}/u.test(corrected) &&
        nameLike(heard, corrected) &&
        d > 0 &&
        d <= Math.max(2, Math.round(corrected.length * 0.34))
      )
        out.push({ heard, corrected });
    }
    removed = [];
    added = [];
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      close();
      i++;
      j++;
    } else if (j >= b.length || (i < a.length && L[i + 1][j] >= L[i][j + 1]))
      removed.push(a[i++]);
    else {
      if (added.length === 0) addedAt = j;
      added.push(b[j++]);
    }
  }
  close();
  return out;
}
