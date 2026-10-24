// Settings sections and the places that link into them (pure; unit-tested in
// test/settings.test.ts). Stage 5 follows the reference's grouping: General holds the shortcut,
// microphone, dictation language and appearance; System holds the Capsule and pasting. Older
// links (`settings/shortcuts`, `settings/microphone`, readiness steps, smoke and capture) keep
// working through targets that open the right section and, where there is one, its dialog.

/** Settings sheet sections, in navigation order (labels and icons live in SettingsSheet). */
export const SETTINGS_SECTION_IDS = [
  "general",
  "system",
  "notetaker",
  "transcription",
  "ai",
  "library",
  "connectors",
  "vibeCoding",
  "mcp",
  "account",
  "team",
  "billing",
  "privacy",
  "about",
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

/** Focused dialogs opened from a section row. */
export type SettingsDialog = "shortcuts" | "language" | "microphone";

/** Anything that can be opened: a section, or a row's dialog by name. */
export const SETTINGS_TARGETS = [
  ...SETTINGS_SECTION_IDS,
  "shortcuts",
  "microphone",
  "language",
] as const;

export type SettingsTarget = (typeof SETTINGS_TARGETS)[number];

export function isSettingsSection(
  s: string | undefined,
): s is SettingsSectionId {
  return (SETTINGS_SECTION_IDS as readonly string[]).includes(s ?? "");
}

export function isSettingsTarget(s: string | undefined): s is SettingsTarget {
  return (SETTINGS_TARGETS as readonly string[]).includes(s ?? "");
}

/** Where a target opens: the section, plus a dialog for the shortcut, microphone and language rows. */
export function resolveSettingsTarget(t: SettingsTarget): {
  section: SettingsSectionId;
  dialog: SettingsDialog | null;
} {
  switch (t) {
    case "shortcuts":
      return { section: "general", dialog: "shortcuts" };
    case "language":
      return { section: "general", dialog: "language" };
    case "microphone":
      return { section: "general", dialog: "microphone" };
    default:
      return { section: t, dialog: null };
  }
}
