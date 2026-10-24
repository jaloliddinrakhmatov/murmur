// Composition root: builds every adapter and wires the DictationController. `createApp` is shared
// by the real entrypoint and the smoke test, which swaps in fakes through `overrides`.
import { execFile } from "node:child_process";
import { controllerConfig } from "./settings/controller-config.ts";
import {
  app,
  ipcMain,
  nativeTheme,
  safeStorage,
  shell,
  systemPreferences,
  session,
  BrowserWindow,
  powerSaveBlocker,
  clipboard,
  dialog,
  Notification,
} from "electron";
import { writeFile as writeFileAsync } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { TranscriptionProvider } from "@murmur/speech";
import {
  RendererAudioCapture,
  type AudioRendererLink,
  type AudioRendererMessage,
} from "./audio/capture.ts";
import { DictationController } from "./core/controller.ts";
import {
  realClock,
  type AudioPort,
  type DictationRecord,
  type HistoryPort,
  type Inserter,
  type TargetProbe,
} from "./core/types.ts";
import { loadDotEnv, readEnvOverrides, type EnvOverrides } from "./env.ts";
import {
  DictionaryRepo,
  HistoryDb,
  MeetingRepo,
  NoteRepo,
  SnippetRepo,
  TransformRepo,
} from "./history/db.ts";
import { recoverInterruptedDictations } from "./history/recover.ts";
import { AudioVault } from "./history/vault.ts";
import { HubService, type SystemPorts } from "./hub/service.ts";
import { loadNative, type NativeAddon } from "./native/addon.ts";
import { CarbonHotkeys } from "./native/hotkeys.ts";
import { MicrophoneService } from "./audio/microphones.ts";
import {
  KeychainSecrets,
  SecureStorage,
  VaultKey,
  type KeychainPort,
} from "./settings/secure-storage.ts";
import { lastTranscriptActions } from "./hub/last-transcript.ts";
import type { ShortcutAction, VoiceProfile } from "../shared/ipc.ts";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { ClipboardFirstInserter } from "./native/inserter.ts";
import { NativeTargetProbe } from "./native/target.ts";
import { SettingsStore, type SecretCodec } from "./settings/store.ts";
import { CapsuleWindow } from "./windows/capsule.ts";
import {
  HubWindow,
  openSystemSettings,
  registerHubIpc,
} from "./windows/hub.ts";
import {
  allowNoteWindowClose,
  NoteWindow,
  registerScratchpadIpc,
} from "./windows/scratchpad.ts";
import { ScratchpadService } from "./scratchpad/service.ts";
import { TransformService, type TextService } from "./transforms/service.ts";
import {
  TransformSessions,
  type CommandSelection,
} from "./transforms/session.ts";
import { TransformPanel } from "./windows/transform-panel.ts";
import { registerTransformIpc } from "./windows/transforms-ipc.ts";
import { NotetakerService } from "./notetaker/service.ts";
import { OutputMuter } from "./system/mute.ts";
import { CorrectionWatcher } from "./dictionary/corrections.ts";
import { grantSummaryConsent } from "./transforms/consent.ts";
import { parseAudioMessage } from "./audio/message.ts";
import { isNoReadApp } from "../shared/sensitive-apps.ts";
import { applyStyle, contextTerms } from "@murmur/text";
import { VibeCoding } from "./vibe/service.ts";
import { categoryFor } from "../shared/styles.ts";
import {
  MeetingRecorder,
  type MeetingMic,
  type SystemAudio,
} from "./notetaker/recorder.ts";
import {
  NativeSystemAudioSource,
  RendererMeetingMic,
  VaultAudioParts,
} from "./notetaker/sources.ts";
import { formatClock, type RecordingState } from "../shared/meetings.ts";
import { createTray, type MurmurTray } from "./windows/tray.ts";
import { registerNotetakerIpc } from "./windows/notetaker-ipc.ts";
import { registerConnectorsIpc } from "./windows/connectors-ipc.ts";
import { CalendarService, type NativeCalendar } from "./connectors/calendar.ts";
import { REMINDER_BAR_MESSAGE } from "../shared/calendar.ts";
import { AccountService } from "./account/service.ts";
import { createTokenVault } from "./account/vault.ts";
import { registerAccountIpc } from "./windows/account-ipc.ts";
import { McpService } from "./mcp/service.ts";
import { registerMcpIpc } from "./windows/mcp-ipc.ts";
import type { AccountStatus } from "../shared/account.ts";
import type { Note } from "../shared/notes.ts";
import { readFile as readFileAsync, stat as statAsync } from "node:fs/promises";
import { basename } from "node:path";
import { ScratchpadAwareInserter } from "./scratchpad/inserter.ts";
import {
  OnboardingSupport,
  PracticeAwareInserter,
} from "./onboarding/service.ts";
import type { NoteTarget } from "./scratchpad/inserter.ts";

export interface AppOverrides {
  userDataDir?: string;
  audio?: AudioPort;
  inserter?: Inserter;
  target?: TargetProbe;
  provider?: TranscriptionProvider;
  native?: NativeAddon;
  env?: EnvOverrides;
  /** Skip the tray and hub window (smoke runs). */
  headless?: boolean;
  /** Stage E: replaces posting a real Return (smoke runs; like `inserter` for pastes). */
  pressReturn?: (expectedPid: number) => { ok: boolean; reason?: string };
  /** Replaces posting a real ⌘C to copy a selection (smoke runs; like `pressReturn`). */
  copySelection?: (pid: number) => {
    ok: boolean;
    text?: string;
    reason?: string;
  };
  /** Stage 9D-2: meeting audio sources (smoke runs and tests). */
  meetingMic?: MeetingMic;
  /** Replaces the EventKit calendar (smoke runs and tests never touch the real calendars). */
  calendar?: NativeCalendar;
  systemAudio?: SystemAudio;
  /** A fake Keychain (tests and smoke runs that must not touch the real one). */
  keychain?: KeychainPort;
  /** Replaces the network for the Murmur account (capture and tests use an in-memory server). */
  accountFetch?: typeof fetch;
  /**
   * Show or hide the Dock icon from settings (the real app). Smoke and capture runs leave the
   * Dock alone and call `applyDock` explicitly.
   */
  manageDock?: boolean;
  /** Where Claude Desktop's and Cursor's config folders are looked for (tests and smoke runs). */
  mcpHome?: string;
}

export interface MurmurApp {
  controller: DictationController;
  capsule: CapsuleWindow;
  hub: HubWindow | null;
  /** The Scratchpad note window (null in headless runs). */
  notes: NoteWindow | null;
  scratchpad: ScratchpadService;
  transforms: TransformService;
  notetaker: NotetakerService;
  /** The Murmur account: nothing runs until the person signs in. */
  account: AccountService;
  /** Transforms in other apps (null in headless runs). */
  readonly sessions: TransformSessions | null;
  readonly transformPanel: TransformPanel | null;
  service: HubService;
  settings: SettingsStore;
  history: HistoryDb;
  vault: AudioVault;
  hotkeys: CarbonHotkeys;
  microphones: MicrophoneService;
  audioWindow: BrowserWindow;
  audioLink: AudioRendererLink;
  native: NativeAddon;
  log: (event: string, data?: Record<string, unknown>) => void;
  /** Shows or hides the Dock icon according to Settings → System; true once macOS agrees. */
  applyDock(): Promise<boolean>;
  /** The tray's last-transcript actions, with the result shown on the Capsule. */
  pasteLastTranscript(): Promise<void>;
  copyLastTranscript(which: "final" | "raw"): void;
  /** What an optional shortcut does when pressed (Stage 6B). */
  runShortcutAction(action: ShortcutAction, kind: "pressed" | "released"): void;
  dispose(): Promise<void>;
}

/** The macOS Keychain through Electron's asynchronous safeStorage (never blocks the main process). */
const electronKeychain: KeychainPort = {
  isAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
  encrypt: (text) => safeStorage.encryptStringAsync(text),
  decrypt: async (blob) => (await safeStorage.decryptStringAsync(blob)).result,
};

function rendererPaths() {
  const dev = process.env.ELECTRON_RENDERER_URL;
  const page = (name: string) =>
    dev
      ? `${dev}/src/renderer/${name}/index.html`
      : {
          file: join(__dirname, `../renderer/${name}/index.html`),
        };
  return {
    page,
    preload: (name: string) => join(__dirname, `../preload/${name}.js`),
  };
}

export async function createApp(
  overrides: AppOverrides = {},
): Promise<MurmurApp> {
  const userData = overrides.userDataDir ?? app.getPath("userData");
  // Development overrides (.env, MURMUR_* variables) never apply to an installed build.
  if (!app.isPackaged) loadDotEnv(join(app.getAppPath(), ".env"));
  const env = overrides.env ?? (app.isPackaged ? {} : readEnvOverrides());
  const log = (event: string, data?: Record<string, unknown>) => {
    // Metadata only: never transcript text (TEST_STRATEGY §3.25).
    console.log(
      JSON.stringify({ t: new Date().toISOString(), event, ...(data ?? {}) }),
    );
  };

  // Secrets and the recording key come from the Keychain asynchronously: start-up never waits
  // on a Keychain dialog. Until macOS answers, saved keys read as "locked", never as missing.
  const secure = new SecureStorage(overrides.keychain ?? electronKeychain, log);
  let secrets!: KeychainSecrets;
  const codec: SecretCodec = {
    encrypt: () => {
      throw new Error("Secrets are encrypted through KeychainSecrets.set");
    },
    decrypt: (blob) => secrets.decryptCached(blob),
  };
  const settings = new SettingsStore(userData, codec, log);
  secrets = new KeychainSecrets(settings, secure, log);
  const recordingKey = new VaultKey(userData, secure, log);
  const native = overrides.native ?? loadNative();
  const history = new HistoryDb(join(userData, "murmur.sqlite"));
  try {
    const n = recoverInterruptedDictations(history);
    if (n) log("history.interrupted-recovered", { count: n });
  } catch (err) {
    log("history.recover.failed", { error: String(err) });
  }
  const vault = new AudioVault(join(userData, "audio"), () => recordingKey.key);
  // Meeting audio has its own folder (same key), so clearing History never touches it.
  const meetingParts = new VaultAudioParts(
    new AudioVault(join(userData, "meeting-audio"), () => recordingKey.key),
  );
  const { page, preload } = rendererPaths();

  // Hidden audio renderer.
  const audioWindow = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    webPreferences: {
      preload: preload("audio"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // Only the hidden audio window may use the microphone; every other permission request from
  // any Murmur page is refused (Electron grants them all by default).
  const isAudio = (wc: Electron.WebContents | null) =>
    wc !== null && !audioWindow.isDestroyed() && wc === audioWindow.webContents;
  session.defaultSession.setPermissionRequestHandler((wc, permission, done) =>
    done(permission === "media" && isAudio(wc)),
  );
  session.defaultSession.setPermissionCheckHandler(
    (wc, permission) => permission === "media" && isAudio(wc),
  );
  audioWindow.webContents.on("will-navigate", (e) => e.preventDefault());
  audioWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const audioListeners = new Set<(m: AudioRendererMessage) => void>();
  let droppedAudioMessages = 0;
  ipcMain.on("audio:message", (e, raw: unknown) => {
    if (audioWindow.isDestroyed() || e.sender !== audioWindow.webContents)
      return;
    const m = parseAudioMessage(raw);
    if (m) {
      for (const l of audioListeners) l(m);
      return;
    }
    droppedAudioMessages += 1;
    if (droppedAudioMessages === 1 || droppedAudioMessages % 100 === 0)
      log("audio.message.dropped", { count: droppedAudioMessages });
  });
  const audioLink: AudioRendererLink = {
    // During shutdown the audio window can be gone before other windows finish closing.
    send: (c) => {
      if (!audioWindow.isDestroyed())
        audioWindow.webContents.send("audio:command", c);
    },
    onMessage: (cb) => {
      audioListeners.add(cb);
      return () => audioListeners.delete(cb);
    },
  };
  const u = page("audio");
  if (typeof u === "string") void audioWindow.loadURL(u);
  else void audioWindow.loadFile(u.file);

  // Stage E: other audio muted while a dictation records (Settings → System).
  const muteMarker = join(userData, "output-muted-by-murmur");
  const muter = new OutputMuter({
    enabled: () => settings.get().system.muteWhileDictating,
    isMuted: () => native.outputMuted(),
    setMuted: (m) => native.setOutputMuted(m),
    marker: {
      exists: () => existsSync(muteMarker),
      write: () => writeFileSync(muteMarker, "", { mode: 0o600 }),
      remove: () => rmSync(muteMarker, { force: true }),
    },
    log,
  });
  muter.restoreAfterQuit();

  // Stage E part 2 (M3, both off by default): names near the cursor as vocabulary hints, and
  // words corrected after a dictation added to the dictionary. Nothing read is kept or logged.
  // Nothing is read while Secure Event Input is on (a password prompt has the keyboard), or
  // when Murmur itself, a terminal or a password manager is in front; the field's own
  // secure role is checked as well.
  const readingBlocked = (): boolean => {
    try {
      if (native.permissionStatus().secureEventInput) return true;
      const front = native.frontmostApp();
      return !front || front.pid === process.pid || isNoReadApp(front.bundleId);
    } catch {
      return true;
    }
  };
  const readContextTerms = (): string[] => {
    if (!settings.get().context.awareness || readingBlocked()) return [];
    try {
      const r = native.readTextAround(null, 600, 200);
      if (!r.ok || r.isSecure || !r.text) return [];
      const terms = contextTerms(r.text);
      log("context.terms", { count: terms.length });
      return terms;
    } catch {
      return [];
    }
  };
  const vibe = new VibeCoding({
    settings: () => settings.get().vibeCoding,
    readingBlocked,
    readAround: (before, after) => native.readTextAround(null, before, after),
    windowTitle: () => native.focusedWindowTitle?.() ?? null,
    log,
  });
  const corrections = new CorrectionWatcher({
    enabled: () => settings.get().context.autoAddCorrections,
    blocked: readingBlocked,
    ownPid: process.pid,
    read: (location, before, after) =>
      native.readTextAround(location, before, after),
    known: (phrase) =>
      service
        .listDictionary()
        .some((d) => d.phrase.toLowerCase() === phrase.toLowerCase()),
    add: (phrase, misheardAs) =>
      void service.addDictionaryEntry({ phrase, misheardAs }),
    notify: (message) => {
      if (controller.currentPhase !== "idle") return;
      capsule.show("inserted", message);
      setTimeout(() => {
        if (controller.currentPhase === "idle") capsule.show("resting");
      }, 5000);
    },
    log,
    now: () => Date.now(),
    later: (ms, fn) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    },
  });

  let capsule!: CapsuleWindow;
  let controller!: DictationController;
  let recorder: MeetingRecorder | null = null;
  const microphones = new MicrophoneService({
    link: audioLink,
    settings,
    permission: () => systemPreferences.getMediaAccessStatus("microphone"),
    log,
  });
  const audio =
    overrides.audio ??
    new RendererAudioCapture(
      audioLink,
      (rms) => {
        capsule.level(rms);
        microphones.recordingLevel(rms);
      },
      {
        device: () => microphones.requested(),
        onStarted: (info) => microphones.recordingStarted(info),
        onEnded: () => controller.microphoneLost(),
      },
    );
  const inserter =
    overrides.inserter ?? new ClipboardFirstInserter(native, log);
  const copyInserter =
    inserter instanceof ClipboardFirstInserter
      ? inserter
      : new ClipboardFirstInserter(native, log);
  const target = overrides.target ?? new NativeTargetProbe(native);
  // Dictation into the Scratchpad note window goes straight into the note (Stage 9B).
  const notes = overrides.headless
    ? null
    : new NoteWindow({
        preload: preload("scratchpad"),
        url: page("scratchpad"),
        log,
      });
  const noteTarget: NoteTarget = notes ?? {
    acceptsDictation: () => false,
    insert: async () => false,
  };
  // First-run setup (created below, once the sound tap exists): practice fields in the Hub.
  let onboarding!: OnboardingSupport;
  const dictationInserter = new PracticeAwareInserter(
    new ScratchpadAwareInserter(
      inserter,
      noteTarget,
      log,
      () => native.permissionStatus().secureEventInput,
    ),
    {
      acceptsDictation: (takenAt) => onboarding.acceptsDictation(takenAt),
      insert: (text, durationMs) => onboarding.insert(text, durationMs),
    },
    log,
    () => native.permissionStatus().secureEventInput,
  );

  const system: SystemPorts = {
    microphoneStatus: () =>
      systemPreferences.getMediaAccessStatus("microphone"),
    requestMicrophone: () => systemPreferences.askForMediaAccess("microphone"),
    openSystemSettings,
    revealDataFolder: async () => {
      await shell.openPath(app.getPath("userData"));
    },
    // SMAppService (macOS 13+) through Electron. A development build would register the
    // Electron binary instead of Murmur, so only an installed (packaged) app offers it.
    loginItem: {
      read: () => {
        if (!app.isPackaged) return null;
        const s = app.getLoginItemSettings({ type: "mainAppService" });
        const status =
          s.status ?? (s.openAtLogin ? "enabled" : "not-registered");
        return { enabled: status === "enabled", status };
      },
      write: (enabled) =>
        app.setLoginItemSettings({
          openAtLogin: enabled,
          type: "mainAppService",
        }),
    },
    version: app.getVersion(),
    info: {
      packaged: app.isPackaged,
      macOS: process.getSystemVersion(),
      arch: process.arch,
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      dataPath: app.getPath("userData"),
    },
  };

  let service!: HubService;
  const hotkeys = new CarbonHotkeys(
    native,
    (kind) => {
      if (kind === "down") {
        service.lastHotkeyAt = Date.now();
        service.notifyStatus();
      }
      // The setup's shortcut test only watches the key: no recording starts.
      if (!onboarding.shortcutEvent(kind)) controller.hotkey(kind);
    },
    (action, kind) => runShortcutAction(action, kind),
  );

  capsule = new CapsuleWindow({
    preload: preload("capsule"),
    url: page("capsule"),
    onClick: () => controller.toggleFromCapsule(),
    onCancel: () => controller.cancel(),
    visibility: () => settings.get().capsule,
  });

  const configFromSettings = () => controllerConfig(settings.get());
  controller = new DictationController(
    {
      hold: new native.HoldToTalk(),
      audio,
      target,
      inserter: dictationInserter,
      capsule,
      cancelHotkey: hotkeys,
      history: new NotifyingHistory(history, () => service.notifyHistory()),
      vault,
      provider: () => overrides.provider ?? service.provider(),
      processing: () => service.processingConfig(),
      onHits: (h) => service.recordHits(h),
      // Checked at play time, so turning sounds off takes effect at once. Never while a meeting
      // is recording: the microphone is open then, and the sound would be in the recording.
      sound: (kind) => {
        if (settings.get().system.sounds && !recorder?.active)
          capsule.playSound(kind);
      },
      clock: realClock,
      newId: () => randomUUID(),
      log,
      busy: () => (recorder?.active ? "Meeting recording on" : null),
      micOpen: (open) =>
        hub?.window?.webContents.send("hub:dictationRecording", open),
      command: {
        capture: () => sessions?.captureSelection() ?? null,
        run: (instruction, selection) =>
          void sessions?.startCommand(
            instruction,
            selection as CommandSelection | null,
          ),
      },
      // Smoke runs record the press instead of posting a real Return.
      pressEnter: (pid) =>
        pid === null
          ? { ok: false, reason: "target-changed" }
          : (overrides.pressReturn?.(pid) ?? native.pressReturn(600, pid)),
      muteOutput: (muted) => muter.set(muted),
      contextTerms: () => readContextTerms(),
      contextEnabled: () => settings.get().context.awareness,
      vibeEnabled: () => {
        const v = settings.get().vibeCoding;
        return v.fileTagging || v.variables;
      },
      vibe: {
        begin: (bundleId) => vibe.begin(bundleId),
        apply: (text, bundleId) => vibe.apply(text, bundleId),
        end: () => vibe.end(),
      },
      styleText: (text, bundleId) =>
        settings.get().cleanup.mode === "off"
          ? text
          : applyStyle(
              text,
              settings.get().styles[categoryFor(bundleId)],
              service.listDictionary().map((d) => d.phrase),
            ),
      inserted: (text, target) => corrections.inserted(text, target),
      dictationStarting: () => corrections.dictationStarting(),
    },
    configFromSettings(),
  );
  const systemAudioSource = new NativeSystemAudioSource(native);
  onboarding = new OnboardingSupport({
    send: (channel: string, payload: unknown) => {
      const wc = hub?.window?.webContents;
      if (!wc || wc.isDestroyed()) return false;
      wc.send(channel, payload);
      return true;
    },
    hubFocused: () => Boolean(hub?.window?.isFocused()),
    // Automated runs never show macOS's permission prompt (like meeting recording in smoke runs).
    soundTap:
      overrides.systemAudio ??
      (overrides.manageDock || process.env.MURMUR_SMOKE_SYSTEM_AUDIO === "1"
        ? systemAudioSource
        : null),
    audioBusy: () =>
      Boolean(recorder?.active) || controller.currentPhase !== "idle",
    access: {
      read: () => settings.get().notetaker.systemAudioAccess,
      write: (value) =>
        void settings.update({ notetaker: { systemAudioAccess: value } }),
    },
  });
  service = new HubService({
    settings,
    secrets,
    voiceProfileStore: {
      read: () => {
        try {
          return JSON.parse(
            readFileSync(join(userData, "voice-profile.json"), "utf8"),
          ) as VoiceProfile;
        } catch {
          return null;
        }
      },
      write: (p) => {
        const file = join(userData, "voice-profile.json");
        if (p) writeFileSync(file, JSON.stringify(p), { mode: 0o600 });
        else rmSync(file, { force: true });
      },
    },
    secureStorage: {
      info: () => ({
        state: secure.state,
        recordings: recordingKey.state,
        unreadableKeys: secrets.unreadableCount,
      }),
      retry: async () => {
        await secure.retry();
        await unlockSecureStorage();
      },
      newRecordingKey: async () => {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await recordingKey.replaceUnreadable(stamp);
        return stamp;
      },
    },
    dictionary: new DictionaryRepo(history.db),
    snippets: new SnippetRepo(history.db),
    microphones,
    newId: () => randomUUID(),
    log,
    env,
    native,
    hotkeys,
    controller,
    history,
    vault,
    inserter: copyInserter,
    paste: dictationInserter,
    onboarding,
    // Reset: the note window goes first, so no open tab can save its text back afterwards.
    notes: {
      deleteAll: () => {
        notes?.destroy();
        return scratchpad.deleteAll();
      },
      all: () =>
        scratchpad
          .list()
          .map((n) => scratchpad.get({ id: n.id }))
          .filter((n): n is Note => n !== null),
    },
    meetings: {
      deleteAll: () => notetaker.deleteAll(),
      all: () => notetaker.all(),
      recordingActive: () => notetaker.recordingState().phase !== "idle",
      archiveAudio: (folder) => notetaker.archiveAudio(folder),
    },
    target,
    system,
    // Created further down; Reset runs long after start-up.
    account: {
      signOut: () => account.signOut(),
      switchPending: () => account.switchPending(),
      acceptOwner: () => account.acceptOwner(),
    },
    mcp: { resetAll: () => mcp.resetAll() },
  });

  // Scratchpad (Stage 9B): notes in the History database; AI edits through the AI cleanup service.
  const AI_NAMES: Record<string, string> = {
    groq: "Groq",
    openai: "OpenAI",
    anthropic: "Anthropic",
    gemini: "Google Gemini",
  };
  // Transforms (Stage 9C): the one AI path for rewriting text, shared with Scratchpad.
  const transforms = new TransformService({
    transforms: new TransformRepo(history.db),
    hotkeys,
    newId: () => randomUUID(),
    optedIn: () => settings.get().transforms.optIn,
    ai: () => service.cleanupProvider() as unknown as TextService,
    aiProvider: () => settings.get().cleanup.aiProvider,
    aiConsented: () =>
      settings
        .get()
        .scratchpad.aiConsent.includes(settings.get().cleanup.aiProvider),
    summaryConsented: () =>
      settings
        .get()
        .notetaker.summaryConsent.includes(settings.get().cleanup.aiProvider),
    aiName: () =>
      AI_NAMES[settings.get().cleanup.aiProvider] ?? "the AI service",
    onChange: () => hub?.window?.webContents.send("hub:transformsChanged"),
    log,
  });
  /** Agreeing once per AI service covers Scratchpad and Transforms (the same consent). */
  const allowAi = () => {
    const provider = settings.get().cleanup.aiProvider;
    const consent = settings.get().scratchpad.aiConsent;
    if (!consent.includes(provider))
      settings.update({ scratchpad: { aiConsent: [...consent, provider] } });
  };
  /** Meeting summaries have their own consent: a transcript holds other people's words. */
  const allowSummaryAi = (shown: string) => {
    const consent = grantSummaryConsent(shown, {
      provider: settings.get().cleanup.aiProvider,
      consent: settings.get().notetaker.summaryConsent,
    });
    if (consent.length !== settings.get().notetaker.summaryConsent.length)
      settings.update({ notetaker: { summaryConsent: consent } });
  };
  const scratchpad = new ScratchpadService({
    notes: new NoteRepo(history.db),
    newId: () => randomUUID(),
    openBehavior: () => settings.get().scratchpad.openBehavior,
    copy: async (text) => {
      clipboard.writeText(text);
      return (await clipboard.readText()) === text;
    },
    transforms,
    chooseExportPath: async (fileName) => {
      const parent = BrowserWindow.getFocusedWindow();
      const options = {
        defaultPath: join(app.getPath("documents"), fileName),
        filters: [
          { name: "Plain text", extensions: ["txt"] },
          { name: "Markdown", extensions: ["md"] },
        ],
      };
      const r = parent
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options);
      return r.canceled || !r.filePath ? null : r.filePath;
    },
    writeFile: (path, text) => writeFileAsync(path, text, "utf8"),
    onChange: () => {
      notesChanged();
    },
    log,
  });
  // Notetaker (Stage 9D-1): local meeting notes; recording arrives in Stage 9D-2.
  const SPEECH_NAMES: Record<string, string> = {
    openai: "OpenAI",
    groq: "Groq",
    deepgram: "Deepgram",
    gemini: "Google Gemini",
    "whisper.cpp": "whisper.cpp (on this Mac)",
  };
  // Meeting recording (Stage 9D-2): only ever started by the person.
  const meetingRepo = new MeetingRepo(history.db);
  let disposing = false;
  let tray: MurmurTray | null = null;
  let blocker: number | null = null;
  let lastTrayClock = "";
  let limitWarned = false;
  const recordingChanged = (s: RecordingState) => {
    hub?.window?.webContents.send("hub:recordingChanged", s);
    const live = s.phase !== "idle";
    capsule.setMeeting(
      live
        ? {
            text: `Meeting ${formatClock(s.elapsedMs)}`,
            paused: s.phase === "paused",
          }
        : null,
    );
    // Keep the Mac from suspending Murmur while it records.
    if (live && blocker === null)
      blocker = powerSaveBlocker.start("prevent-app-suspension");
    else if (!live && blocker !== null) {
      powerSaveBlocker.stop(blocker);
      blocker = null;
    }
    const trayClock = live ? `${s.phase}:${formatClock(s.elapsedMs)}` : "";
    if (trayClock !== lastTrayClock) {
      lastTrayClock = trayClock;
      tray?.refresh();
    }
    if (s.warning && !limitWarned && controller.currentPhase === "idle") {
      limitWarned = true;
      capsule.show("warning", s.warning);
      setTimeout(() => {
        if (controller.currentPhase === "idle") capsule.show("resting");
      }, 8000);
    }
    if (!live) limitWarned = false;
  };
  recorder = new MeetingRecorder({
    mic:
      overrides.meetingMic ??
      new RendererMeetingMic(audioLink, () => microphones.requested()),
    system: overrides.systemAudio ?? systemAudioSource,
    parts: meetingParts,
    meetings: meetingRepo,
    options: () => ({
      systemAudio: settings.get().notetaker.systemAudio,
      maxMinutes: settings.get().notetaker.maxRecordingMinutes,
      speakerLabels: settings.get().notetaker.speakerLabels,
    }),
    blocked: () =>
      controller.currentPhase !== "idle"
        ? "Finish the dictation first, then start recording."
        : null,
    onState: recordingChanged,
    onRecorded: (id) => {
      // On quit the meeting stays “processing”; the next launch offers to transcribe it.
      if (!disposing) void notetaker.transcribe({ id });
    },
    log,
    clock: {
      now: () => Date.now(),
      every: (ms, fn) => {
        const t = setInterval(fn, ms);
        return () => clearInterval(t);
      },
    },
  });
  const notetaker: NotetakerService = new NotetakerService({
    meetings: meetingRepo,
    newId: () => randomUUID(),
    retentionDays: () => settings.get().notetaker.retentionDays,
    readiness: async () => {
      const status = await service.getStatus();
      const s = settings.get();
      return {
        microphone: systemPreferences.getMediaAccessStatus("microphone") as
          "granted" | "denied" | "not-determined" | "restricted" | "unknown",
        transcription: {
          service: SPEECH_NAMES[s.speech.provider] ?? s.speech.provider,
          ready: status.providerReady,
        },
        summary: {
          service: AI_NAMES[s.cleanup.aiProvider] ?? "the AI service",
          ready: await service.cleanupProvider().readiness(),
        },
        systemAudio: (overrides.systemAudio ?? systemAudioSource).support(),
      };
    },
    chooseExportPath: async (fileName) => {
      const parent = BrowserWindow.getFocusedWindow();
      const options = {
        defaultPath: join(app.getPath("documents"), fileName),
        filters: [{ name: "Markdown", extensions: ["md"] }],
      };
      const r = parent
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options);
      return r.canceled || !r.filePath ? null : r.filePath;
    },
    writeFile: (path, text) => writeFileAsync(path, text, "utf8"),
    chooseImportFiles: async () => {
      const parent = BrowserWindow.getFocusedWindow();
      const options = {
        properties: ["openFile", "multiSelections"] as (
          "openFile" | "multiSelections"
        )[],
        filters: [{ name: "Notes", extensions: ["txt", "md", "markdown"] }],
      };
      const r = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options);
      return r.canceled ? [] : r.filePaths;
    },
    readFile: async (path) => {
      const st = await statAsync(path);
      return {
        name: basename(path),
        size: st.size,
        modifiedAt: st.mtimeMs,
        text: st.size > 500_000 ? "" : await readFileAsync(path, "utf8"),
      };
    },
    onChange: () => hub?.window?.webContents.send("hub:meetingsChanged"),
    log,
    recording: {
      recorder,
      parts: meetingParts,
      provider: () => overrides.provider ?? service.provider(),
      transcribeOptions: () => ({
        language: configFromSettings().language || undefined,
        languageHints: configFromSettings().languageHints,
        vocabulary: service.processingConfig().vocabulary,
      }),
      serviceLabel: (language) => {
        const provider = settings.get().speech.provider;
        const name = SPEECH_NAMES[provider] ?? provider;
        return language
          ? `${name} (language: ${language})`
          : `${name} (language detected automatically)`;
      },
      summarize: (requestId, text) => transforms.summarize(requestId, text),
      cancelSummary: (requestId) => void transforms.cancel(requestId),
      ready: () => {
        const n = settings.get().notetaker;
        return n.setupCompleted && n.consentAcknowledged
          ? null
          : "Set up Notetaker first: it explains what is recorded and asks you to confirm you'll tell people.";
      },
      onProgress: (p) =>
        hub?.window?.webContents.send("hub:transcriptionProgress", p),
    },
  });
  notetaker.recover();
  const notesChangedListeners = new Set<() => void>();
  const notesChanged = () => {
    for (const l of notesChangedListeners) l();
  };

  const bindShortcut = () => {
    const status = hotkeys.bind(env.shortcut || settings.get().shortcut);
    log("shortcut.bind", { ...status });
    service.notifyStatus();
    showShortcutNotice();
  };
  // A shortcut that couldn't be registered is a standing problem: say so on the capsule.
  const showShortcutNotice = () =>
    capsule.setNotice(
      hotkeys.current.registered
        ? null
        : "Shortcut unavailable — open Settings",
    );
  service.onStatusChanged(showShortcutNotice);
  bindShortcut();
  service.syncActionShortcuts();
  /**
   * Reads the saved keys and the recording key once macOS answers — in the background, so the
   * windows, shortcuts and everything not needing them work meanwhile. Concurrent calls share
   * one Keychain request; a late answer is applied when it comes.
   */
  // The Murmur account (Stage B). The refresh token is a Keychain-encrypted secret like the API
  // keys; the account contacts the server only after the person has signed in.
  const tokenVault = createTokenVault(secure, secrets, settings);
  const accountSink: { send: (status: AccountStatus) => void } = {
    send: () => {},
  };
  const account = new AccountService({
    fetch: overrides.accountFetch ?? fetch,
    serverUrl: () => settings.get().account.serverUrl,
    packaged: app.isPackaged,
    vault: tokenVault,
    appVersion: app.getVersion(),
    // A number of words for one local day, never any text.
    wordsOn: (day) => {
      const [y, m, d] = day.split("-").map(Number);
      return history.wordsBetween(
        new Date(y, m - 1, d).getTime(),
        new Date(y, m - 1, d + 1).getTime(),
      );
    },
    notify: (status) => accountSink.send(status),
    log,
    owner: {
      get: () => settings.get().account.owner,
      set: (owner) =>
        settings.set("account", { ...settings.get().account, owner }),
    },
    localData: () => service.localDataCounts(),
  });
  let unlocking: Promise<void> | null = null;
  const unlockSecureStorage = (): Promise<void> => {
    unlocking ??= (async () => {
      const started = Date.now();
      await Promise.all([secrets.unlock(), recordingKey.load()]);
      log("secure-storage.unlock", {
        state: secure.state,
        recordings: recordingKey.state,
        unreadableKeys: secrets.unreadableCount,
        ms: Date.now() - started,
      });
      service.notifyStatus();
      // A saved sign-in is checked once the Keychain has answered; no sign-in, no network.
      void account.restore();
    })().finally(() => (unlocking = null));
    return unlocking;
  };
  secure.onChange(() => service.notifyStatus());
  void unlockSecureStorage();
  // Local MCP server (Settings → MCP): meetings for AI apps on this Mac. Off until turned on.
  const mcpSink: { send: () => void } = { send: () => {} };
  const mcp = new McpService({
    clientsFile: join(userData, "mcp-clients.json"),
    home: overrides.mcpHome ?? app.getPath("home"),
    settings,
    meetings: meetingRepo,
    vault: {
      get: (name) => settings.getSecret(name),
      set: (name, value) => secrets.set(name, value),
    },
    unlock: async () => {
      await secrets.unlock();
      return secure.state === "available";
    },
    launch: () => ({
      command: process.execPath,
      args: app.isPackaged
        ? ["--mcp-stdio"]
        : [app.getAppPath(), "--mcp-stdio"],
    }),
    openExtension: (file) =>
      new Promise((resolve, reject) =>
        execFile("/usr/bin/open", ["-a", "Claude", file], (err) =>
          err ? reject(err) : resolve(),
        ),
      ),
    copy: (text) => clipboard.writeText(text),
    notify: () => mcpSink.send(),
    version: app.getVersion(),
    log,
  });
  void mcp.apply();
  const applyAppearance = () => {
    nativeTheme.themeSource = settings.get().appearance;
  };
  applyAppearance();
  /**
   * Murmur stays reachable without a Dock icon: the menu-bar icon opens it, and opening the app
   * again (Finder, Spotlight, Launchpad) brings the window back (second-instance / activate in
   * index.ts). Hiding the Dock icon deactivates the app, so a visible window is shown again.
   */
  const applyDock = async (): Promise<boolean> => {
    if (process.platform !== "darwin" || !app.dock) return true;
    const want = settings.get().system.showInDock;
    if (want) await app.dock.show();
    else {
      // macOS ignores a hide that arrives within about a second of showing the icon (measured
      // with Electron 44), so keep asking until it reports the icon gone.
      for (let i = 0; i < 15 && app.dock.isVisible(); i++) {
        app.dock.hide();
        await new Promise((r) => setTimeout(r, 200));
      }
      if (hub?.isVisible()) hub.show();
    }
    const ok = app.dock.isVisible() === want;
    if (!ok) log("dock.apply.failed", { want });
    return ok;
  };
  let transformsOptedIn = settings.get().transforms.optIn;
  let meetingRetention = settings.get().notetaker.retentionDays;
  // Pages that name the AI service (summary consent) refetch when it or its consent changes.
  const aiSignature = () =>
    JSON.stringify([
      settings.get().cleanup,
      settings.get().scratchpad.aiConsent,
      settings.get().notetaker.summaryConsent,
    ]);
  let aiShown = aiSignature();
  let calendarService: CalendarService | null = null;
  transforms.syncShortcuts();
  settings.onChange(() => {
    calendarService?.sync();
    notes?.send("note:prefsChanged", settings.get().scratchpad);
    if (overrides.manageDock) void applyDock();
    applyAppearance();
    controller.configure(configFromSettings());
    capsule.applyVisibility();
    service.syncActionShortcuts();
    // Opting in or out of Transforms registers or releases their shortcuts.
    if (settings.get().transforms.optIn !== transformsOptedIn) {
      transformsOptedIn = settings.get().transforms.optIn;
      transforms.syncShortcuts();
      if (!transformsOptedIn) sessions?.forget();
      hub?.window?.webContents.send("hub:transformsChanged");
    }
    if (aiSignature() !== aiShown) {
      aiShown = aiSignature();
      hub?.window?.webContents.send("hub:transformsChanged");
    }
    // A shorter "Keep meetings for" applies at once (the Hub asked the person to confirm).
    if (settings.get().notetaker.retentionDays !== meetingRetention) {
      meetingRetention = settings.get().notetaker.retentionDays;
      notetaker.purgeExpired();
    }
    if (
      !env.shortcut &&
      hotkeys.current.combo.toLowerCase() !==
        settings.get().shortcut.toLowerCase()
    )
      bindShortcut();
  });

  let hub: HubWindow | null = null;
  let transformPanel: TransformPanel | null = null;
  let sessions: TransformSessions | null = null;
  if (!overrides.headless) {
    registerHubIpc(service);
    hub = new HubWindow({ preload: preload("hub"), url: page("hub"), service });
    registerScratchpadIpc(
      scratchpad,
      notes!,
      {
        get: () => settings.get().scratchpad,
        update: (patch) =>
          // Validated by parseSettingsPatch; only the scratchpad section can change here.
          settings.update({ scratchpad: patch }).scratchpad,
        allowAi: (provider) => {
          // Only the service configured in Settings → AI cleanup can be agreed to.
          if (provider === settings.get().cleanup.aiProvider) allowAi();
          return settings.get().scratchpad;
        },
      },
      () => hub!.show("settings/ai"),
    );
    notesChangedListeners.add(() => {
      hub?.window?.webContents.send("hub:notesChanged");
      notes?.send("note:notesChanged");
    });
    // Transforms in other apps: a non-activating panel, the selection read only on request.
    transformPanel = new TransformPanel({
      preload: preload("transform"),
      url: page("transform"),
      onAction: (a) => void sessions?.act(a),
      armEscape: (onEscape) => hotkeys.armPanelEscape(onEscape),
    });
    sessions = new TransformSessions({
      ownPid: process.pid,
      accessibilityGranted: () => native.permissionStatus().accessibility,
      secureInput: () => native.permissionStatus().secureEventInput,
      readSelection: () => native.readSelection(),
      // Smoke runs never post a real ⌘C into the developer's app.
      copySelection: async (pid) =>
        overrides.copySelection?.(pid) ?? native.copySelection(pid, 600, 400),
      frontmost: () => native.frontmostApp(),
      clipboardRead: async () => (await clipboard.readText()) || null,
      copy: async (text) => {
        clipboard.writeText(text);
        return (await clipboard.readText()) === text;
      },
      paste: (text, target) => inserter.insert(text, target),
      transforms,
      allowAi,
      // Logged without text: which state the panel showed (to tell what happened on a press).
      panel: {
        show: (state) => {
          log("transform.panel", {
            kind: state.kind,
            ...(state.kind === "notice"
              ? { fix: state.fix ?? null, clipboard: Boolean(state.clipboard) }
              : {}),
            ...(state.kind === "review"
              ? { canReplace: state.canReplace }
              : {}),
          });
          transformPanel!.show(state);
        },
        hide: () => transformPanel!.hide(),
      },
      noteWindow: {
        focused: () => Boolean(notes?.window?.isFocused()),
        transform: (id) => notes?.send("note:transform", id),
      },
      openAiSettings: () => hub!.show("settings/ai"),
      openAccessibility: () => void openSystemSettings("accessibility"),
      newId: () => randomUUID(),
      log,
    });
    hotkeys.setTransformHandler((id) => {
      log("transform.shortcut", { id });
      void sessions?.start(id);
    });
    registerTransformIpc(
      transforms,
      sessions,
      allowAi,
      allowSummaryAi,
      history,
    );
    registerNotetakerIpc(notetaker);
    calendarService = new CalendarService({
      native: overrides.calendar ?? native,
      settings,
      startNotetaker: (input) => notetaker.startNotetaker(input),
      recording: () => notetaker.recordingState().phase !== "idle",
      notify: ({ title, body }) => {
        if (controller.currentPhase === "idle") {
          capsule.show("warning", REMINDER_BAR_MESSAGE);
          setTimeout(() => {
            if (controller.currentPhase === "idle") capsule.show("resting");
          }, 12_000);
        }
        if (Notification.isSupported()) {
          const n = new Notification({ title, body, silent: true });
          n.on("click", () => hub?.show("notetaker"));
          n.show();
        }
      },
      log,
    });
    calendarService.sync();
    registerConnectorsIpc(calendarService);
    registerAccountIpc(account, (choice) =>
      service.resolveAccountSwitch({ choice }),
    );
    registerMcpIpc(mcp);
    mcpSink.send = () => hub?.window?.webContents.send("hub:mcpChanged");
    accountSink.send = (status) =>
      hub?.window?.webContents.send("hub:accountChanged", status);
    const iconPath = join(__dirname, "../../resources/trayTemplate.png");
    tray = createTray(iconPath, {
      openHub: () => hub!.show("home"),
      openSettings: () => hub!.show("settings"),
      shortcutLabel: () => hotkeys.current.combo || settings.get().shortcut,
      lastTranscript: () => service.lastTranscript(),
      pasteLast: () => void pasteLastTranscript(),
      copyLast: (which) => copyLastTranscript(which),
      meeting: () => {
        const s = notetaker.recordingState();
        return s.phase === "idle"
          ? null
          : { paused: s.phase === "paused", clock: formatClock(s.elapsedMs) };
      },
      pauseMeeting: () => void notetaker.pauseRecording().catch(() => {}),
      resumeMeeting: () => void notetaker.resumeRecording().catch(() => {}),
      stopMeeting: () => void notetaker.stopRecording().catch(() => {}),
      openMeeting: () => {
        const id = notetaker.recordingState().meetingId;
        hub!.show(id ? `notetaker/${id}` : "notetaker");
      },
    });
  }

  if (overrides.manageDock) void applyDock();

  const lastActions = lastTranscriptActions({ service, controller, log });
  const pasteLastTranscript = lastActions.paste;
  const copyLastTranscript = lastActions.copy;
  /** “Join meeting / start Notetaker”: a new meeting, recording; setup first when it isn't done. */
  const startNotetakerFromShortcut = async () => {
    const live = notetaker.recordingState().meetingId;
    if (live) {
      hub?.show(`notetaker/${live}`);
      return;
    }
    const n = settings.get().notetaker;
    if (!n.setupCompleted || !n.consentAcknowledged) {
      hub?.show("notetaker/setup");
      return;
    }
    try {
      const m = await notetaker.startNotetaker();
      hub?.show(`notetaker/${m.id}`);
    } catch (err) {
      log("notetaker.shortcut.failed", { error: (err as Error).name });
      capsule.show("error", "Couldn't start recording — open Notetaker");
    }
  };

  const runShortcutAction = (
    action: ShortcutAction,
    kind: "pressed" | "released",
  ) => {
    if (action === "openScratchpad") {
      if (kind === "pressed") notes?.toggle();
      return;
    }
    if (action === "transformViewChanges") {
      if (kind === "pressed") sessions?.viewChanges();
      return;
    }
    if (action === "commandMode") {
      controller.commandHotkey(kind === "pressed" ? "down" : "up");
      return;
    }
    if (action === "pressEnter") {
      if (kind === "pressed") controller.pressEnter();
      return;
    }
    if (action === "startNotetaker") {
      if (kind === "pressed") void startNotetakerFromShortcut();
      return;
    }
    void lastActions.onShortcut(action, kind);
  };

  await capsule.ready();
  void service
    .purgeExpiredAudio()
    .then((n) => n && log("vault.purged", { count: n }));
  void service.purgeExpiredHistory();
  notetaker.purgeExpired();
  const purgeTimer = setInterval(
    () => {
      void Promise.all([
        service.purgeExpiredAudio(),
        service.purgeExpiredHistory(),
      ]);
      notetaker.purgeExpired();
    },
    6 * 60 * 60 * 1000,
  );

  return {
    controller,
    capsule,
    hub,
    notes,
    scratchpad,
    transforms,
    notetaker,
    account,
    get sessions() {
      return sessions;
    },
    get transformPanel() {
      return transformPanel;
    },
    service,
    settings,
    history,
    vault,
    hotkeys,
    microphones,
    audioWindow,
    audioLink,
    native,
    log,
    applyDock,
    pasteLastTranscript,
    copyLastTranscript,
    runShortcutAction,
    async dispose() {
      // A recording in progress is stopped and kept (its last part is saved first).
      disposing = true;
      await Promise.race([
        recorder?.stop("user"),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
      // Sound Murmur muted for a dictation is given back on a normal quit.
      muter.set(false);
      allowNoteWindowClose();
      sessions?.forget();
      clearInterval(purgeTimer);
      calendarService?.dispose();
      account.dispose();
      await mcp.dispose();
      hotkeys.dispose();
      history.close();
    },
  };
}

/** History port that tells the Hub to refresh whenever the controller writes a row. */
class NotifyingHistory implements HistoryPort {
  private readonly db: HistoryDb;
  private readonly notify: () => void;
  constructor(db: HistoryDb, notify: () => void) {
    this.db = db;
    this.notify = notify;
  }
  insert(row: DictationRecord): void {
    this.db.insert(row);
    this.notify();
  }
  update(id: string, patch: Partial<DictationRecord>): void {
    this.db.update(id, patch);
    this.notify();
  }
  get(id: string): DictationRecord | null {
    return this.db.get(id);
  }
}
