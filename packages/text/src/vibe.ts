// Vibe coding (Settings → Vibe coding): spoken file references become @-mentions for AI chats in
// code editors, and spoken identifiers become the identifiers near the cursor. Pure functions, no
// I/O: the app decides what to read, and keeps none of it beyond one dictation.

/** Extensions a spoken "dot <ext>" turns into a file mention when no real file matches. */
export const CODE_EXTENSIONS: ReadonlySet<string> = new Set(
  `ts tsx js jsx mjs cjs json jsonc md mdx py rs go java kt kts swift rb php css scss sass less html vue svelte astro yml yaml toml sh zsh bash sql c h cpp hpp cc cs m mm dart lua r scala gradle xml lock txt ipynb prisma graphql proto tf`.split(
    " ",
  ),
);

const SPOKEN_SEPARATORS: Record<string, string> = {
  slash: "/",
  dot: ".",
  underscore: "_",
  dash: "-",
  hyphen: "-",
};

/** Most plain words between "at" and "dot <ext>" that may name one file (needs a real match). */
const MAX_NAME_WORDS = 4;

interface Token {
  /** The token without trailing punctuation. */
  core: string;
  /** Trailing punctuation, kept when the token is replaced. */
  trail: string;
  start: number;
  end: number;
}

function tokenize(text: string): Token[] {
  return [...text.matchAll(/\S+/gu)].map((m) => {
    const trail = /[.,;:!?)\]"'”’]+$/u.exec(m[0])?.[0] ?? "";
    return {
      core: m[0].slice(0, m[0].length - trail.length),
      trail,
      start: m.index,
      end: m.index + m[0].length,
    };
  });
}

const WORD = /^[A-Za-z0-9_][A-Za-z0-9_/-]*$/u;
const WRITTEN = /^[\w-]+(?:[/.][\w-]+)*\.([A-Za-z0-9]+)$/u;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const lower = (t: Token | undefined) => t?.core.toLowerCase() ?? "";
const noTrail = (t: Token | undefined) => !!t && t.trail === "";

/** The shortest tail of `files` paths that has the same letters as `key` (case, dots and dashes ignored). */
function realMatch(
  key: string,
  segments: number,
  files: readonly string[],
): string | null {
  for (const f of files) {
    const tail = f.split("/").slice(-segments).join("/");
    if (norm(tail) === key) return tail;
  }
  return null;
}

interface Element {
  word: boolean;
  text: string;
}

/**
 * Spoken file references as @-mentions: "at index dot tsx" and "index dot tsx file" become
 * "@index.tsx"; "at src slash app dot ts" becomes "@src/app.ts"; an already written "at app.ts"
 * becomes "@app.ts". `files` are real file names or workspace-relative paths (names only): a
 * reference that matches one is spelled like it (“at use auth dot ts” → “@useAuth.ts”). Without a
 * match a mention is made only for a known code extension and one plain name; anything else is
 * left alone.
 */
export function tagFileMentions(
  text: string,
  files: readonly string[] = [],
): string {
  const tokens = tokenize(text);
  const edits: { from: number; to: number; text: string }[] = [];
  let usedUntil = -1; // index of the first token an edit may still use

  const sentenceStart = (i: number) =>
    i === 0 || /[.!?…]$/u.test(tokens[i - 1].core + tokens[i - 1].trail);

  const decide = (
    firstToken: number,
    lastToken: number,
    elements: Element[],
    ext: string,
    explicit: boolean,
  ) => {
    const segments =
      elements.filter((e) => !e.word && e.text === "/").length + 1;
    const key = norm(elements.map((e) => e.text).join("") + ext);
    const spokenWords = elements.filter((e) => e.word);
    const multiword = elements.some((e, i) => e.word && elements[i - 1]?.word);
    let mention = realMatch(key, segments, files);
    if (!mention) {
      if (multiword || !spokenWords.length) return;
      mention = elements.map((e) => e.text).join("") + "." + ext;
      // A capital only because the sentence began.
      if (/^[A-Z][a-z0-9]*$/u.test(spokenWords[0].text) && !explicit)
        if (sentenceStart(firstToken))
          mention = mention[0].toLowerCase() + mention.slice(1);
    }
    const last = tokens[lastToken];
    edits.push({
      from: tokens[firstToken].start,
      to: last.end - last.trail.length,
      text: "@" + mention,
    });
    usedUntil = lastToken + 1;
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (i < usedUntil) continue;

    // Already written: "at app.ts", "src/app.ts file".
    const written = WRITTEN.exec(t.core);
    if (written && CODE_EXTENSIONS.has(written[1].toLowerCase())) {
      const prevAt =
        i > 0 && lower(tokens[i - 1]) === "at" && noTrail(tokens[i - 1]);
      const fileAfter = t.trail === "" && lower(tokens[i + 1]) === "file";
      if ((prevAt && i - 1 >= usedUntil) || fileAfter) {
        const first = prevAt && i - 1 >= usedUntil ? i - 1 : i;
        const last = fileAfter && !prevAt ? i + 1 : i;
        const path = t.core;
        const mention =
          realMatch(norm(path), path.split("/").length, files) ?? path;
        edits.push({
          from: tokens[first].start,
          to: tokens[last].end - tokens[last].trail.length,
          text: "@" + mention,
        });
        usedUntil = last + 1;
      }
      continue;
    }

    // Spoken: "<name> dot <ext>".
    const extToken = tokens[i + 1];
    const ext = lower(extToken);
    if (
      lower(t) !== "dot" ||
      !noTrail(t) ||
      !extToken ||
      !CODE_EXTENSIONS.has(ext) ||
      !/^[A-Za-z0-9]+$/u.test(extToken.core)
    )
      continue;

    // The chain of names joined by "slash", "dot", "underscore" or "dash" just before.
    const elements: Element[] = [];
    let j = i - 1;
    let chainStart = i;
    let wantWord = true;
    while (j >= usedUntil && noTrail(tokens[j])) {
      const w = lower(tokens[j]);
      const sep = SPOKEN_SEPARATORS[w];
      if (wantWord) {
        if (sep || !WORD.test(tokens[j].core)) break;
        elements.unshift({ word: true, text: tokens[j].core });
        chainStart = j;
        wantWord = false;
      } else {
        if (!sep) break;
        elements.unshift({ word: false, text: sep });
        wantWord = true;
        j--;
        continue;
      }
      j--;
    }
    // A chain can't start with a separator: drop dangling ones.
    while (elements.length && !elements[0].word) elements.shift();
    if (!elements.length) continue;

    const afterChain = chainStart - 1;
    const at = (k: number) =>
      k >= usedUntil && lower(tokens[k]) === "at" && noTrail(tokens[k]);
    const fileWord =
      extToken.trail === "" && lower(tokens[i + 2]) === "file"
        ? tokens[i + 2]
        : null;

    if (at(afterChain)) {
      decide(afterChain, i + 1, elements, ext, true);
    } else {
      // "at hooks slash use auth dot ts": plain words and separators between "at" and the
      // extension, matched against real files only.
      let k = afterChain;
      let words = 0;
      while (
        k >= usedUntil &&
        words <= MAX_NAME_WORDS &&
        noTrail(tokens[k]) &&
        WORD.test(tokens[k].core) &&
        !at(k)
      ) {
        if (!SPOKEN_SEPARATORS[lower(tokens[k])]) words++;
        k--;
      }
      if (
        at(k) &&
        words > 0 &&
        words + elements.filter((e) => e.word).length <= MAX_NAME_WORDS &&
        files.length
      ) {
        const spoken: Element[] = [];
        for (let m = k + 1; m <= afterChain; m++) {
          const sep = SPOKEN_SEPARATORS[lower(tokens[m])];
          spoken.push(
            sep
              ? { word: false, text: sep }
              : { word: true, text: tokens[m].core },
          );
        }
        spoken.push(...elements);
        const before = edits.length;
        decide(k, i + 1, spoken, ext, true);
        if (edits.length > before) continue;
      }
      if (fileWord && files.length) {
        // "the read me dot md file": a real file named by several plain words.
        for (
          let s = Math.max(0, usedUntil, chainStart - MAX_NAME_WORDS);
          s < chainStart;
          s++
        ) {
          const spoken: Element[] = [];
          let valid = true;
          for (let m = s; m < i && valid; m++) {
            const sep = SPOKEN_SEPARATORS[lower(tokens[m])];
            valid = noTrail(tokens[m]) && (!!sep || WORD.test(tokens[m].core));
            spoken.push(
              sep
                ? { word: false, text: sep }
                : { word: true, text: tokens[m].core },
            );
          }
          if (!valid || !spoken[0].word) continue;
          const before = edits.length;
          decide(s, i + 2, spoken, ext, false);
          if (edits.length > before) break;
        }
        if (i < usedUntil) continue;
      }
      if (fileWord) decide(chainStart, i + 2, elements, ext, false);
    }
  }

  if (!edits.length) return text;
  let out = "";
  let at = 0;
  for (const e of edits) {
    out += text.slice(at, e.from) + e.text;
    at = e.to;
  }
  return out + text.slice(at);
}

/** An identifier written in code, split into its words. */
export interface Identifier {
  name: string;
  /** Lowercase words: “getUserById” → get, user, by, id. */
  words: string[];
}

const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*(?:-[A-Za-z0-9]{2,})*/gu;
const WORDS_IN = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/gu;

function splitIdentifier(name: string): string[] {
  const kebab = name.includes("-");
  const parts = kebab ? name.split("-") : [name];
  const words = parts.flatMap((p) => p.match(WORDS_IN) ?? []);
  return words.map((w) => w.toLowerCase());
}

/** Multi-word identifiers (camelCase, PascalCase, snake_case, kebab-case, SCREAMING_CASE) in `text`. */
export function identifiersIn(text: string, max = 30): Identifier[] {
  const stats = new Map<
    string,
    { id: Identifier; count: number; last: number }
  >();
  for (const m of text.matchAll(IDENTIFIER)) {
    const name = m[0].replace(/^[_$]+|[_$]+$/g, "");
    if (name.length > 60) continue;
    const words = splitIdentifier(name);
    // One word is ordinary text; very long ones are not names.
    if (words.length < 2 || words.length > 6) continue;
    // A plain capitalised word or a sentence is not an identifier: it needs a code shape.
    const codeShape =
      /[a-z][A-Z]/u.test(name) ||
      /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+$/u.test(name) ||
      /[A-Za-z0-9]_[A-Za-z0-9]/u.test(name) ||
      /^[a-z0-9]+(?:-[a-z0-9]+)+$/u.test(name) ||
      /^[A-Z]+[A-Z0-9]*[a-z]/u.test(name);
    if (!codeShape) continue;
    const key = name;
    const prev = stats.get(key);
    stats.set(key, {
      id: { name, words },
      count: (prev?.count ?? 0) + 1,
      last: m.index,
    });
  }
  // The most used first, then the nearest the end of the window.
  return [...stats.values()]
    .sort((a, b) => b.count - a.count || b.last - a.last)
    .slice(0, max)
    .map((s) => s.id);
}

/** Identifier names as vocabulary hints for transcription. */
export function identifierHints(text: string, max = 30): string[] {
  return identifiersIn(text, max).map((i) => i.name);
}

/**
 * Spoken identifiers written as in the code: “user name” → `userName`, “get user by id” →
 * `getUserById`, when exactly that word sequence is an identifier in `identifiers` (the code near
 * the cursor). Only exact multi-word sequences, separated by single spaces, are replaced; the
 * longest identifier wins; nothing else in the text changes.
 */
export function applyIdentifiers(
  text: string,
  identifiers: readonly Identifier[],
): string {
  if (!identifiers.length) return text;
  // Same word sequence in two spellings: the first (most used, nearest) wins.
  const bySequence = new Map<string, Identifier>();
  for (const id of identifiers) {
    const key = id.words.join(" ");
    if (!bySequence.has(key)) bySequence.set(key, id);
  }
  const candidates = [...bySequence.values()].sort(
    (a, b) => b.words.length - a.words.length,
  );
  const words = [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({
    lower: m[0].toLowerCase(),
    start: m.index,
    end: m.index + m[0].length,
  }));
  let out = "";
  let at = 0;
  for (let i = 0; i < words.length;) {
    let hit: Identifier | null = null;
    for (const c of candidates) {
      const n = c.words.length;
      if (i + n > words.length) continue;
      let ok = true;
      for (let k = 0; k < n && ok; k++) {
        ok = words[i + k].lower === c.words[k];
        if (ok && k > 0)
          ok = text.slice(words[i + k - 1].end, words[i + k].start) === " ";
      }
      if (!ok) continue;
      const before = text[words[i].start - 1];
      const after = text[words[i + n - 1].end];
      // Not the middle of something already written in code: a.user name, user_name, user-name.
      if (before && /[_$.@-]/u.test(before)) continue;
      if (after && /[_$-]/u.test(after)) continue;
      hit = c;
      break;
    }
    if (hit) {
      const last = words[i + hit.words.length - 1];
      out += text.slice(at, words[i].start) + hit.name;
      at = last.end;
      i += hit.words.length;
    } else i++;
  }
  return out + text.slice(at);
}
