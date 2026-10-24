// Pure Settings logic (no React), unit-tested under Node (test/settings.test.ts).
import {
  BINDING_NAMES,
  type DictationRow,
  type PermissionsInfo,
  type SecureStorageInfo,
} from "../../../shared/ipc.ts";
import type { Settings } from "../../../shared/settings.ts";
import type { Tone } from "./tone.ts";

export const DEFAULT_SHORTCUT = "ctrl+opt+space";

/** Keys the native validator accepts besides modifiers (murmur-core shortcut.rs). */
const NAMED_CODES: Record<string, string> = {
  Space: "space",
  Tab: "tab",
  Enter: "return",
  Escape: "escape",
  NumpadEnter: "return",
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

function keyName(code: string, key: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9])$/.test(code)) return code.toLowerCase();
  if (NAMED_CODES[code]) return NAMED_CODES[code];
  // Synthetic events may carry no code; fall back to the key value.
  if (!code) {
    if (/^[a-z0-9]$/i.test(key)) return key.toLowerCase();
    if (/^F([1-9]|1[0-9])$/.test(key)) return key.toLowerCase();
    if (key === " ") return "space";
  }
  return null;
}

const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta", "Fn"]);

export type RecordedKey =
  | { kind: "modifiers"; preview: string }
  | { kind: "cancel" }
  | { kind: "unsupported"; key: string }
  | { kind: "combo"; combo: string };

/**
 * Turns a keydown in the shortcut recorder into a shortcut string the native validator
 * understands ("ctrl+opt+space"). Uses the physical key (`code`), so Option+letter works even
 * though it types a special character.
 */
export function recordKey(e: {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}): RecordedKey {
  const mods = [
    e.ctrlKey && "ctrl",
    e.altKey && "opt",
    e.shiftKey && "shift",
    e.metaKey && "cmd",
  ].filter(Boolean) as string[];
  if (MODIFIER_KEYS.has(e.key))
    return { kind: "modifiers", preview: mods.join("+") };
  if (e.key === "Escape" && mods.length === 0) return { kind: "cancel" };
  const name = keyName(e.code, e.key);
  if (!name) return { kind: "unsupported", key: e.key };
  return { kind: "combo", combo: [...mods, name].join("+") };
}

const SHORTCUT_ERRORS: Record<string, string> = {
  empty: "Press a key together with one or more modifiers.",
  "too-many-keys":
    "Use at most two modifiers with one key, such as Control-Option-Space.",
  "needs-modifier":
    "Add Control, Option or Command, so the key still types normally.",
  "escape-alone-reserved-for-cancel":
    "Esc is reserved for cancelling a dictation.",
  "shift-only-blocks-typing":
    "Shift alone with a key would block typing capitals. Add Control or Option.",
  "shift-alone-blocks-typing":
    "Shift alone with a key would block typing. Add Control or Option.",
  "single-left-modifier-too-common":
    "That combination is used too often while typing. Add a second modifier.",
  "system-reserved": "macOS uses that shortcut.",
  "control-letter-used-by-text-editing":
    "Control with one letter is used for editing text and in Terminal (⌃A moves to the start of a line). Add Option or Shift.",
  "command-letter-used-by-apps":
    "Apps use Command with a letter or number (⌘B, ⌘F, ⌘1). Add Option, Control or Shift.",
  "sided-modifier-must-be-alone":
    "Shortcuts made only of modifier keys aren't supported in this version.",
  "modifier-only-requires-hold-action":
    "Shortcuts made only of modifier keys aren't supported in this version.",
};

/** Readable message for a validator error code (unknown codes pass through). */
export function shortcutMessage(code: string): string {
  const own = /used-by:(\w+)/.exec(code)?.[1] as
    keyof typeof BINDING_NAMES | undefined;
  if (own && BINDING_NAMES[own])
    return `Murmur already uses that shortcut for ${BINDING_NAMES[own]}.`;
  if (code.startsWith("needs-input-monitoring"))
    return "fn (Globe) and shortcuts made only of modifier keys need Input Monitoring, which this version doesn't use.";
  if (code.startsWith("unknown key"))
    return "Use a letter, number, Space, Tab, Return, an arrow key or F1–F19.";
  return SHORTCUT_ERRORS[code] ?? code;
}

/** Shown beside a shortcut saved before the editing-keys rule existed (it keeps working). */
export function editingConflictNotice(
  code: "control-letter-used-by-text-editing" | "command-letter-used-by-apps",
  combo: string,
): string {
  const key = combo.split("+").pop()?.trim().toUpperCase() ?? "";
  return code === "control-letter-used-by-text-editing"
    ? `Control-${key} is also used for editing text. Choose another shortcut.`
    : `Command-${key} is also used by apps. Choose another shortcut.`;
}

export const SHORTCUT_WARNINGS: Record<string, string> = {
  "function-key-may-be-media-key":
    "On many keyboards F-keys control brightness or volume unless you hold fn or turn on “Use F1, F2, etc. keys as standard function keys”.",
};

export const SPEECH_LABELS: Record<Settings["speech"]["provider"], string> = {
  openai: "OpenAI",
  groq: "Groq",
  deepgram: "Deepgram",
  gemini: "Google Gemini",
  "whisper.cpp": "whisper.cpp (local server, development)",
};

export const AI_LABELS: Record<Settings["cleanup"]["aiProvider"], string> = {
  groq: "Groq",
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
};

/** The AI cleanup models that passed `npm run eval -w packages/refine`. */
export const QUALITY_CHECKED_AI: {
  provider: Settings["cleanup"]["aiProvider"];
  model: string;
}[] = [{ provider: "groq", model: "openai/gpt-oss-120b" }];

/** Whether this provider and model passed the quality check. An empty model is Groq's default, the one checked. */
export function aiQualityChecked(
  provider: Settings["cleanup"]["aiProvider"],
  model: string,
): boolean {
  const m = model.trim() || (provider === "groq" ? "openai/gpt-oss-120b" : "");
  return QUALITY_CHECKED_AI.some(
    (q) => q.provider === provider && q.model === m,
  );
}

const isLocalUrl = (url: string) =>
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(url.trim());

/**
 * What leaves this Mac with the current settings, one line per kind of data. Derived only from
 * settings, so it changes as soon as a setting does.
 */
export function privacyFlows(s: Settings): { label: string; value: string }[] {
  const speech = s.speech.provider;
  const audio =
    speech === "whisper.cpp"
      ? isLocalUrl(s.speech.localServerUrl)
        ? "Sent to the whisper.cpp server on this Mac; it doesn't leave the Mac."
        : `Sent to the whisper.cpp server at ${s.speech.localServerUrl}.`
      : `Sent to ${SPEECH_LABELS[speech]} to be transcribed, for every dictation.`;
  const text =
    s.cleanup.mode === "ai"
      ? `The transcript of every dictation is sent to ${AI_LABELS[s.cleanup.aiProvider]} for AI cleanup.`
      : "Not sent anywhere. Cleanup runs on this Mac.";
  const words =
    s.dictionary.enabled && s.dictionary.useAsVocabulary
      ? speech === "whisper.cpp" && isLocalUrl(s.speech.localServerUrl)
        ? "Up to 100 words go to the local whisper.cpp server as hints."
        : `Up to 100 words are sent to ${SPEECH_LABELS[speech]} with each dictation as hints.`
      : "Not sent.";
  return [
    { label: "Audio", value: audio },
    { label: "Transcripts", value: text },
    { label: "Dictionary words", value: words },
    {
      label: "Stays on this Mac",
      value: s.history.enabled
        ? "History, dictionary, snippets, settings, API keys (encrypted) and encrypted recordings."
        : "Dictionary, snippets, settings and API keys (encrypted). History is off, so dictations aren't kept.",
    },
  ];
}

export const MICROPHONE_STATE: Record<
  PermissionsInfo["microphone"],
  { tone: Tone; label: string; help: string }
> = {
  granted: {
    tone: "success",
    label: "Allowed",
    help: "Murmur can record while you hold the shortcut.",
  },
  "not-determined": {
    tone: "warning",
    label: "Not asked yet",
    help: "macOS will ask once. Murmur only records while you hold the shortcut.",
  },
  denied: {
    tone: "danger",
    label: "Blocked",
    help: "Turn Murmur on in System Settings → Privacy & Security → Microphone, then come back.",
  },
  restricted: {
    tone: "danger",
    label: "Restricted",
    help: "A device policy (such as Screen Time or a management profile) blocks the microphone. Murmur can't change this.",
  },
  unknown: {
    tone: "neutral",
    label: "Unknown",
    help: "macOS didn't report the microphone status.",
  },
};

/**
 * Readiness messages are written for the capsule and Home ("… Open Settings → AI cleanup.");
 * inside Settings that pointer is dropped, and a leading provider id gets its proper name.
 */
export function inSettings(
  message: string,
  names: Record<string, string> = {},
): string {
  let m = message.replace(/\s*Open Settings\s*→\s*[^.]+\.?\s*$/, "").trim();
  for (const [id, name] of Object.entries(names))
    m = m.replace(new RegExp(`^${id.replace(/\./g, "\\.")}\\b`, "i"), name);
  return m;
}

/**
 * Whether the selected provider is known to work, from real evidence only: the provider's own
 * readiness check (credentials present) and the most recent dictation it handled.
 */
export function providerState(
  readiness: string | null,
  latest: DictationRow | null,
): { tone: Tone; label: string; detail: string | null } {
  if (readiness)
    return {
      tone: "danger",
      label: "Not set up",
      detail: inSettings(readiness),
    };
  if (!latest)
    return {
      tone: "neutral",
      label: "Ready, not used yet",
      detail:
        "The key is saved. Murmur checks the connection when you dictate.",
    };
  if (latest.status === "failed")
    return { tone: "danger", label: "Last dictation failed", detail: null };
  return { tone: "success", label: "Last dictation worked", detail: null };
}

/** The most recent finished dictation handled by `provider` (rows newest first). */
export function latestFor(
  rows: DictationRow[],
  provider: string,
): DictationRow | null {
  return (
    rows.find(
      (r) =>
        r.provider === provider &&
        r.status !== "transcribing" &&
        r.status !== "cancelled",
    ) ?? null
  );
}

/**
 * Settings → Data and Privacy: what the Keychain allows right now (Stage 8). A UI wait is never
 * presented as a refusal: "checking" means macOS is still asking (a dialog may be open).
 */
export function secureStorageText(info: SecureStorageInfo): {
  tone: "success" | "neutral" | "warning" | "danger";
  label: string;
  detail: string;
  retry: boolean;
} {
  if (info.state === "checking")
    return {
      tone: "neutral",
      label: "Waiting for the Keychain",
      detail:
        "macOS is asking whether Murmur may use its Keychain item. Until you answer, saved API keys and recordings can't be used; everything else works.",
      retry: false,
    };
  if (info.state === "unavailable")
    return {
      tone: "warning",
      label: "Keychain not available",
      detail:
        "Murmur couldn't use the Keychain (access was denied or not answered). Saved API keys and recordings are kept, unchanged, and work again once access is allowed.",
      retry: true,
    };
  if (info.recordings === "unreadable" || info.unreadableKeys > 0)
    return {
      tone: "danger",
      label: "Some data can't be read",
      detail:
        info.recordings === "unreadable"
          ? "The key that protects recordings kept for retry can't be read. They are kept, not replaced. To keep recordings again, start a new key; the old ones stay aside, unopened."
          : "A saved API key can't be read from the Keychain. Enter it again in Transcription or AI cleanup.",
      retry: true,
    };
  return {
    tone: "success",
    label: "Protected by the Keychain",
    detail:
      "API keys and saved recordings are encrypted with a key kept in the macOS Keychain.",
    retry: false,
  };
}
