// What the dictation controller takes from Settings (used by createApp at start and on every
// change, and by the restart journeys in test/journeys.test.ts).
import { effectiveLanguage } from "../../shared/languages.ts";
import type { Settings } from "../../shared/settings.ts";

export function controllerConfig(s: Settings) {
  return {
    cleanupLevel: (s.cleanup.mode === "off" ? "off" : "light") as
      "off" | "light",
    language: effectiveLanguage(s).language,
    languageHints: effectiveLanguage(s).hints,
    transcribeTimeoutMs: s.speech.timeoutMs,
    historyEnabled: s.history.enabled,
    keepRecordings: s.history.keepRecordings,
  };
}
