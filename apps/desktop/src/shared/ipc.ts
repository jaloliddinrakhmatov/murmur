// IPC contract between the main process and the three renderers. Payloads crossing from a
// renderer into main are validated with these schemas before use.
import { z } from "zod";
import type { Settings } from "./settings.ts";
import type { HistoryStats } from "./stats.ts";
import type { MicrophoneDevice } from "./microphones.ts";
import type { Insights } from "./insights.ts";
import type { CalendarStatus, UpcomingMeeting } from "./calendar.ts";
import type { Note, NoteSummary } from "./notes.ts";
import type {
  Meeting,
  MeetingSaveResult,
  MeetingSort,
  MeetingSummary,
  NotetakerReadiness,
  RecordingState,
  TranscriptionProgress,
} from "./meetings.ts";
import type { PolishRules, Transform } from "./transforms.ts";
import type { AccountApi } from "./account.ts";
import type { McpHub } from "./mcp.ts";
import type {
  PracticeTextEvent,
  ShortcutStateEvent,
  SystemAudioStatus,
} from "./onboarding.ts";

export type TransformWithStatus = Transform & {
  /** Its shortcut's registration (null while unset, or while Transforms are off). */
  status: ShortcutStatusInfo | null;
};

/** "processing" is transcription (from release until a transcript arrives). */
export type CapsuleState =
  | "resting"
  | "listening"
  | "handsFree"
  | "processing"
  | "refining"
  | "inserting"
  | "inserted"
  | "copied"
  | "cancelled"
  | "error"
  | "warning";

export interface CapsulePayload {
  state: CapsuleState;
  message?: string;
  seq: number;
}

export interface DictationRow {
  id: string;
  startedAt: number;
  durationMs: number;
  status:
    | "transcribing"
    | "inserted"
    | "copied"
    | "rejected"
    | "failed"
    | "empty"
    | "cancelled";
  strategy: string | null;
  rawText: string | null;
  finalText: string | null;
  wordCount: number;
  appName: string | null;
  appBundleId: string | null;
  error: string | null;
  hasAudio: boolean;
  provider: string | null;
  cleanupUsed?: "off" | "deterministic" | "ai" | null;
  cleanupNote?: string | null;
  aiRejectedText?: string | null;
}

export interface DictionaryRow {
  id: string;
  phrase: string;
  misheardAs: string | null;
  enabled: boolean;
  usageCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface SnippetRow {
  id: string;
  trigger: string;
  replacement: string;
  enabled: boolean;
  usageCount: number;
  createdAt: number;
  updatedAt: number;
}

export type SnippetIssue =
  | { level: "error"; code: string }
  | { level: "warning"; code: string; detail?: string };

export interface PermissionsInfo {
  microphone:
    "granted" | "denied" | "not-determined" | "restricted" | "unknown";
  accessibility: boolean;
  postEvents: boolean;
  inputMonitoring: boolean;
}

export interface AppInfo {
  version: string;
  /** False in development builds, where macOS lists the app as "Electron". */
  packaged: boolean;
  macOS: string;
  arch: string;
  electron: string;
  chromium: string;
  dataPath: string;
}

export type SystemSettingsPane =
  "microphone" | "accessibility" | "sound" | "login-items" | "calendars";

/** Launch at login as macOS reports it (Stage 6A). */
export interface LoginItemInfo {
  /** False in development builds, which can't register themselves. */
  supported: boolean;
  enabled: boolean;
  /** Registered, but the user must still allow it in System Settings → Login Items. */
  needsApproval: boolean;
}

export const LoginItemSchema = z.object({ enabled: z.boolean() });
export const ResetSchema = z.object({
  /** Also delete the dictionary and snippets. */
  library: z.boolean(),
  /** Also delete Scratchpad notes (Stage 9B follow-up: its own choice). */
  notes: z.boolean().default(false),
  /** Also delete Notetaker meetings (Stage 9D-1). */
  meetings: z.boolean().default(false),
});

/** The answer to "keep this Mac's data, or start fresh?" after another account signs in. */
export const AccountSwitchSchema = z.object({
  choice: z.enum(["keep", "fresh"]),
});

/** What a reset did; `failed` names steps that couldn't be completed. */
export interface ResetResult {
  ok: boolean;
  failed: (
    | "recording"
    | "history"
    | "dictionary"
    | "snippets"
    | "notes"
    | "meetings"
    | "keys"
    | "account"
    | "mcp"
    | "settings"
  )[];
  /** Apps (Claude, Cursor) whose config still names Murmur; their entries stop working. */
  staleMcpApps: string[];
  /** The default shortcut was taken, so the current one was kept. */
  shortcutKept: boolean;
}

/** The latest delivered dictation, for the last-transcript actions. */
export interface LastTranscriptInfo {
  available: boolean;
  /** The original transcript differs from what was inserted (cleanup or snippets). */
  hasOriginal: boolean;
}

/** Settings → General → Microphone (Stage 6B). */
export interface MicrophonesInfo {
  permission: PermissionsInfo["microphone"];
  /** False until the audio renderer has reported its devices. */
  listed: boolean;
  /** Connected inputs, without Chromium's "default" alias and duplicates. */
  devices: MicrophoneDevice[];
  /** The macOS default input, when it can be identified. */
  systemDefault: string | null;
  /** The saved choice; null follows the macOS default. */
  selected: { id: string; name: string | null } | null;
  /** False when the saved microphone isn't connected (dictation then uses the default). */
  selectedAvailable: boolean;
  /** The device the next dictation opens. */
  next: string | null;
  /** What the last dictation actually opened (since launch). */
  last: { deviceId: string | null; fallback: boolean; at: number } | null;
}

export const MicrophoneSelectSchema = z.object({
  deviceId: z.string().min(1).max(512).nullable(),
});
export const PreviewSessionSchema = z.object({
  session: z.number().int().positive(),
});

/** A level reading for the meter: RMS and peak of the last 50 ms (0–1 of full scale). */
export interface MicLevelEvent {
  type: "level";
  session: number;
  rms: number;
  peak: number;
  muted: boolean;
  /** "recording": a dictation holds the microphone, and these are its levels. */
  source: "preview" | "recording";
}

export interface MicPreviewEvent {
  type: "state";
  session: number;
  state: "live" | "paused" | "stopped" | "ended" | "error";
  deviceId: string | null;
  fallback: boolean;
  /** DOMException name when opening failed (e.g. NotAllowedError). */
  error: string | null;
}

/** The optional last-transcript shortcuts (Stage 6B). */
export const SHORTCUT_ACTIONS = [
  "pasteLast",
  "copyLast",
  "copyOriginal",
  "openScratchpad",
  "transformViewChanges",
  "commandMode",
  "pressEnter",
  "startNotetaker",
] as const;
export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];
/** Names of Murmur's bindings, for conflict messages. */
export const BINDING_NAMES: Record<
  ShortcutAction | "pushToTalk" | "transform",
  string
> = {
  transform: "a Transform",
  pushToTalk: "Push to talk",
  pasteLast: "Paste last transcript",
  copyLast: "Copy last transcript",
  copyOriginal: "Copy original words",
  openScratchpad: "Open Scratchpad",
  transformViewChanges: "Transform view changes",
  commandMode: "Command Mode",
  pressEnter: "Press Enter",
  startNotetaker: "Start Notetaker",
};
export const ActionShortcutSchema = z.object({
  action: z.enum(SHORTCUT_ACTIONS),
  /** Null clears the binding. */
  shortcut: z.string().min(1).max(64).nullable(),
});

export interface ShortcutStatusInfo {
  combo: string;
  registered: boolean;
  error: string | null;
}

/** A voice profile written by the AI service from samples of the person's dictations. */
export interface VoiceProfile {
  text: string;
  generatedAt: number;
  /** Words in History when it was written. */
  words: number;
  /** The AI service (`cleanup.aiProvider`) that wrote it; absent in profiles from before it was recorded. */
  provider?: string;
}

/** The macOS Keychain, as Murmur can use it (Stage 8). */
export interface SecureStorageInfo {
  /** "checking": waiting for macOS (a Keychain dialog may be open). */
  state: "checking" | "available" | "unavailable";
  /** The recording key: "locked" while the Keychain is unavailable; "unreadable" is kept, never replaced. */
  recordings: "pending" | "ready" | "locked" | "unreadable";
  /** Saved API keys the Keychain couldn't decrypt (kept on disk). */
  unreadableKeys: number;
}

export interface StatusInfo {
  /** Absent only where no Keychain is involved (unit tests). */
  secureStorage?: SecureStorageInfo;
  permissions: PermissionsInfo;
  providerId: string;
  providerReady: string | null;
  shortcut: ShortcutStatusInfo;
  /** The optional shortcuts; null when unset. */
  actions: Record<ShortcutAction, ShortcutStatusInfo | null>;
  version: string;
  /** Epoch ms of the last push-to-talk press, so Settings can confirm the shortcut works. */
  lastHotkeyAt: number | null;
}

export const ShortcutCheckSchema = z.object({
  shortcut: z.string().min(1).max(64),
  /** Which binding the combination is for (default: push to talk). */
  action: z.enum(["pushToTalk", ...SHORTCUT_ACTIONS]).optional(),
});
export const IdSchema = z.object({ id: z.string().min(1).max(64) });
export const SecretSchema = z.object({
  provider: z.string().min(1).max(32),
  apiKey: z.string().max(4096),
});
export const DictionaryInputSchema = z.object({
  phrase: z.string().min(2).max(60),
  misheardAs: z.string().max(60).nullable().optional(),
  enabled: z.boolean().optional(),
});
export const DictionaryImportSchema = z
  .array(DictionaryInputSchema.pick({ phrase: true, misheardAs: true }))
  .max(5000);
export const SnippetInputSchema = z.object({
  trigger: z.string().min(1).max(60),
  replacement: z.string().min(1).max(4000),
  enabled: z.boolean().optional(),
});
/** An unsaved snippet for the editor's preview; `id` is set when editing an existing one. */
export const SnippetDraftSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  trigger: z.string().max(60),
  replacement: z.string().max(4000),
});
export type SnippetDraft = z.infer<typeof SnippetDraftSchema>;
const DictationStatusSchema = z.enum([
  "transcribing",
  "inserted",
  "copied",
  "rejected",
  "failed",
  "empty",
  "cancelled",
]);
export const HistoryQuerySchema = z.object({
  search: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(100000).optional(),
  status: DictationStatusSchema.optional(),
  statuses: z.array(DictationStatusSchema).max(7).optional(),
  order: z.enum(["newest", "oldest"]).optional(),
});
export type HistoryQueryInput = z.infer<typeof HistoryQuerySchema>;

export interface ShortcutCheckResult {
  normalized: string | null;
  errors: string[];
  warnings: string[];
  backend: string | null;
}

export interface HubApi extends AccountApi, McpHub {
  getSettings(): Promise<Settings>;
  updateSettings(patch: unknown): Promise<Settings>;
  getStatus(): Promise<StatusInfo>;
  checkShortcut(
    shortcut: string,
    action?: ShortcutAction | "pushToTalk",
  ): Promise<ShortcutCheckResult>;
  setSecret(provider: string, apiKey: string): Promise<{ ok: boolean }>;
  hasSecret(provider: string): Promise<boolean>;
  requestMicrophone(): Promise<PermissionsInfo["microphone"]>;
  requestAccessibility(): Promise<boolean>;
  openSystemSettings(pane: SystemSettingsPane): Promise<void>;
  about(): Promise<AppInfo>;
  revealDataFolder(): Promise<void>;
  listHistory(query?: HistoryQueryInput): Promise<DictationRow[]>;
  /** A page of matching rows (newest first) and how many match in total. */
  queryHistory(
    query: HistoryQueryInput,
  ): Promise<{ rows: DictationRow[]; total: number }>;
  getDictation(id: string): Promise<DictationRow | null>;
  historyStats(): Promise<HistoryStats>;
  exportData(): Promise<{ saved: boolean; path?: string }>;
  aiCleanupStatus(): Promise<{ providerId: string; ready: string | null }>;
  listDictionary(search?: string): Promise<DictionaryRow[]>;
  findDictionaryPhrase(phrase: string): Promise<DictionaryRow | null>;
  addDictionaryEntry(entry: {
    phrase: string;
    misheardAs?: string | null;
  }): Promise<DictionaryRow>;
  updateDictionaryEntry(
    id: string,
    patch: { phrase?: string; misheardAs?: string | null; enabled?: boolean },
  ): Promise<DictionaryRow | null>;
  deleteDictionaryEntry(id: string): Promise<boolean>;
  importDictionary(): Promise<{
    added: number;
    skipped: number;
    cancelled?: boolean;
  }>;
  exportDictionary(): Promise<{ saved: boolean; path?: string }>;
  listSnippets(search?: string): Promise<SnippetRow[]>;
  checkSnippet(
    candidate: { trigger: string; replacement: string },
    excludeId?: string | null,
  ): Promise<SnippetIssue[]>;
  addSnippet(snippet: {
    trigger: string;
    replacement: string;
    enabled?: boolean;
  }): Promise<SnippetRow>;
  updateSnippet(
    id: string,
    patch: { trigger?: string; replacement?: string; enabled?: boolean },
  ): Promise<SnippetRow | null>;
  deleteSnippet(id: string): Promise<boolean>;
  /** Expands `text` with the saved, enabled snippets, plus `draft` in place of its saved version. */
  previewSnippets(text: string, draft?: SnippetDraft): Promise<string>;
  onLibraryChanged(cb: () => void): () => void;
  /** Stage 9B: Scratchpad notes (Recents on the Scratchpad page). */
  listNotes(search?: string): Promise<NoteSummary[]>;
  /** Opens the note window on a note, or on a new note. */
  showNote(open: { id: string } | { new: true }): Promise<void>;
  renameNote(id: string, title: string): Promise<Note>;
  /** The caller has asked the person to confirm. */
  deleteNote(id: string): Promise<boolean>;
  exportNote(id: string): Promise<{ saved: boolean; path?: string }>;
  onNotesChanged(cb: () => void): () => void;
  /** Quit: main asks the page to save pending meeting notes, then waits for `flushed`. */
  onFlushRequest(cb: (requestId: string) => void): () => void;
  flushed(requestId: string): void;
  /** Stage 9C: Transforms. */
  transforms(search?: string): Promise<TransformWithStatus[]>;
  createTransform(input: {
    name: string;
    description: string;
    prompt: string;
  }): Promise<Transform>;
  updateTransform(patch: {
    id: string;
    name?: string;
    description?: string;
    prompt?: string;
    rules?: PolishRules;
  }): Promise<Transform>;
  /** The caller has asked the person to confirm. */
  deleteTransform(id: string): Promise<boolean>;
  resetTransforms(): Promise<void>;
  setTransformShortcut(
    id: string,
    shortcut: string | null,
  ): Promise<ShortcutStatusInfo | null>;
  transformsAiStatus(): Promise<{
    ready: string | null;
    service: string;
    provider: string;
    consented: boolean;
    summaryConsented: boolean;
  }>;
  allowTransformsAi(): Promise<void>;
  /** Agree to send meeting transcripts and notes to the AI service (Notetaker summaries only). */
  allowSummaryAi(provider: string): Promise<void>;
  /** "See Updates": the transform applied to its built-in example (sent to the AI service). */
  runTransformExample(
    id: string,
    sample?: string,
  ): Promise<{ before: string; after: string }>;
  /** History "Transform…": opens the Transform panel with that dictation's text. */
  transformDictation(id: string, transformId: string): Promise<void>;
  onTransformsChanged(cb: () => void): () => void;
  /** Stage 9D-1: Notetaker meetings (your notes; nothing is recorded yet). */
  meetings(query?: {
    search?: string;
    sort?: MeetingSort;
  }): Promise<MeetingSummary[]>;
  meeting(id: string): Promise<Meeting | null>;
  createMeeting(input?: {
    title?: string;
    startedAt?: number | null;
  }): Promise<Meeting>;
  updateMeeting(patch: {
    id: string;
    title?: string;
    startedAt?: number | null;
    endedAt?: number | null;
  }): Promise<Meeting>;
  saveMeetingNotes(
    id: string,
    notes: string,
    revision: number,
  ): Promise<MeetingSaveResult>;
  /** The caller has asked the person to confirm. */
  deleteMeeting(id: string): Promise<boolean>;
  exportMeeting(id: string): Promise<{ saved: boolean; path?: string }>;
  importMeetings(): Promise<{ imported: number; skipped: string[] }>;
  notetakerReadiness(): Promise<NotetakerReadiness>;
  onMeetingsChanged(cb: () => void): () => void;
  /** Stage 9D-2: meeting recording (only on the person's request), transcription, summary. */
  recordingState(): Promise<RecordingState>;
  /** A new meeting, recording at once. */
  startNotetaker(): Promise<Meeting>;
  /** Settings → Connectors → Calendar (macOS Calendar through EventKit). */
  calendarStatus(): Promise<CalendarStatus>;
  /** Connect: the only call that can show macOS's calendar prompt (send it from the button). */
  connectCalendar(): Promise<CalendarStatus>;
  disconnectCalendar(): Promise<CalendarStatus>;
  upcomingMeetings(fresh?: boolean): Promise<UpcomingMeeting[]>;
  /** A meeting titled from the event, recording (setup and consent checks apply). */
  startNotetakerFromEvent(key: string): Promise<Meeting>;
  startRecording(id: string): Promise<RecordingState>;
  pauseRecording(): Promise<RecordingState>;
  resumeRecording(): Promise<RecordingState>;
  stopRecording(): Promise<RecordingState>;
  /** Starts (or retries) transcription in the background. */
  transcribeMeeting(id: string): Promise<void>;
  summarizeMeeting(id: string, requestId: string): Promise<Meeting>;
  cancelSummary(requestId: string): Promise<void>;
  onRecordingChanged(cb: (state: RecordingState) => void): () => void;
  onTranscriptionProgress(
    cb: (progress: TranscriptionProgress) => void,
  ): () => void;
  retryDictation(id: string): Promise<DictationRow | null>;
  /** The decrypted WAV of a stored recording (memory only); fails with a plain reason. */
  dictationAudio(id: string): Promise<ArrayBuffer>;
  /** The microphone is open for a dictation. */
  dictationRecording(): Promise<boolean>;
  onDictationRecording(cb: (open: boolean) => void): () => void;
  copyDictation(id: string, which: "final" | "raw"): Promise<boolean>;
  deleteDictation(id: string): Promise<boolean>;
  clearHistory(): Promise<void>;
  /** First-run setup (documented at the top of shared/onboarding.ts). */
  setPracticeFocus(active: boolean, fieldId: string): Promise<void>;
  onPracticeText(cb: (e: PracticeTextEvent) => void): () => void;
  /** While on, the dictation shortcut only reports `onShortcutState`; nothing is recorded. */
  watchShortcut(on: boolean): Promise<boolean>;
  onShortcutState(cb: (e: ShortcutStateEvent) => void): () => void;
  systemAudioStatus(): Promise<SystemAudioStatus>;
  /** Shows macOS's permission prompt for your Mac's sound; send it from the Allow button. */
  requestSystemAudio(): Promise<SystemAudioStatus>;
  loginItem(): Promise<LoginItemInfo>;
  setLoginItem(enabled: boolean): Promise<LoginItemInfo>;
  resetApp(options: {
    library: boolean;
    notes: boolean;
    meetings: boolean;
  }): Promise<ResetResult>;
  onHistoryChanged(cb: () => void): () => void;
  onStatusChanged(cb: () => void): () => void;
  /** Stage 6B: microphones, level preview, optional shortcuts. */
  microphones(): Promise<MicrophonesInfo>;
  selectMicrophone(deviceId: string | null): Promise<MicrophonesInfo>;
  onMicrophonesChanged(cb: () => void): () => void;
  /** Opens a level preview for this window; levels arrive through `onMicPreview`. */
  startMicPreview(): Promise<{ session: number }>;
  stopMicPreview(session: number): Promise<void>;
  onMicPreview(cb: (e: MicLevelEvent | MicPreviewEvent) => void): () => void;
  setActionShortcut(
    action: ShortcutAction,
    shortcut: string | null,
  ): Promise<Settings>;
  /** Pauses Murmur's global shortcuts while the shortcut recorder listens. */
  suspendShortcuts(suspended: boolean): Promise<boolean>;
  /** Asks macOS again for Keychain access (after a denied or unanswered dialog). */
  retrySecureStorage(): Promise<void>;
  /** Stage 9A Insights, computed from local History. */
  insights(): Promise<Insights>;
  /** Copies text the Hub is showing (a meeting transcript) through the main process. */
  copyText(text: string): Promise<void>;
  /** Copies a text summary of the totals to the clipboard and returns it. */
  copyInsights(): Promise<string>;
  voiceProfile(): Promise<VoiceProfile | null>;
  /** Sends a sample of recent dictations to the AI cleanup service; only when the person asks. */
  generateVoiceProfile(): Promise<VoiceProfile>;
  /** Confirmed by the person: replaces an unreadable recording key (old recordings are kept aside). */
  startNewRecordingKey(): Promise<{ archived: number }>;
}
