// Settings schema shared by main and renderer. Secrets (API keys) are never part of this object;
// they live in the OS-encrypted secret store and are referenced by presence only.
import { z } from "zod";
import { checkServerUrl, DEFAULT_SERVER_URL } from "./server-url.ts";
import {
  LANGUAGE_CODE,
  MAX_LANGUAGES,
  migrateLanguages,
  reconcileLanguages,
} from "./languages.ts";
import { ProfileSchema } from "./onboarding.ts";

export const SPEECH_PROVIDERS = [
  "openai",
  "groq",
  "deepgram",
  "gemini",
  "whisper.cpp",
] as const;
export const AI_PROVIDERS = ["groq", "openai", "anthropic", "gemini"] as const;
export const CLEANUP_MODES = ["off", "deterministic", "ai"] as const;
export const APPEARANCES = ["system", "light", "dark"] as const;

const LOCAL_SERVER_URL = "http://127.0.0.1:8178";

/** An http(s) URL on this Mac (localhost, 127.0.0.1 or ::1). */
export function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      (u.protocol === "http:" || u.protocol === "https:") &&
      ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
    );
  } catch {
    return false;
  }
}
const LoopbackUrl = z
  .string()
  .refine(
    isLoopbackUrl,
    "Use an address on this Mac (localhost or 127.0.0.1).",
  );

const CleanupSchema = z
  .object({
    /** "deterministic" is the default and the fallback; "ai" needs a configured provider. */
    mode: z.enum(CLEANUP_MODES).default("deterministic"),
    aiProvider: z.enum(AI_PROVIDERS).default("groq"),
    aiModel: z.string().default(""),
    /** Configurable target: the AI call falls back to deterministic cleanup after this. */
    aiTimeoutMs: z.number().int().min(500).max(30000).default(4000),
  })
  .prefault({});

/** M1 stored `cleanup` as "off" | "light"; map it onto the M2 object. */
const CleanupCompat = z.preprocess(
  (v) =>
    v === "light"
      ? { mode: "deterministic" }
      : v === "off"
        ? { mode: "off" }
        : v,
  CleanupSchema,
);

const WritingStyleSchema = z.enum(["formal", "casual", "veryCasual"]);

export const SettingsSchema = z.object({
  version: z.literal(1).default(1),
  onboardingCompleted: z.boolean().default(false),
  shortcut: z.string().min(1).default("ctrl+opt+space"),
  speech: z
    .object({
      provider: z.enum(SPEECH_PROVIDERS).default("openai"),
      model: z.string().default(""),
      /** The single code older versions stored ("" = automatic); mirrors `languages`. */
      language: z.string().default(""),
      /** The languages you speak: one transcribes with it, several detect automatically. */
      languages: z
        .array(z.string().regex(LANGUAGE_CODE))
        .max(MAX_LANGUAGES)
        .default([]),
      /** Loopback only: recordings never go to another machine through this setting. */
      localServerUrl:
        LoopbackUrl.default(LOCAL_SERVER_URL).catch(LOCAL_SERVER_URL),
      /** Configurable target (approved: a target, not a fixed limit). Batch providers need more than the streaming 1.2 s. */
      timeoutMs: z.number().int().min(1000).max(120000).default(30000),
    })
    .prefault({}),
  cleanup: CleanupCompat,
  dictionary: z
    .object({
      enabled: z.boolean().default(true),
      /** Send dictionary phrases to the speech provider as vocabulary hints (M0: 2.5× fewer term errors). */
      useAsVocabulary: z.boolean().default(true),
    })
    .prefault({}),
  snippets: z.object({ enabled: z.boolean().default(true) }).prefault({}),
  capsule: z.enum(["always", "whileActive"]).default("always"),
  /** Window theme; "system" follows macOS. Applied through Electron nativeTheme. */
  appearance: z.enum(APPEARANCES).default("system"),
  history: z
    .object({
      enabled: z.boolean().default(true),
      audioRetentionDays: z.number().int().min(0).max(30).default(7),
      /** 0 = keep forever. */
      historyRetentionDays: z.number().int().min(0).max(3650).default(0),
      /** Keep every dictation's encrypted recording (not only failed ones) for playback. */
      keepRecordings: z.boolean().default(false),
    })
    .prefault({}),
  /** Settings → System (Stage 6A). Launch at login lives in macOS, not here. */
  system: z
    .object({
      /** Show the Dock icon; off keeps Murmur a menu-bar app (the M1 behaviour). */
      showInDock: z.boolean().default(false),
      /** Short sounds after recording stops and when a dictation finishes or fails. */
      sounds: z.boolean().default(false),
      /** Stage E: silence other audio while the microphone records a dictation. */
      muteWhileDictating: z.boolean().default(false),
    })
    .prefault({}),
  /**
   * Transforms (Stage 9C). Off until the person opts in: only then are the transform shortcuts
   * registered (they take keys such as ⌥1 from other apps).
   */
  transforms: z
    .object({
      optIn: z.boolean().default(false),
    })
    .prefault({}),
  /** Notetaker (Stage 9D-1): Set up Notetaker and how long meetings are kept. */
  notetaker: z
    .object({
      setupCompleted: z.boolean().default(false),
      /** The "Set up Notetaker" card on the Notetaker page was skipped. */
      setupCardDismissed: z.boolean().default(false),
      /** You confirmed you'll tell people before recording them (asked in setup). */
      consentAcknowledged: z.boolean().default(false),
      /** 0 = keep meetings until you delete them. */
      retentionDays: z
        .union([z.literal(0), z.literal(30), z.literal(90), z.literal(365)])
        .default(0),
      /** Record your Mac's sound (other people in a call) along with the microphone. */
      systemAudio: z.boolean().default(true),
      /** Recording stops by itself at this length, with a warning a minute before. */
      maxRecordingMinutes: z
        .union([z.literal(30), z.literal(60), z.literal(120), z.literal(240)])
        .default(120),
      /**
       * Keep your microphone and your Mac's sound apart and label the transcript You / Others
       * (each track is transcribed separately, so about twice the requests).
       */
      speakerLabels: z.boolean().default(true),
      /**
       * AI services the person agreed to send meeting transcripts and notes to for summaries.
       * Separate from the Scratchpad/Transforms consent: a transcript holds other people's words.
       */
      summaryConsent: z.array(z.enum(AI_PROVIDERS)).default([]),
      /** The last "Allow" for your Mac's sound (macOS can't be asked without prompting). */
      systemAudioAccess: z
        .enum(["unknown", "allowed", "denied"])
        .default("unknown"),
    })
    .prefault({}),
  /** First-run survey answers (shared/onboarding.ts). Kept on this Mac only. */
  profile: ProfileSchema.prefault({}),
  /**
   * Local MCP server (Settings → MCP): lets AI apps on this Mac read Notetaker meetings. Off
   * until the person turns it on; it listens on 127.0.0.1 only.
   */
  mcp: z
    .object({
      enabled: z.boolean().default(false),
      port: z.number().int().min(1024).max(65535).default(47821),
    })
    .prefault({}),
  /** Scratchpad (Stage 9B): what opening it shows, and the editor's text style. */
  scratchpad: z
    .object({
      /** "resume": the note opened last; "new": a new, empty note. */
      openBehavior: z.enum(["resume", "new"]).default("resume"),
      font: z.enum(["sans", "serif", "mono"]).default("sans"),
      size: z.enum(["small", "medium", "large"]).default("medium"),
      /** AI services the person agreed to send note text to (asked on first use of each). */
      aiConsent: z.array(z.enum(AI_PROVIDERS)).default([]),
    })
    .prefault({}),
  /**
   * Settings → General → Microphone (Stage 6B). Changed only through the microphone service,
   * which checks the device is connected; never through a settings patch.
   */
  microphone: z
    .object({
      /** Chromium device id; null = follow the macOS default input. */
      deviceId: z.string().min(1).nullable().default(null),
      /** Its name when chosen, to say which microphone is missing; never used to find it. */
      name: z.string().nullable().default(null),
    })
    .prefault({}),
  /**
   * Optional global shortcuts for the last-transcript actions (Stage 6B), unset by default so
   * Murmur takes no keys from other apps until asked. Saved only after macOS registered them;
   * never through a settings patch.
   */
  shortcuts: z
    .object({
      pasteLast: z.string().min(1).nullable().default(null),
      copyLast: z.string().min(1).nullable().default(null),
      copyOriginal: z.string().min(1).nullable().default(null),
      openScratchpad: z.string().min(1).nullable().default(null),
      transformViewChanges: z.string().min(1).nullable().default(null),
      commandMode: z.string().min(1).nullable().default(null),
      pressEnter: z.string().min(1).nullable().default(null),
      startNotetaker: z.string().min(1).nullable().default(null),
    })
    .prefault({}),
  /** Stage E part 2: the writing style for each kind of app (Style page tabs). */
  styles: z
    .object({
      personal: WritingStyleSchema.default("formal"),
      work: WritingStyleSchema.default("formal"),
      email: WritingStyleSchema.default("formal"),
      other: WritingStyleSchema.default("formal"),
    })
    .prefault({}),
  /**
   * Stage E part 2 (M3), both off by default: reading text near the cursor to spell names
   * (Data and Privacy → Context awareness), and checking the field after a dictation to learn
   * words you corrected (System → Auto-add to dictionary). Nothing read is kept.
   */
  context: z
    .object({
      awareness: z.boolean().default(false),
      autoAddCorrections: z.boolean().default(false),
    })
    .prefault({}),
  /**
   * Vibe coding (Settings → Vibe coding), both off by default, only in VS Code, Cursor and
   * Windsurf: spoken file names become @-mentions (reads the window title and file names), and
   * spoken variable names are written as the identifiers near the cursor (reads nearby code
   * while you dictate). Nothing read is kept.
   */
  vibeCoding: z
    .object({
      fileTagging: z.boolean().default(false),
      variables: z.boolean().default(false),
    })
    .prefault({}),
  /**
   * The Murmur account (Settings → Account). Nothing account-related runs or contacts a server
   * until the person signs in; the sign-in itself is kept in the Keychain, never here.
   */
  account: z
    .object({
      /** https, or http on this Mac; anything else falls back to the default. */
      serverUrl: z
        .string()
        .refine((u) => checkServerUrl(u, { packaged: true }).ok)
        .default(DEFAULT_SERVER_URL)
        .catch(DEFAULT_SERVER_URL),
      /**
       * The account this Mac's Murmur data was last used with. When someone else signs in,
       * Murmur asks whether to keep that data or start fresh. Never sent anywhere.
       */
      owner: z
        .object({ id: z.string().max(200), email: z.string().max(320) })
        .nullable()
        .default(null)
        .catch(null),
    })
    .prefault({}),
  /**
   * Settings → Connectors. Calendar reads events from macOS Calendar (EventKit) only while
   * `enabled`; the person turns it on with Connect and off with Disconnect. Reminders are a
   * notice a minute before a meeting with a link; they never start a recording.
   */
  connectors: z
    .object({
      calendar: z
        .object({
          enabled: z.boolean().default(false),
          reminders: z.boolean().default(false),
        })
        .prefault({}),
    })
    .prefault({}),
  privacy: z
    .object({
      /** Fixed by product decision; present so the UI can show it. */
      cloudHistory: z.literal(false).default(false),
      trainingOptIn: z.literal(false).default(false),
    })
    .prefault({}),
});

export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

const partialObject = <T extends z.ZodObject>(schema: T) =>
  schema.partial().optional();

/**
 * Partial, one-level-deep update accepted from the renderer. The microphone, the extra
 * shortcuts and the account (its server address decides where the sign-in token is sent) are
 * left out: the first two have their own validated paths, the last has none from the renderer.
 */
export const SettingsPatchSchema = SettingsSchema.omit({
  microphone: true,
  shortcuts: true,
  account: true,
})
  .partial()
  .extend({
    // A patch must name a valid local address; it never silently falls back to the default.
    speech: partialObject(
      SettingsSchema.shape.speech
        .unwrap()
        .extend({ localServerUrl: LoopbackUrl }),
    ),
    cleanup: partialObject(CleanupSchema.unwrap()),
    dictionary: partialObject(SettingsSchema.shape.dictionary.unwrap()),
    snippets: partialObject(SettingsSchema.shape.snippets.unwrap()),
    history: partialObject(SettingsSchema.shape.history.unwrap()),
    system: partialObject(SettingsSchema.shape.system.unwrap()),
    scratchpad: partialObject(SettingsSchema.shape.scratchpad.unwrap()),
    transforms: partialObject(SettingsSchema.shape.transforms.unwrap()),
    notetaker: partialObject(SettingsSchema.shape.notetaker.unwrap()),
    mcp: partialObject(SettingsSchema.shape.mcp.unwrap()),
    styles: partialObject(SettingsSchema.shape.styles.unwrap()),
    context: partialObject(SettingsSchema.shape.context.unwrap()),
    vibeCoding: partialObject(SettingsSchema.shape.vibeCoding.unwrap()),
    connectors: partialObject(SettingsSchema.shape.connectors.unwrap()),
    profile: partialObject(SettingsSchema.shape.profile.unwrap()),
  });
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

const NESTED = [
  "speech",
  "cleanup",
  "dictionary",
  "snippets",
  "history",
  "system",
  "scratchpad",
  "transforms",
  "notetaker",
  "mcp",
  "styles",
  "context",
  "vibeCoding",
  "account",
  "connectors",
  "profile",
] as const;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Keeps only the keys the caller sent, at every depth (see parseSettingsPatch). */
function onlySent(parsed: unknown, sent: unknown): unknown {
  if (!isPlainObject(parsed) || !isPlainObject(sent)) return parsed;
  return Object.fromEntries(
    Object.keys(sent).flatMap((k) =>
      k in parsed ? [[k, onlySent(parsed[k], sent[k])]] : [],
    ),
  );
}

/** `{...a, ...b}` that merges nested objects instead of replacing them. */
function deepMerge(a: unknown, b: unknown): unknown {
  if (!isPlainObject(a) || !isPlainObject(b)) return b === undefined ? a : b;
  const out: Record<string, unknown> = { ...a };
  for (const k of Object.keys(b)) out[k] = deepMerge(a[k], b[k]);
  return out;
}

/**
 * Validates a renderer patch and keeps only the keys it actually contains. Zod 4 fills in
 * `.default()` values even for fields a `.partial()` schema marks optional, so the parsed patch
 * would otherwise carry defaults for everything the caller left out, and applying it would
 * silently reset onboarding, the shortcut, appearance and sibling options.
 */
export function parseSettingsPatch(input: unknown): SettingsPatch {
  const parsed = SettingsPatchSchema.parse(input) as Record<string, unknown>;
  const raw = (input ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (!(key in parsed)) continue;
    const value = parsed[key];
    const sent = raw[key];
    out[key] = (NESTED as readonly string[]).includes(key)
      ? onlySent(value, sent)
      : value;
  }
  return out as SettingsPatch;
}

/**
 * The settings after a validated patch. Every nested group in NESTED is merged field by field,
 * so a patch naming one field keeps its siblings (a group replaced whole would be refilled with
 * defaults: e.g. turning off “Record your Mac's sound” would undo Set up Notetaker).
 */
export function applyPatch(current: Settings, patch: SettingsPatch): Settings {
  const merged: Record<string, unknown> = { ...current, ...patch };
  for (const key of NESTED)
    merged[key] = deepMerge(
      current[key],
      (patch as Record<string, object | undefined>)[key] ?? {},
    );
  merged.privacy = current.privacy;
  const next = SettingsSchema.parse(merged);
  // `language` and `languages` describe one choice: whichever the patch named wins.
  return {
    ...next,
    speech: reconcileLanguages(next.speech, patch.speech ?? {}),
  };
}

/** Settings saved by an older version, brought up to date (not written until the next save). */
export function migrateSettings(settings: Settings): Settings {
  return { ...settings, speech: migrateLanguages(settings.speech) };
}
