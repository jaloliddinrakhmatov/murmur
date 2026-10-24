// Everything the Hub renderer can ask for, as plain methods (unit-testable, wired to IPC in
// windows/hub.ts). Inputs from the renderer are validated here with zod.
import { z } from "zod";
import { createProvider, type TranscriptionProvider } from "@murmur/speech";
import { checkSnippet, expandSnippets, type SnippetIssue } from "@murmur/text";
import {
  createCleanupProvider,
  type CleanupProvider,
  type TextGenerator,
} from "@murmur/refine";
import {
  computeInsights,
  insightsSummary,
  VOICE_UNLOCK_WORDS,
  type Insights,
} from "../../shared/insights.ts";
import type { ProcessingConfig } from "../core/controller.ts";
import type {
  DictionaryRepo,
  SnippetRepo,
  HistoryQuery,
} from "../history/db.ts";
import type {
  AppInfo,
  VoiceProfile,
  SecureStorageInfo,
  MicLevelEvent,
  MicPreviewEvent,
  MicrophonesInfo,
  LastTranscriptInfo,
  LoginItemInfo,
  ResetResult,
  SystemSettingsPane,
  DictationRow,
  DictionaryRow,
  PermissionsInfo,
  ShortcutCheckResult,
  SnippetRow,
  StatusInfo,
} from "../../shared/ipc.ts";
import {
  ActionShortcutSchema,
  PreviewSessionSchema,
  DictionaryImportSchema,
  DictionaryInputSchema,
  HistoryQuerySchema,
  IdSchema,
  LoginItemSchema,
  ResetSchema,
  AccountSwitchSchema,
  SecretSchema,
  ShortcutCheckSchema,
  SnippetDraftSchema,
  SnippetInputSchema,
} from "../../shared/ipc.ts";
import {
  AI_PROVIDERS,
  DEFAULT_SETTINGS,
  parseSettingsPatch,
  SPEECH_PROVIDERS,
  type Settings,
} from "../../shared/settings.ts";
import type { Meeting } from "../../shared/meetings.ts";
import type { Note } from "../../shared/notes.ts";
import type { LocalDataCounts } from "../../shared/account.ts";
import type { HistoryStats } from "../../shared/stats.ts";
import type { DictationController } from "../core/controller.ts";
import type {
  DictationRecord,
  Inserter,
  InsertOutcome,
  TargetProbe,
} from "../core/types.ts";
import type { HistoryDb } from "../history/db.ts";
import type { AudioVault } from "../history/vault.ts";
import {
  ACTIONS,
  BINDING_NAMES,
  type CarbonHotkeys,
} from "../native/hotkeys.ts";
import type { MicrophoneService } from "../audio/microphones.ts";
import type { ClipboardFirstInserter } from "../native/inserter.ts";
import type { NativeAddon } from "../native/addon.ts";
import { apiKeySecret, type SettingsStore } from "../settings/store.ts";
import type { EnvOverrides } from "../env.ts";
import type { OnboardingSupport } from "../onboarding/service.ts";
import type { SystemAudioStatus } from "../../shared/onboarding.ts";

/** macOS login items (Electron's SMAppService wrapper). */
export interface LoginItemPort {
  /** Null when this build can't register itself with macOS (a development build). */
  read(): { enabled: boolean; status: string } | null;
  write(enabled: boolean): void;
}

export interface SystemPorts {
  microphoneStatus(): PermissionsInfo["microphone"];
  requestMicrophone(): Promise<boolean>;
  openSystemSettings(pane: SystemSettingsPane): Promise<void>;
  revealDataFolder(): Promise<void>;
  loginItem: LoginItemPort;
  version: string;
  info: Omit<AppInfo, "version">;
}

export interface HubServiceDeps {
  settings: SettingsStore;
  env: EnvOverrides;
  native: NativeAddon;
  hotkeys: CarbonHotkeys;
  controller: DictationController;
  history: HistoryDb;
  vault: AudioVault;
  inserter: ClipboardFirstInserter;
  /** The dictation inserter and target probe, for pasting the last transcript. */
  paste: Inserter;
  target: TargetProbe;
  system: SystemPorts;
  dictionary: DictionaryRepo;
  snippets: SnippetRepo;
  microphones: MicrophoneService;
  /** Keychain-backed secrets and status (the real app); tests use the store's codec directly. */
  secrets?: {
    set(name: string, value: string): Promise<void>;
    status(name: string): "absent" | "ready" | "locked" | "unreadable";
  };
  /** Scratchpad notes (Stage 9B): Reset with "library" deletes them too. */
  notes?: { deleteAll(): number; all?(): Note[] };
  /** Notetaker meetings (Stage 9D-1): deleted by Reset only when asked. */
  meetings?: {
    deleteAll(): number;
    all(): Meeting[];
    /** A meeting recording is running (Reset is refused then). */
    recordingActive?(): boolean;
    /** A new recording key: meeting audio is moved aside with dictation recordings. */
    archiveAudio?(folder: string): Promise<number>;
  };
  /**
   * The Murmur account: Reset signs out (best effort on the server, always locally); a new
   * account that signs in chooses whether to keep this Mac's data (resolveAccountSwitch).
   */
  account?: {
    signOut(): Promise<unknown>;
    switchPending?(): boolean;
    acceptOwner?(): unknown;
  };
  /** Local MCP server: Reset revokes every client token and deletes the clients file. */
  mcp?: { resetAll(): Promise<{ apps: string[] }> };
  /** Where the voice profile is kept (a 0600 file next to History in the real app). */
  voiceProfileStore?: {
    read(): VoiceProfile | null;
    write(profile: VoiceProfile | null): void;
  };
  secureStorage?: {
    info(): SecureStorageInfo;
    retry(): Promise<void>;
    /** Replaces an unreadable recording key; returns a timestamp naming the kept files. */
    newRecordingKey(): Promise<string>;
  };
  /** First-run setup support (practice fields, shortcut test, sound permission). */
  onboarding?: OnboardingSupport;
  newId: () => string;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

/** Plain-language reason for a shortcut that couldn't be registered. */
export function shortcutError(raw: string): string {
  const own = /used-by:(\w+)/.exec(raw)?.[1] as
    keyof typeof BINDING_NAMES | undefined;
  if (own && BINDING_NAMES[own])
    return `Murmur already uses that shortcut for ${BINDING_NAMES[own]}.`;
  if (/already used by another app/i.test(raw))
    return "That shortcut is already used by another app or by macOS.";
  if (/needs-input-monitoring/.test(raw))
    return "fn (Globe) and shortcuts made only of modifier keys need Input Monitoring, which this version doesn't use.";
  return `That shortcut can't be used (${raw}).`;
}

export function toRow(r: DictationRecord): DictationRow {
  return { ...r };
}

/** Transcripts of long meetings are large; anything bigger than this is not a copy request. */
const COPY_TEXT_MAX = 2_000_000;
/** Dictations stop at 20 minutes of 16 kHz mono (about 38 MB); this is a sanity bound. */
const DICTATION_AUDIO_MAX = 64 * 1024 * 1024;
const CopyTextSchema = z.object({
  text: z.string().min(1).max(COPY_TEXT_MAX),
});

export class HubService {
  private readonly d: HubServiceDeps;
  private readonly historyListeners = new Set<() => void>();
  private readonly statusListeners = new Set<() => void>();
  lastHotkeyAt: number | null = null;

  constructor(deps: HubServiceDeps) {
    this.d = deps;
  }

  onHistoryChanged(cb: () => void): () => void {
    this.historyListeners.add(cb);
    return () => this.historyListeners.delete(cb);
  }
  onStatusChanged(cb: () => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }
  notifyHistory(): void {
    for (const l of this.historyListeners) l();
  }
  notifyStatus(): void {
    for (const l of this.statusListeners) l();
  }

  /** Builds the transcription provider from settings, with env overrides for development. */
  provider(): TranscriptionProvider {
    const s = this.d.settings.get().speech;
    const provider = (
      this.d.env.provider &&
      (SPEECH_PROVIDERS as readonly string[]).includes(this.d.env.provider)
        ? this.d.env.provider
        : s.provider
    ) as Settings["speech"]["provider"];
    const built = createProvider({
      provider,
      apiKey:
        this.d.env.apiKey ||
        this.d.settings.getSecret(apiKeySecret(provider)) ||
        undefined,
      model: this.d.env.model || s.model || undefined,
      localServerUrl: this.d.env.whisperUrl || s.localServerUrl,
    });
    // A saved key the Keychain hasn't released yet is "waiting", never "not set".
    const blocked = this.d.env.apiKey ? null : this.keyBlocked(provider);
    if (!blocked) return built;
    return Object.assign(Object.create(built) as TranscriptionProvider, {
      readiness: async () => blocked,
    });
  }

  getSettings(): Settings {
    return this.d.settings.get();
  }

  /**
   * A new shortcut is registered before it is saved: if registration fails, the error is thrown,
   * the previous shortcut stays registered, and nothing in the patch is stored.
   */
  updateSettings(patch: unknown): Settings {
    const shortcut =
      patch && typeof patch === "object" && "shortcut" in patch
        ? ShortcutCheckSchema.parse({
            shortcut: (patch as { shortcut: unknown }).shortcut,
          }).shortcut
        : null;
    // The rest of the patch must be acceptable before the shortcut is changed for real.
    const parsed = parseSettingsPatch(patch);
    // 0 days means "deleted right away", which would make Keep recordings do nothing.
    if (
      parsed.history?.keepRecordings === true &&
      (parsed.history.audioRetentionDays ??
        this.d.settings.get().history.audioRetentionDays) === 0
    )
      patch = {
        ...(patch as object),
        history: {
          ...(patch as { history: object }).history,
          audioRetentionDays: 7,
        },
      };
    const previous = this.d.hotkeys.current.combo;
    let replaced = false;
    if (shortcut !== null) {
      // A change is registered for real, never while the recorder has shortcuts paused.
      this.d.hotkeys.suspend(false);
      let combo = shortcut;
      if (shortcut.toLowerCase() !== previous.toLowerCase()) {
        const r = this.d.hotkeys.replace(shortcut);
        this.notifyStatus();
        if (!r.ok) throw new Error(shortcutError(r.error));
        combo = r.status.combo;
        replaced = true;
      }
      patch = { ...(patch as object), shortcut: combo.toLowerCase() };
    }
    try {
      const next = this.d.settings.update(patch);
      this.notifyStatus();
      return next;
    } catch (err) {
      // Not saved, so the previous shortcut must stay the one that works.
      if (replaced) {
        this.d.hotkeys.restore(previous);
        this.notifyStatus();
      }
      throw err;
    }
  }

  // ---- First-run setup ---------------------------------------------------------------------------

  setPracticeFocus(input: unknown): void {
    this.d.onboarding?.setPracticeFocus(input);
  }

  watchShortcut(input: unknown): boolean {
    return this.d.onboarding?.watchShortcut(input) ?? false;
  }

  /** The window that asked for practice or the shortcut test went away. */
  releaseOnboarding(): void {
    this.d.onboarding?.releaseAll();
  }

  systemAudioStatus(): SystemAudioStatus {
    return (
      this.d.onboarding?.systemAudioStatus() ?? {
        support: "unsupported-os",
        access: "unknown",
        message: null,
      }
    );
  }

  requestSystemAudio(): Promise<SystemAudioStatus> {
    return (
      this.d.onboarding?.requestSystemAudio() ??
      Promise.resolve(this.systemAudioStatus())
    );
  }

  about(): AppInfo {
    return { version: this.d.system.version, ...this.d.system.info };
  }

  revealDataFolder(): Promise<void> {
    return this.d.system.revealDataFolder();
  }

  permissions(): PermissionsInfo {
    const p = this.d.native.permissionStatus();
    return {
      microphone: this.d.system.microphoneStatus(),
      accessibility: p.accessibility,
      postEvents: p.postEvents,
      inputMonitoring: p.inputMonitoring,
    };
  }

  async getStatus(): Promise<StatusInfo> {
    const provider = this.provider();
    return {
      permissions: this.permissions(),
      providerId: provider.id,
      providerReady: await provider.readiness(),
      shortcut: this.d.hotkeys.current,
      actions: this.d.hotkeys.actions,
      ...(this.d.secureStorage
        ? { secureStorage: this.d.secureStorage.info() }
        : {}),
      version: this.d.system.version,
      lastHotkeyAt: this.lastHotkeyAt,
    };
  }

  checkShortcut(input: unknown): ShortcutCheckResult {
    const { shortcut, action } = ShortcutCheckSchema.parse(input);
    return this.d.hotkeys.check(shortcut, action ?? "pushToTalk");
  }

  // ---- Stage 6B: optional shortcuts --------------------------------------------------------------

  /**
   * Sets or clears an optional shortcut. It is registered with macOS before it is saved; if that
   * fails, the error is thrown and the previous binding stays registered and saved.
   */
  setActionShortcut(input: unknown): Settings {
    const { action, shortcut } = ActionShortcutSchema.parse(input);
    this.d.hotkeys.suspend(false);
    const r = this.d.hotkeys.replaceAction(action, shortcut);
    this.notifyStatus();
    if (!r.ok) throw new Error(shortcutError(r.error));
    const next = this.d.settings.set("shortcuts", {
      ...this.d.settings.get().shortcuts,
      [action]: r.status ? r.status.combo.toLowerCase() : null,
    });
    this.notifyStatus();
    return next;
  }

  /**
   * Registers the optional shortcuts as saved (at launch, and after a reset clears them). Each
   * was registered before it was saved; one that can't be registered now (another app took it)
   * shows its error in Settings while the others keep working.
   */
  syncActionShortcuts(): void {
    const saved = this.d.settings.get().shortcuts;
    let changed = false;
    for (const action of ACTIONS) {
      const want = saved[action];
      const have = this.d.hotkeys.actions[action];
      if ((want ?? null) === (have?.combo.toLowerCase() ?? null)) continue;
      const status = this.d.hotkeys.bindAction(action, want);
      this.d.log?.("shortcut.bind", {
        action,
        registered: status?.registered ?? null,
      });
      changed = true;
    }
    if (changed) this.notifyStatus();
  }

  /**
   * Pauses Murmur's shortcuts while the recorder listens. Refused during a dictation: releasing
   * push-to-talk mid-recording would lose its key-up.
   */
  suspendShortcuts(on: boolean): boolean {
    if (on && this.d.controller.currentPhase !== "idle") return false;
    this.d.hotkeys.suspend(on);
    return true;
  }

  // ---- Stage 6B: microphones ---------------------------------------------------------------------

  microphones(): Promise<MicrophonesInfo> {
    return this.d.microphones.list();
  }

  selectMicrophone(input: unknown): Promise<MicrophonesInfo> {
    return this.d.microphones.select(input);
  }

  onMicrophonesChanged(cb: () => void): () => void {
    return this.d.microphones.onChanged(cb);
  }

  startMicPreview(sink: (e: MicLevelEvent | MicPreviewEvent) => void): {
    session: number;
  } {
    return { session: this.d.microphones.startPreview(sink) };
  }

  stopMicPreview(input: unknown): void {
    this.d.microphones.stopPreview(PreviewSessionSchema.parse(input).session);
  }

  /** Saves (or, empty, removes) an API key, encrypted by the Keychain in the real app. */
  async setSecret(input: unknown): Promise<{ ok: boolean }> {
    const { provider, apiKey } = SecretSchema.parse(input);
    if (
      !(SPEECH_PROVIDERS as readonly string[]).includes(provider) &&
      !(AI_PROVIDERS as readonly string[]).includes(provider)
    )
      throw new Error("unknown provider");
    if (this.d.secrets)
      await this.d.secrets.set(apiKeySecret(provider), apiKey);
    else this.d.settings.setSecret(apiKeySecret(provider), apiKey);
    this.notifyStatus();
    return { ok: true };
  }

  /**
   * The person confirmed starting a new recording key (the old one can't be read). The old key
   * file and recordings are kept aside, never deleted; History stops offering retries that
   * could no longer work.
   */
  async startNewRecordingKey(input: unknown): Promise<{ archived: number }> {
    z.object({ confirm: z.literal(true) }).parse(input);
    if (!this.d.secureStorage) throw new Error("Not available here.");
    const stamp = await this.d.secureStorage.newRecordingKey();
    const archived =
      (await this.d.vault.archiveAll(`unreadable-${stamp}`)) +
      ((await this.d.meetings?.archiveAudio?.(`unreadable-${stamp}`)) ?? 0);
    for (const row of this.d.history.list(100000))
      if (row.hasAudio)
        this.d.history.update(row.id, {
          hasAudio: false,
          error: "recording kept under the previous, unreadable key",
        });
    this.notifyHistory();
    this.notifyStatus();
    return { archived };
  }

  // ---- Stage 9A: Insights ------------------------------------------------------------------------

  insights(): Insights {
    const usage = (rows: { usageCount: number }[]) =>
      rows.reduce((t, r) => t + r.usageCount, 0);
    return computeInsights(this.d.history.insightRows(), {
      dictionary: usage(this.d.dictionary.list()),
      snippets: usage(this.d.snippets.list()),
      wpm: this.d.history.stats().wpm,
    });
  }

  /** Puts text the Hub already shows (a meeting transcript) on the clipboard. */
  copyText(input: unknown): void {
    const { text } = CopyTextSchema.parse(input);
    this.d.inserter.copy(text);
  }

  /** Copies a summary of the totals (no dictated text) for sharing. */
  copyInsights(): string {
    const text = insightsSummary(this.insights());
    this.d.inserter.copy(text);
    return text;
  }

  voiceProfile(): VoiceProfile | null {
    return this.d.voiceProfileStore?.read() ?? null;
  }

  /**
   * Writes a short description of how the person dictates, from their most recent dictations
   * (about 2,500 words), with the AI cleanup service. Only on request, only once enough has been
   * dictated, and the prompt asks for style only — no names, numbers or quotes.
   */
  async generateVoiceProfile(): Promise<VoiceProfile> {
    const rows = this.d.history.insightRows();
    const words = rows.reduce((t, r) => t + r.wordCount, 0);
    if (words < VOICE_UNLOCK_WORDS)
      throw new Error(
        `Dictate ${VOICE_UNLOCK_WORDS - words} more words to unlock your voice profile.`,
      );
    const provider = this.cleanupProvider();
    const notReady = await provider.readiness();
    if (notReady)
      throw new Error(
        "Set up an AI service in Settings → AI cleanup to write your voice profile.",
      );
    const sample: string[] = [];
    let n = 0;
    for (const r of [...rows].reverse()) {
      if (n > 2500) break;
      sample.push(r.finalText ?? "");
      n += r.wordCount;
    }
    const out = await (provider as unknown as TextGenerator).generate(
      "You describe how a person speaks when they dictate, from samples of their dictations. " +
        "Write 2 or 3 warm sentences in the second person about their style: tone, structure, " +
        "vocabulary and pace. Never repeat names, numbers, places or quotes from the samples, " +
        "and don't mention that you were given samples.",
      sample.join("\n---\n"),
      { signal: AbortSignal.timeout(30_000), maxTokens: 300 },
    );
    const text = out.text.trim();
    if (!text) throw new Error("The AI service returned nothing. Try again.");
    const profile: VoiceProfile = {
      text,
      generatedAt: Date.now(),
      words,
      // Provider ids look like "groq:model"; only the service is kept.
      provider: provider.id.split(":")[0],
    };
    this.d.voiceProfileStore?.write(profile);
    return profile;
  }

  async retrySecureStorage(): Promise<void> {
    await this.d.secureStorage?.retry();
    this.notifyStatus();
  }

  /** Why a saved key can't be used yet, or null when it can (or none is saved). */
  private keyBlocked(provider: string): string | null {
    const status = this.d.secrets?.status(apiKeySecret(provider));
    if (status === "locked")
      return "Waiting for Keychain access to the saved API key — allow Murmur in the Keychain dialog, or retry in Settings → Data and Privacy.";
    if (status === "unreadable")
      return "The saved API key can't be read from the Keychain. Enter it again in Settings.";
    return null;
  }

  hasSecret(provider: string): boolean {
    return this.d.settings.hasSecret(apiKeySecret(provider));
  }

  async requestMicrophone(): Promise<PermissionsInfo["microphone"]> {
    await this.d.system.requestMicrophone();
    this.notifyStatus();
    return this.d.system.microphoneStatus();
  }

  requestAccessibility(): boolean {
    const trusted = this.d.native.requestAccessibility();
    this.notifyStatus();
    return trusted;
  }

  listHistory(input: unknown = {}): DictationRow[] {
    const q = HistoryQuerySchema.parse(input ?? {});
    return this.d.history.list(q as HistoryQuery).map(toRow);
  }

  historyStats(now = Date.now()): HistoryStats {
    return this.d.history.stats(now);
  }

  queryHistory(input: unknown = {}): { rows: DictationRow[]; total: number } {
    const q = HistoryQuerySchema.parse(input ?? {}) as HistoryQuery;
    return {
      rows: this.d.history.list(q).map(toRow),
      total: this.d.history.count(q),
    };
  }

  getDictation(input: unknown): DictationRow | null {
    const { id } = IdSchema.parse(input);
    const row = this.d.history.get(id);
    return row ? toRow(row) : null;
  }

  async retryDictation(input: unknown): Promise<DictationRow | null> {
    const { id } = IdSchema.parse(input);
    const row = await this.d.controller.retry(id, async (text) =>
      this.d.inserter.copy(text),
    );
    this.notifyHistory();
    return row ? toRow(row) : null;
  }

  copyDictation(input: unknown, which: "final" | "raw"): boolean {
    const { id } = IdSchema.parse(input);
    const row = this.d.history.get(id);
    const text = which === "raw" ? row?.rawText : row?.finalText;
    if (!text) return false;
    this.d.inserter.copy(text);
    return true;
  }

  /**
   * The decrypted recording of a History row, for playing it in the Hub (memory only, never
   * written to disk). Refused for rows without a stored recording, password-field rows, while
   * the microphone is open (the speakers would be recorded) and while the vault is locked.
   */
  async dictationAudio(input: unknown): Promise<ArrayBuffer> {
    const { id } = IdSchema.parse(input);
    const row = this.d.history.get(id);
    if (!row) throw new Error("That dictation is no longer in History.");
    if (row.error === "secure-field")
      throw new Error("Recordings aren't kept for password fields.");
    if (!row.hasAudio)
      throw new Error("There is no stored recording for this dictation.");
    if (this.dictationRecording() || this.d.meetings?.recordingActive?.())
      throw new Error("Not while recording.");
    let wav: Uint8Array | null;
    try {
      wav = await this.d.vault.load(id);
    } catch (err) {
      this.d.log?.("history.audio.unreadable", {});
      throw new Error(
        (err as Error)?.name === "VaultLockedError"
          ? "Recordings can't be opened until the Keychain allows Murmur to read its key. Allow it in the Keychain dialog, or retry in Settings → Data and Privacy."
          : "The recording couldn't be read.",
      );
    }
    if (!wav) {
      this.d.history.update(id, { hasAudio: false });
      this.notifyHistory();
      throw new Error("The recording is no longer stored.");
    }
    if (wav.byteLength > DICTATION_AUDIO_MAX)
      throw new Error("The recording is too large to play.");
    this.d.log?.("history.audio.played", { bytes: wav.byteLength });
    return wav.buffer.slice(
      wav.byteOffset,
      wav.byteOffset + wav.byteLength,
    ) as ArrayBuffer;
  }

  /** The microphone is open for a dictation (the Hub never plays recordings then). */
  dictationRecording(): boolean {
    return this.d.controller.currentPhase === "recording";
  }

  async deleteDictation(input: unknown): Promise<boolean> {
    const { id } = IdSchema.parse(input);
    await this.d.vault.remove(id);
    const deleted = this.d.history.delete(id);
    this.notifyHistory();
    return deleted;
  }

  async clearHistory(): Promise<void> {
    for (const row of this.d.history.list(100000))
      if (row.hasAudio) await this.d.vault.remove(row.id);
    // Derived from History, so it goes with it.
    this.d.voiceProfileStore?.write(null);
    // Also recordings no row points to (e.g. after a crash between saving and recording it).
    await this.d.vault.clearAll?.();
    this.d.history.clear();
    this.notifyHistory();
  }

  /** Deletes audio past the retention window. Called at startup and daily. */
  async purgeExpiredAudio(now = Date.now()): Promise<number> {
    const days = this.d.settings.get().history.audioRetentionDays;
    const ids = this.d.history.audioOlderThan(days * 86_400_000, now);
    for (const id of ids) {
      await this.d.vault.remove(id);
      this.d.history.update(id, { hasAudio: false });
    }
    if (ids.length) this.notifyHistory();
    return ids.length;
  }

  // ---- M2: processing configuration -------------------------------------------------------

  /** The AI cleanup provider for the current settings (unconfigured when the key is missing). */
  cleanupProvider(): CleanupProvider {
    const c = this.d.settings.get().cleanup;
    return createCleanupProvider({
      provider: c.aiProvider,
      apiKey:
        this.d.settings.getSecret(apiKeySecret(c.aiProvider)) || undefined,
      model: c.aiModel || undefined,
    });
  }

  async aiCleanupStatus(): Promise<{
    providerId: string;
    ready: string | null;
  }> {
    const p = this.cleanupProvider();
    return { providerId: p.id, ready: await p.readiness() };
  }

  /** What the controller uses for the next dictation: cleanup mode, enabled dictionary/snippets, vocabulary hints. */
  processingConfig(): ProcessingConfig {
    const s = this.d.settings.get();
    const dictionary = s.dictionary.enabled
      ? this.d.dictionary.list().filter((e) => e.enabled)
      : [];
    const snippets = s.snippets.enabled
      ? this.d.snippets.list().filter((e) => e.enabled)
      : [];
    return {
      mode: s.cleanup.mode,
      dictionary,
      snippets,
      vocabulary: s.dictionary.useAsVocabulary
        ? dictionary.slice(0, 100).map((e) => e.phrase)
        : [],
      ai:
        s.cleanup.mode === "ai"
          ? {
              provider: this.cleanupProvider(),
              timeoutMs: s.cleanup.aiTimeoutMs,
            }
          : undefined,
    };
  }

  recordHits(hits: {
    dictionary: Record<string, number>;
    snippets: Record<string, number>;
  }): void {
    if (Object.keys(hits.dictionary).length)
      this.d.dictionary.bumpUsage(hits.dictionary);
    if (Object.keys(hits.snippets).length)
      this.d.snippets.bumpUsage(hits.snippets);
    this.notifyLibrary();
  }

  private readonly libraryListeners = new Set<() => void>();
  onLibraryChanged(cb: () => void): () => void {
    this.libraryListeners.add(cb);
    return () => this.libraryListeners.delete(cb);
  }
  notifyLibrary(): void {
    for (const l of this.libraryListeners) l();
  }

  // ---- M2: dictionary ----------------------------------------------------------------------

  listDictionary(search = ""): DictionaryRow[] {
    return this.d.dictionary.list(String(search ?? ""));
  }

  findDictionaryPhrase(phrase: string): DictionaryRow | null {
    return this.d.dictionary.findByPhrase(String(phrase ?? ""));
  }

  addDictionaryEntry(input: unknown): DictionaryRow {
    const e = DictionaryInputSchema.parse(input);
    const row = this.d.dictionary.add({
      id: this.d.newId(),
      phrase: e.phrase,
      misheardAs: e.misheardAs ?? null,
      enabled: e.enabled,
    });
    this.notifyLibrary();
    return row;
  }

  updateDictionaryEntry(input: unknown, patch: unknown): DictionaryRow | null {
    const { id } = IdSchema.parse(input);
    const row = this.d.dictionary.update(
      id,
      DictionaryInputSchema.partial().parse(patch),
    );
    this.notifyLibrary();
    return row;
  }

  deleteDictionaryEntry(input: unknown): boolean {
    const { id } = IdSchema.parse(input);
    const ok = this.d.dictionary.delete(id);
    this.notifyLibrary();
    return ok;
  }

  importDictionary(input: unknown): { added: number; skipped: number } {
    const entries = DictionaryImportSchema.parse(input);
    const result = this.d.dictionary.importMany(entries, () => this.d.newId());
    this.notifyLibrary();
    return result;
  }

  exportDictionary(): { phrase: string; misheardAs: string | null }[] {
    return this.d.dictionary
      .list()
      .map((e) => ({ phrase: e.phrase, misheardAs: e.misheardAs }));
  }

  // ---- M2: snippets ------------------------------------------------------------------------

  listSnippets(search = ""): SnippetRow[] {
    return this.d.snippets.list(String(search ?? ""));
  }

  /** Validation + conflict detection for the editor, before saving. */
  checkSnippet(
    input: unknown,
    excludeId: string | null = null,
  ): SnippetIssue[] {
    const c = SnippetInputSchema.parse(input);
    const others = this.d.snippets.list().filter((s) => s.id !== excludeId);
    return checkSnippet(
      {
        id: excludeId ?? "new",
        trigger: c.trigger,
        replacement: c.replacement,
      },
      others,
      this.d.dictionary.list().map((e) => e.phrase),
    );
  }

  addSnippet(input: unknown): SnippetRow {
    const c = SnippetInputSchema.parse(input);
    if (this.checkSnippet(c).some((i) => i.level === "error"))
      throw new Error("snippet has errors");
    const row = this.d.snippets.add({
      id: this.d.newId(),
      trigger: c.trigger,
      replacement: c.replacement,
      enabled: c.enabled,
    });
    this.notifyLibrary();
    return row;
  }

  updateSnippet(input: unknown, patch: unknown): SnippetRow | null {
    const { id } = IdSchema.parse(input);
    const p = SnippetInputSchema.partial().parse(patch);
    const current = this.d.snippets.get(id);
    if (!current) return null;
    if (
      (p.trigger !== undefined || p.replacement !== undefined) &&
      this.checkSnippet(
        {
          trigger: p.trigger ?? current.trigger,
          replacement: p.replacement ?? current.replacement,
        },
        id,
      ).some((i) => i.level === "error")
    )
      throw new Error("snippet has errors");
    const row = this.d.snippets.update(id, p);
    this.notifyLibrary();
    return row;
  }

  deleteSnippet(input: unknown): boolean {
    const { id } = IdSchema.parse(input);
    const ok = this.d.snippets.delete(id);
    this.notifyLibrary();
    return ok;
  }

  /**
   * Shows what a dictation would become with the current snippets (preview in the editor). An
   * unsaved draft joins the saved, enabled snippets, replacing its own saved version when editing;
   * expansion itself is the same `expandSnippets` used for real dictations.
   */
  previewSnippets(text: string, draft?: unknown): string {
    const d =
      draft === undefined || draft === null
        ? null
        : SnippetDraftSchema.parse(draft);
    const saved = this.d.snippets
      .list()
      .filter((s) => s.enabled && s.id !== d?.id);
    return expandSnippets(
      String(text ?? ""),
      d?.trigger.trim() && d.replacement.trim()
        ? [
            ...saved,
            {
              id: d.id ?? "draft",
              trigger: d.trigger,
              replacement: d.replacement,
            },
          ]
        : saved,
    ).text;
  }

  // ---- M2: history data lifecycle ----------------------------------------------------------

  /** Everything stored locally, as plain JSON (no audio: it only exists to retry, and stays encrypted). Scratchpad notes export one at a time. */
  exportData(): {
    exportedAt: string;
    dictations: DictationRow[];
    dictionary: DictionaryRow[];
    snippets: SnippetRow[];
    meetings: Meeting[];
    notes: Note[];
  } {
    return {
      exportedAt: new Date().toISOString(),
      dictations: this.d.history.list({ limit: 100000 }).map(toRow),
      dictionary: this.d.dictionary.list(),
      snippets: this.d.snippets.list(),
      meetings: this.d.meetings?.all() ?? [],
      notes: this.d.notes?.all?.() ?? [],
    };
  }

  /** How much Murmur data this Mac holds: counts only, for the account switch prompt. */
  localDataCounts(): LocalDataCounts {
    return {
      dictations: this.d.history.count(),
      notes: this.d.notes?.all?.().length ?? 0,
      meetings: this.d.meetings?.all().length ?? 0,
      dictionary: this.d.dictionary.list().length,
      snippets: this.d.snippets.list().length,
    };
  }

  /**
   * A different account signed in on a Mac with Murmur data: "keep" hands the data to it;
   * "fresh" deletes History (with recordings), notes, meetings, the dictionary and snippets
   * first. Settings, API keys and shortcuts stay. If any part can't be deleted, the question
   * stays open so the person can try again.
   */
  async resolveAccountSwitch(input: unknown): Promise<void> {
    const { choice } = AccountSwitchSchema.parse(input);
    if (!this.d.account?.switchPending?.()) return;
    if (choice === "fresh") {
      if (this.d.meetings?.recordingActive?.())
        throw new Error(
          "A meeting is being recorded. Stop the recording first, then start fresh. Nothing was deleted.",
        );
      const failed: string[] = [];
      const step = async (name: string, run: () => unknown) => {
        try {
          await run();
        } catch {
          failed.push(name);
        }
      };
      await step("History", () => this.clearHistory());
      await step("notes", () => this.d.notes?.deleteAll());
      await step("meetings", () => this.d.meetings?.deleteAll());
      await step("dictionary", () => {
        for (const e of this.d.dictionary.list())
          this.d.dictionary.delete(e.id);
      });
      await step("snippets", () => {
        for (const e of this.d.snippets.list()) this.d.snippets.delete(e.id);
      });
      this.notifyHistory();
      this.notifyLibrary();
      if (failed.length)
        throw new Error(
          `Murmur couldn't delete the ${failed.join(", ")} on this Mac. Try again.`,
        );
    }
    this.d.account.acceptOwner?.();
  }

  /** Deletes rows older than the history retention window together with their audio. */
  async purgeExpiredHistory(now = Date.now()): Promise<number> {
    const days = this.d.settings.get().history.historyRetentionDays;
    if (!days) return 0;
    const ids = this.d.history.olderThan(days * 86_400_000, now);
    for (const id of ids) await this.d.vault.remove(id);
    this.d.history.deleteMany(ids);
    if (ids.length) this.notifyHistory();
    return ids.length;
  }

  // ---- Stage 6A: launch at login ------------------------------------------------------------

  loginItem(): LoginItemInfo {
    const s = this.d.system.loginItem.read();
    if (!s) return { supported: false, enabled: false, needsApproval: false };
    return {
      supported: true,
      enabled: s.enabled,
      needsApproval: s.status === "requires-approval",
    };
  }

  /** Asks macOS, then reports what macOS actually did; a refused change is an error. */
  setLoginItem(input: unknown): LoginItemInfo {
    const { enabled } = LoginItemSchema.parse(input);
    if (!this.d.system.loginItem.read())
      throw new Error(
        "Launch at login works in the installed Murmur app, not in a development build.",
      );
    this.d.system.loginItem.write(enabled);
    const after = this.loginItem();
    if (enabled && !after.enabled && !after.needsApproval)
      throw new Error("macOS didn't add Murmur to your login items.");
    if (!enabled && (after.enabled || after.needsApproval))
      throw new Error("macOS didn't remove Murmur from your login items.");
    return after;
  }

  // ---- Stage 6A: reset ------------------------------------------------------------------------

  /**
   * Returns Murmur to its first-run state: stops a recording, deletes History and its
   * recordings, removes every saved API key, signs out of the Murmur account, revokes MCP access and restores default settings (then onboarding
   * runs again). With `library`, also deletes the dictionary and snippets. Each step runs even
   * if an earlier one fails; failures are reported, never hidden. Nothing outside Murmur's data
   * is touched.
   */
  async resetApp(input: unknown): Promise<ResetResult> {
    const { library, notes, meetings } = ResetSchema.parse(input);
    // Stopping a meeting is the person's call; resetting under a live recording would also
    // wipe its settings and audio mid-way.
    if (this.d.meetings?.recordingActive?.())
      throw new Error(
        "A meeting is being recorded. Stop the recording first, then reset Murmur. Nothing was changed.",
      );
    const failed: ResetResult["failed"] = [];
    const step = async (
      name: ResetResult["failed"][number],
      run: () => unknown,
    ) => {
      try {
        await run();
      } catch {
        failed.push(name);
      }
    };
    await step("recording", () => this.d.controller.cancel());
    await step("history", () => this.clearHistory());
    if (library) {
      await step("dictionary", () => {
        for (const e of this.d.dictionary.list())
          this.d.dictionary.delete(e.id);
      });
      await step("snippets", () => {
        for (const e of this.d.snippets.list()) this.d.snippets.delete(e.id);
      });
    }
    if (notes && this.d.notes)
      await step("notes", () => this.d.notes!.deleteAll());
    if (meetings && this.d.meetings)
      await step("meetings", () => this.d.meetings!.deleteAll());
    await step("keys", () => {
      for (const p of new Set<string>([...SPEECH_PROVIDERS, ...AI_PROVIDERS]))
        this.d.settings.setSecret(apiKeySecret(p), "");
    });
    await step("account", () => this.d.account?.signOut());
    let staleMcpApps: string[] = [];
    await step("mcp", async () => {
      if (this.d.mcp) staleMcpApps = (await this.d.mcp.resetAll()).apps;
    });
    // The default shortcut is registered before it is saved, like any other change.
    let shortcutKept = false;
    await step("settings", () => {
      const current = this.d.settings.get().shortcut;
      const def = DEFAULT_SETTINGS.shortcut;
      if (current.toLowerCase() !== def) {
        const r = this.d.hotkeys.replace(def);
        shortcutKept = !r.ok;
      }
      for (const action of ACTIONS) this.d.hotkeys.bindAction(action, null);
      this.d.settings.reset(shortcutKept ? { shortcut: current } : {});
    });
    this.notifyHistory();
    this.notifyLibrary();
    this.notifyStatus();
    return { ok: failed.length === 0, failed, shortcutKept, staleMcpApps };
  }

  // ---- Stage 6A: last transcript ---------------------------------------------------------------

  /** The latest dictation that was inserted or copied, with text. */
  private lastDelivered(): DictationRecord | null {
    return (
      this.d.history
        .list({ statuses: ["inserted", "copied"], limit: 20 })
        .find((r) => r.finalText) ?? null
    );
  }

  lastTranscript(): LastTranscriptInfo {
    const row = this.lastDelivered();
    return {
      available: Boolean(row),
      hasOriginal: Boolean(row?.rawText && row.rawText !== row.finalText),
    };
  }

  /** Copies the last transcript (refined, or the original words). False when there is none. */
  copyLastTranscript(which: "final" | "raw"): boolean {
    const row = this.lastDelivered();
    const text = which === "raw" ? row?.rawText : row?.finalText;
    if (!text) return false;
    this.d.inserter.copy(text);
    return true;
  }

  /**
   * Pastes the last transcript into the app in front, through the same inserter and safety
   * rules as a dictation: secure fields are refused, Murmur's own window or a changed app gets
   * a copy instead, and without the paste permission it is copied.
   */
  async pasteLastTranscript(): Promise<InsertOutcome | null> {
    const row = this.lastDelivered();
    if (!row?.finalText) return null;
    return this.d.paste.insert(row.finalText, this.d.target.snapshot());
  }
}
