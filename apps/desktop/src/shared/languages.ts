// The languages the person speaks (Settings → General → Language, and the first-run setup).
// `speech.languages` is the list; `speech.language` stays as the single code older versions
// stored ("" = automatic) and always mirrors the list: it is the code when exactly one language
// is chosen, and "" otherwise.

/** A language code: ISO 639-1/-3, optionally with a region ("pt-BR"). */
export const LANGUAGE_CODE = /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/;
export const MAX_LANGUAGES = 8;

export interface SpeechLanguages {
  language: string;
  languages: string[];
}

/** Lower-cased, valid, unique and at most MAX_LANGUAGES, in the order given. */
export function normalizeLanguages(list: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const code = raw.trim().toLowerCase();
    if (LANGUAGE_CODE.test(code) && !out.includes(code)) out.push(code);
  }
  return out.slice(0, MAX_LANGUAGES);
}

/** The chosen languages, falling back to the single legacy code. */
export function spokenLanguages(speech: SpeechLanguages): string[] {
  const list = normalizeLanguages(speech.languages);
  return list.length ? list : normalizeLanguages([speech.language]);
}

export interface EffectiveLanguage {
  /** The language sent to the provider; "" lets it detect the language. */
  language: string;
  /**
   * The languages to name to a provider that takes a hint while it detects (only with two or
   * more languages; empty otherwise). Providers without such a setting ignore it.
   */
  hints: string[];
}

/**
 * One language: transcribe with it. None: automatic detection. Two or more: automatic
 * detection, with the list as a hint where the provider supports one (Gemini).
 */
export function effectiveLanguage(settings: {
  speech: SpeechLanguages;
}): EffectiveLanguage {
  const list = spokenLanguages(settings.speech);
  if (list.length === 1) return { language: list[0], hints: [] };
  return { language: "", hints: list.length > 1 ? list : [] };
}

/** `speech` after a patch changed `language` or `languages`: the two never disagree. */
export function reconcileLanguages<T extends SpeechLanguages>(
  speech: T,
  patched: { language?: unknown; languages?: unknown },
): T {
  if (patched.languages !== undefined) {
    const languages = normalizeLanguages(speech.languages);
    return {
      ...speech,
      languages,
      language: languages.length === 1 ? languages[0] : "",
    };
  }
  if (patched.language !== undefined) {
    const languages = normalizeLanguages([speech.language]);
    return { ...speech, languages, language: languages[0] ?? "" };
  }
  return speech;
}

/** Settings saved before `languages` existed: "uz" becomes ["uz"]. */
export function migrateLanguages<T extends SpeechLanguages>(speech: T): T {
  if (speech.languages.length || !speech.language) return speech;
  return reconcileLanguages(speech, { language: speech.language });
}
