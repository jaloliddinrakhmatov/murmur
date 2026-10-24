// Dictation languages (pure; unit-tested in test/settings.test.ts). Murmur sends one language
// code to the transcription service, or none for automatic detection; the list only offers
// languages the configured service accepts.
import type { Settings } from "../../../shared/settings.ts";
import { searchKey } from "./library.ts";

export interface Language {
  code: string;
  name: string;
  /** The language's own name, shown under the English one (reference tiles). */
  native: string;
}

export const LANGUAGES: Language[] = [
  { code: "en", name: "English", native: "English" },
  { code: "uz", name: "Uzbek", native: "Oʻzbek" },
  { code: "ru", name: "Russian", native: "Русский" },
  { code: "kk", name: "Kazakh", native: "Қазақ" },
  { code: "tr", name: "Turkish", native: "Türkçe" },
  { code: "de", name: "German", native: "Deutsch" },
  { code: "fr", name: "French", native: "Français" },
  { code: "es", name: "Spanish", native: "Español" },
  { code: "pt", name: "Portuguese", native: "Português" },
  { code: "it", name: "Italian", native: "Italiano" },
  { code: "uk", name: "Ukrainian", native: "Українська" },
  { code: "ar", name: "Arabic", native: "العربية" },
  { code: "hi", name: "Hindi", native: "हिन्दी" },
  { code: "zh", name: "Chinese", native: "中文" },
  { code: "ja", name: "Japanese", native: "日本語" },
  { code: "ko", name: "Korean", native: "한국어" },
];

/**
 * Whisper-based services (OpenAI, Groq, whisper.cpp) accept all of the above. For Deepgram's
 * default model (nova-3): the languages its documentation lists (Models & Languages overview,
 * checked 2026-10-17) that Murmur offers — every one except Uzbek. Documented support, not
 * verified against the live service (no paid requests were authorised).
 */
const DEEPGRAM = new Set([
  "en",
  "ru",
  "kk",
  "tr",
  "de",
  "fr",
  "es",
  "pt",
  "it",
  "uk",
  "ar",
  "hi",
  "zh",
  "ja",
  "ko",
]);

export function languagesFor(
  provider: Settings["speech"]["provider"],
): Language[] {
  return provider === "deepgram"
    ? LANGUAGES.filter((l) => DEEPGRAM.has(l.code))
    : LANGUAGES;
}

/** Display name of a stored code: "" is automatic; unknown codes are shown as stored. */
export function languageName(code: string): string {
  if (!code) return "Detect automatically";
  return LANGUAGES.find((l) => l.code === code)?.name ?? `Other (${code})`;
}

/** True when the stored code can't be sent to this service (it would be rejected). */
export function languageUnsupported(
  code: string,
  provider: Settings["speech"]["provider"],
): boolean {
  return Boolean(code) && !languagesFor(provider).some((l) => l.code === code);
}

/** Case- and accent-insensitive key: “Français” matches “francais”. */
const fold = (s: string) =>
  searchKey(s).normalize("NFD").replace(/\p{M}/gu, "");

/** Search by English or native name. */
export function filterLanguages(list: Language[], query: string): Language[] {
  const q = fold(query);
  if (!q) return list;
  return list.filter(
    (l) => fold(l.name).includes(q) || fold(l.native).includes(q),
  );
}
