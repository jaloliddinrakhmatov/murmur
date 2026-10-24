// Orchestrates one dictation: hotkey → audio → transcription → cleanup → insertion → history.
// The hold-to-talk timing comes from the native HoldToTalk machine (validated in M0); this class
// adds the pipeline, the guards, and recovery. Every failure after audio was captured leaves a
// History row with stored audio so the dictation is never lost.
import {
  countWords,
  type CleanupLevel,
  type DictionaryEntry,
  type Snippet,
} from "@murmur/text";
import {
  processTranscript,
  type CleanupMode,
  type CleanupProvider,
  type PipelineResult,
} from "@murmur/refine";
import { redactSecrets } from "../../shared/redact.ts";
import { encodeWav, type TranscriptionProvider } from "@murmur/speech";
import type {
  AudioPort,
  AudioVaultPort,
  CancelHotkeyPort,
  CapsulePort,
  CapturedAudio,
  Clock,
  DictationRecord,
  HistoryPort,
  HoldMachine,
  Inserter,
  TargetProbe,
  TargetSnapshot,
} from "./types.ts";
import { AudioCaptureError } from "./types.ts";

export interface ControllerConfig {
  cleanupLevel: CleanupLevel;
  language: string;
  /** Two or more spoken languages: named to services that take a hint while detecting. */
  languageHints?: string[];
  transcribeTimeoutMs: number;
  /** Recordings shorter than this are ignored (M0: tap < 300 ms must not paste). */
  minDurationMs: number;
  /** Peak RMS below this means nothing was said. */
  silenceRms: number;
  /** How long the result state stays on the capsule. */
  resultDisplayMs: number;
  historyEnabled: boolean;
  /** Keep the encrypted recording after a successful insertion (never for password fields). */
  keepRecordings: boolean;
}

export const DEFAULT_CONTROLLER_CONFIG: ControllerConfig = {
  cleanupLevel: "light",
  language: "",
  transcribeTimeoutMs: 30_000,
  minDurationMs: 300,
  silenceRms: 0.004,
  resultDisplayMs: 900,
  historyEnabled: true,
  keepRecordings: false,
};

export interface ControllerDeps {
  hold: HoldMachine;
  audio: AudioPort;
  target: TargetProbe;
  inserter: Inserter;
  capsule: CapsulePort;
  cancelHotkey: CancelHotkeyPort;
  history: HistoryPort;
  vault: AudioVaultPort;
  provider: () => TranscriptionProvider;
  /** M2: dictionary, snippets and the cleanup mode/AI provider to use for the next dictation. */
  processing?: () => ProcessingConfig;
  /** Called with dictionary/snippet hit counts after each processed dictation. */
  onHits?: (hits: {
    dictionary: Record<string, number>;
    snippets: Record<string, number>;
  }) => void;
  clock: Clock;
  newId: () => string;
  log: (event: string, data?: Record<string, unknown>) => void;
  /**
   * Feedback sounds (Stage 6A). Only played while the microphone is closed, so Murmur never
   * records its own sounds: “stop” once the recording has been collected, “done” / “error”
   * with the result. There is deliberately no start sound (the microphone is opening then).
   */
  sound?: (kind: FeedbackSound) => void;
  /** The microphone opened or closed for a dictation (the Hub stops playing recordings). */
  micOpen?: (open: boolean) => void;
  /** Stage 9D-2: why dictation can't start now (a meeting is being recorded), or null. */
  busy?: () => string | null;
  /**
   * Stage E, Command Mode: `capture` reads the selection when its shortcut is pressed; `run`
   * gets the spoken instruction (it opens the Transform panel). Never saved to History.
   */
  command?: {
    capture(): unknown;
    run(instruction: string, selection: unknown): void;
  };
  /** Stage E, Press Enter: presses Return in the app in front. */
  /** `expectedPid`: the app that must still be in front (null when unknown, which refuses). */
  pressEnter?: (expectedPid: number | null) => {
    ok: boolean;
    reason?: string | null;
  };
  /** Stage E: mutes other audio while the microphone records (the caller checks the setting). */
  muteOutput?: (muted: boolean) => void;
  /**
   * Stage E part 2: names near the cursor, read once the microphone is open (context
   * awareness; [] when it's off). Used as vocabulary hints for this dictation only.
   */
  contextTerms?: () => string[];
  /** Whether context awareness is on; when false nothing is read, not even the target. */
  contextEnabled?: () => boolean;
  /** Whether either vibe coding option is on; when false (and context is off) nothing is read. */
  vibeEnabled?: () => boolean;
  /**
   * Vibe coding (VS Code, Cursor, Windsurf; each part off by default): `begin` runs once the
   * microphone is open and returns identifiers near the cursor as spelling hints for this
   * dictation; `apply` writes spoken identifiers and file names as the editor has them; `end`
   * drops what was read. Never called for Command Mode or a secure target.
   */
  vibe?: {
    begin(bundleId: string | null): string[];
    apply(text: string, bundleId: string | null): Promise<string>;
    end(): void;
  };
  /** Stage E part 2: the writing style for the app the text goes to. */
  styleText?: (text: string, bundleId: string | null) => string;
  /** Stage E part 2: a dictation was pasted (auto-add to dictionary watches the field). */
  inserted?: (text: string, target: TargetSnapshot) => void;
  /** Stage E part 2: a new dictation is starting (the previous one's field is checked first). */
  dictationStarting?: () => void;
}

export type FeedbackSound = "stop" | "done" | "error";

export interface ProcessingConfig {
  mode: CleanupMode;
  dictionary: DictionaryEntry[];
  snippets: Snippet[];
  /** Dictionary phrases sent to the speech provider as vocabulary hints. */
  vocabulary: string[];
  ai?: { provider: CleanupProvider; timeoutMs: number };
}

export type Phase = "idle" | "recording" | "processing";

export class DictationController {
  private currentPhaseValue: Phase = "idle";
  private get phase(): Phase {
    return this.currentPhaseValue;
  }
  private set phase(next: Phase) {
    const wasOpen = this.currentPhaseValue === "recording";
    this.currentPhaseValue = next;
    if (wasOpen !== (next === "recording"))
      this.deps.micOpen?.(next === "recording");
  }
  private stopTick: (() => void) | null = null;
  private disarmCancel: (() => void) | null = null;
  private clearResult: (() => void) | null = null;
  private recordingStartedAt = 0;
  /** Increments per recording, so a late microphone failure can tell whose it is. */
  private recordingAttempt = 0;
  /** Set when the microphone went away mid-recording; shown with the result. */
  private interruption: string | null = null;
  /** Aborts the transcription of the dictation being processed (Esc / Capsule cancel). */
  private abort: AbortController | null = null;
  /** True once text is being handed to the inserter: from then on it can't be cancelled. */
  private inserting = false;
  /** A History write failed for the current dictation; it still completes, and says so. */
  private historyFailed = false;
  /** History setting read once when the dictation is released. */
  private historyOn = true;
  /** Read once when the dictation is released, like `historyOn`. */
  private keepRecordings = false;
  /** Wall-clock marks for the privacy-safe `dictation.timing` diagnostic (no content). */
  private marks: Record<string, number> = {};
  /** What this recording is for: text to insert, or a Command Mode instruction. */
  private intent: "dictate" | "command" = "dictate";
  private commandSelection: unknown = null;
  /** Press Return once this dictation's text has been pasted. */
  private enterAfter = false;
  private muted = false;
  /** Names read near the cursor for the current dictation (never stored). */
  private contextHints: string[] = [];
  private config: ControllerConfig;
  private readonly deps: ControllerDeps;

  constructor(deps: ControllerDeps, config: Partial<ControllerConfig> = {}) {
    this.deps = deps;
    this.config = { ...DEFAULT_CONTROLLER_CONFIG, ...config };
  }

  get currentPhase(): Phase {
    return this.phase;
  }

  configure(patch: Partial<ControllerConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  /** Why dictation can't start now (a meeting is being recorded), shown instead; else null. */
  private blocked(): string | null {
    return this.phase === "idle" && this.deps.hold.state === "idle"
      ? (this.deps.busy?.() ?? null)
      : null;
  }

  /** Called by the hotkey adapter on Carbon press/release. */
  hotkey(kind: "down" | "up"): void {
    const blocked = this.blocked();
    if (blocked) {
      if (kind === "down") this.showResult("warning", blocked);
      return;
    }
    if (this.phase === "processing") {
      if (kind === "down")
        this.deps.capsule.show("processing", "Still writing the last one…");
      return;
    }
    if (kind === "down" && this.phase === "idle") this.intent = "dictate";
    this.dispatch(this.deps.hold.handle(kind, this.deps.clock.now()));
  }

  /**
   * Command Mode's shortcut, held like push to talk: the selection is read at the press, the
   * spoken instruction goes to the Transform panel instead of being inserted.
   */
  commandHotkey(kind: "down" | "up"): void {
    if (!this.deps.command) return;
    if (kind === "down") {
      if (this.phase !== "idle" || this.deps.hold.state !== "idle") return;
      const blocked = this.blocked();
      if (blocked) {
        this.showResult("warning", blocked);
        return;
      }
      this.intent = "command";
      this.commandSelection = this.deps.command.capture();
      this.dispatch(this.deps.hold.handle("down", this.deps.clock.now()));
    } else if (this.intent === "command" && this.phase === "recording")
      this.dispatch(this.deps.hold.handle("up", this.deps.clock.now()));
  }

  /**
   * Press Enter's shortcut: during a dictation it stops it and presses Return once the text is
   * pasted (only then); otherwise it presses Return at once.
   */
  pressEnter(): void {
    if (this.phase === "recording" && this.intent === "dictate") {
      this.enterAfter = true;
      const t = this.deps.clock.now();
      this.dispatch(this.deps.hold.handle("down", t + 1000));
      this.dispatch(this.deps.hold.handle("up", t + 1001));
      return;
    }
    if (this.phase === "processing") {
      if (this.intent === "dictate") this.enterAfter = true;
      return;
    }
    if (this.phase !== "idle") return;
    const r = this.deps.pressEnter?.(this.deps.target.snapshot().pid);
    this.deps.log("enter.pressed", { ok: r?.ok ?? false, reason: r?.reason });
    if (r && !r.ok)
      this.showResult(
        "warning",
        r.reason === "no-post-event-permission"
          ? "Enter needs Accessibility access"
          : r.reason === "target-changed"
            ? "Enter not sent: app changed"
            : r.reason === "secure-input"
              ? "Enter not sent: password field"
              : "Enter not sent",
      );
  }

  private setMuted(muted: boolean): void {
    if (this.muted === muted) return;
    this.muted = muted;
    this.deps.muteOutput?.(muted);
  }

  /** Capsule click: start hands-free when idle, stop when recording. */
  toggleFromCapsule(): void {
    if (this.phase === "processing") return;
    const blocked = this.blocked();
    if (blocked) {
      this.showResult("warning", blocked);
      return;
    }
    const t = this.deps.clock.now();
    if (this.phase === "idle") {
      this.intent = "dictate";
      // Simulate the double-tap that enters hands-free in the native machine.
      this.dispatch(this.deps.hold.handle("down", t));
      this.dispatch(this.deps.hold.handle("up", t + 1));
      this.dispatch(this.deps.hold.handle("down", t + 2));
      this.dispatch(this.deps.hold.handle("up", t + 3));
    } else {
      this.dispatch(this.deps.hold.handle("down", t + 1000));
      this.dispatch(this.deps.hold.handle("up", t + 1001));
    }
  }

  /**
   * Esc or the Capsule's cancel. While recording it discards the recording. After release it
   * stops the dictation at the next step (transcription is aborted at once) until the text is
   * handed to the inserter; a paste already under way can't be taken back.
   */
  cancel(): void {
    if (this.phase === "processing") {
      if (this.abort && !this.inserting && !this.abort.signal.aborted) {
        this.deps.log("dictation.cancel.requested", { phase: "processing" });
        this.abort.abort();
      }
      return;
    }
    if (this.phase !== "recording") return;
    this.dispatch(this.deps.hold.handle("cancel", this.deps.clock.now()));
  }

  /**
   * The microphone disappeared mid-recording (unplugged, or access revoked). Murmur never
   * switches to another input on its own: it stops, keeps what was recorded up to that point,
   * processes it as usual, and says why the recording ended.
   */
  microphoneLost(): void {
    if (this.phase !== "recording") return;
    this.deps.log("audio.device.lost", {});
    this.interruption = "Mic disconnected";
    // Reset the native machine; the key may still be held, and its release must start nothing.
    this.deps.hold.handle("cancel", this.deps.clock.now());
    void this.stopAndProcess("device-lost");
  }

  private dispatch(outputs: string[]): void {
    for (const o of outputs) {
      if (o === "start") void this.startRecording();
      else if (o === "handsFree") this.deps.capsule.show("handsFree");
      else if (o === "warn")
        this.deps.capsule.show(
          "warning",
          "Stopping in 1 minute (20-minute limit)",
        );
      else if (o.startsWith("stop:")) void this.stopAndProcess(o.slice(5));
      else if (o.startsWith("cancel:")) void this.cancelRecording(o.slice(7));
    }
  }

  private async startRecording(): Promise<void> {
    if (this.phase !== "idle") return;
    this.phase = "recording";
    this.interruption = null;
    this.marks = { pressed: Date.now() };
    const attempt = ++this.recordingAttempt;
    this.clearResult?.();
    this.recordingStartedAt = this.deps.clock.now();
    this.deps.capsule.show(
      "listening",
      this.intent === "command" ? "Say what to do" : undefined,
    );
    this.setMuted(true);
    this.disarmCancel = this.deps.cancelHotkey.arm(() => this.cancel());
    this.stopTick = this.deps.clock.setInterval(
      () => this.dispatch(this.deps.hold.handle("tick", this.deps.clock.now())),
      250,
    );
    this.contextHints = [];
    if (this.intent === "dictate") this.deps.dictationStarting?.();
    try {
      await this.deps.audio.start();
      this.marks.micReady = Date.now();
      // After the microphone is open, so reading the app never delays it.
      const contextOn = this.deps.contextEnabled?.() ?? true;
      if (
        this.intent === "dictate" &&
        attempt === this.recordingAttempt &&
        (contextOn || (this.deps.vibe && (this.deps.vibeEnabled?.() ?? true)))
      ) {
        const target = this.deps.target.snapshot();
        if (!target.secure) {
          if (contextOn) this.contextHints = this.deps.contextTerms?.() ?? [];
          this.contextHints = [
            ...this.contextHints,
            ...(this.deps.vibe?.begin(target.appBundleId) ?? []),
          ];
        }
      }
    } catch (err) {
      // A failure that arrives after this attempt was cancelled (or a newer one began) belongs
      // to nothing on screen: never report it or reset the current recording.
      if (
        attempt !== this.recordingAttempt ||
        this.currentPhase === "idle" ||
        (err instanceof AudioCaptureError && err.code === "cancelled")
      ) {
        this.deps.log("audio.start.stale", { error: String(err) });
        return;
      }
      if (this.currentPhase === "processing") {
        // Released while the microphone was still opening: processRecording reports the outcome.
        this.deps.log("audio.start.failed-after-release", {
          error: String(err),
        });
        return;
      }
      this.deps.log("audio.start.failed", { error: String(err) });
      // The renderer may still open the microphone later; nothing on screen would show it.
      void this.deps.audio.cancel().catch(() => {});
      this.teardownRecording();
      // Reset the native machine so the next press starts cleanly.
      this.deps.hold.handle("cancel", this.deps.clock.now());
      this.phase = "idle";
      this.setMuted(false);
      this.showResult("error", this.audioErrorMessage(err));
    }
  }

  private audioErrorMessage(err: unknown): string {
    if (err instanceof AudioCaptureError) {
      switch (err.code) {
        case "permission-denied":
          return "Microphone access is off — open Settings";
        case "no-device":
          return "No microphone found";
        case "device-busy":
          return "Microphone is in use by another app";
        default:
          return "Couldn't start the microphone";
      }
    }
    return "Couldn't start the microphone";
  }

  private teardownRecording(): void {
    this.stopTick?.();
    this.stopTick = null;
    this.disarmCancel?.();
    this.disarmCancel = null;
  }

  private async cancelRecording(reason: string): Promise<void> {
    if (this.phase !== "recording") return;
    this.teardownRecording();
    this.phase = "idle";
    this.setMuted(false);
    this.enterAfter = false;
    await this.deps.audio.cancel().catch(() => {});
    this.deps.log("dictation.cancelled", { reason });
    // Only a deliberate cancel is confirmed; an accidental tap or chord just clears.
    if (reason === "user") this.showResult("cancelled");
    else this.deps.capsule.show("resting");
  }

  /**
   * Release (or the end of hands-free): processes the recording. Whatever happens inside, the
   * controller ends idle with a result on the Capsule; an unexpected error never leaves it stuck
   * in "processing".
   */
  private async stopAndProcess(reason: string): Promise<void> {
    if (this.phase !== "recording") return;
    // Esc stays armed through processing, so a dictation can still be cancelled after release.
    this.stopTick?.();
    this.stopTick = null;
    this.phase = "processing";
    this.setMuted(false);
    const attempt = this.recordingAttempt;
    this.abort = new AbortController();
    this.inserting = false;
    this.historyFailed = false;
    this.historyOn = this.config.historyEnabled;
    this.keepRecordings = this.config.keepRecordings;
    this.marks.released = Date.now();
    try {
      await this.processRecording(reason);
    } catch (err) {
      this.deps.log("dictation.unexpected", {
        error: redactSecrets(String(err)),
      });
      if (this.phase === "processing" && attempt === this.recordingAttempt)
        this.finish("error", "Something went wrong — please try again");
    } finally {
      this.disarmCancel?.();
      this.disarmCancel = null;
      this.abort = null;
      this.inserting = false;
    }
  }

  private get cancelled(): boolean {
    return Boolean(this.abort?.signal.aborted);
  }

  /** Writes to History; a failure is logged and the dictation carries on without History. */
  private saveHistory(run: () => void): void {
    if (!this.historyOn || this.historyFailed) return;
    try {
      run();
    } catch (err) {
      this.historyFailed = true;
      this.deps.log("history.write.failed", {
        error: redactSecrets(String(err)),
      });
    }
  }

  /** A dictation cancelled after release: nothing is inserted, and its recording is discarded. */
  private async finishCancelled(id: string | null, stage: string) {
    this.deps.log("dictation.cancelled", { reason: "user", stage });
    if (id) {
      this.saveHistory(() =>
        this.deps.history.update(id, {
          status: "cancelled",
          error: "cancelled",
          hasAudio: false,
        }),
      );
      await this.deps.vault.remove(id).catch(() => {});
    }
    this.finish("cancelled");
  }

  /**
   * The target is a password field: nothing can be inserted, so the audio is never sent to
   * transcription or AI cleanup. The History row records only that it was refused.
   */
  private finishSecure(target: TargetSnapshot, durationMs: number): void {
    this.contextHints = [];
    this.saveHistory(() =>
      this.deps.history.insert({
        id: this.deps.newId(),
        startedAt: Date.now() - durationMs,
        durationMs,
        status: "rejected",
        strategy: "rejected",
        rawText: null,
        finalText: null,
        wordCount: 0,
        appName: target.appName,
        appBundleId: target.appBundleId,
        error: "secure-field",
        provider: this.deps.provider().id,
        hasAudio: false,
      }),
    );
    this.deps.log("dictation.secure-target", { durationMs });
    this.finish("error", "Password field — not inserted");
  }

  private async processRecording(reason: string): Promise<void> {
    // The target is whatever is focused at release (architecture §5).
    const target = this.deps.target.snapshot();
    this.deps.capsule.show("processing");
    let audio: CapturedAudio;
    try {
      audio = await this.deps.audio.stop();
    } catch (err) {
      this.deps.log("audio.stop.failed", { error: String(err) });
      this.finish("error", this.audioErrorMessage(err));
      return;
    }
    this.marks.stopped = Date.now();
    if (this.cancelled) return this.finishCancelled(null, "stop");
    if (audio.durationMs < this.config.minDurationMs) {
      this.deps.log("dictation.too-short", {
        durationMs: audio.durationMs,
        reason,
      });
      // Taps never get here (the hold machine cancels them), so a held shortcut with almost no
      // audio means the microphone opened late: say so rather than dropping it silently.
      if (this.interruption) this.finish("resting");
      else this.finish("error", "Mic was still starting — try again");
      return;
    }
    if (audio.peakRms < this.config.silenceRms) {
      this.deps.log("dictation.silent", { peakRms: audio.peakRms });
      this.finish("error", "Didn't catch that — is your mic muted?");
      return;
    }
    this.deps.sound?.("stop");

    // Words meant for a password field are never kept: no text, no recording, no retry.
    if (target.secure) {
      // A Command Mode instruction is not a dictation: nothing at all goes to History.
      if (this.intent === "command") {
        this.deps.log("command.secure-target", {
          durationMs: audio.durationMs,
        });
        this.commandSelection = null;
        this.finish("error", "Password field — command not run");
        return;
      }
      return this.finishSecure(target, audio.durationMs);
    }

    const id = this.deps.newId();
    const record: DictationRecord = {
      id,
      startedAt: Date.now() - audio.durationMs,
      durationMs: audio.durationMs,
      status: "transcribing",
      strategy: null,
      rawText: null,
      finalText: null,
      wordCount: 0,
      appName: target.appName,
      appBundleId: target.appBundleId,
      error: null,
      provider: this.deps.provider().id,
      hasAudio: false,
    };
    const wav = encodeWav(audio.samples, audio.sampleRate);
    // A Command Mode instruction is not a dictation: it isn't kept in History.
    const command = this.intent === "command";
    if (!command) this.saveHistory(() => this.deps.history.insert(record));
    if (!command && this.historyOn && !this.historyFailed) {
      try {
        await this.deps.vault.save(id, wav);
        record.hasAudio = true;
        this.saveHistory(() =>
          this.deps.history.update(id, { hasAudio: true }),
        );
      } catch (err) {
        this.deps.log("vault.save.failed", { error: String(err) });
      }
    }

    this.marks.transcribeStart = Date.now();
    const transcript = await this.transcribe(
      wav,
      audio.durationMs / 1000,
      this.abort?.signal,
    );
    this.marks.transcribeEnd = Date.now();
    if (this.cancelled) return this.finishCancelled(id, "transcription");
    if (!transcript.ok) {
      this.saveHistory(() =>
        this.deps.history.update(id, {
          status: "failed",
          error: transcript.error,
        }),
      );
      this.finish(
        "error",
        command
          ? transcript.message.replace(" — retry from History", "")
          : transcript.message,
      );
      return;
    }
    if (command) {
      this.deps.log("command.heard", { chars: transcript.text.length });
      this.deps.command?.run(transcript.text, this.commandSelection);
      this.commandSelection = null;
      this.finish("resting");
      return;
    }
    if (this.processing().mode === "ai") this.deps.capsule.show("refining");
    const processed = await this.process(transcript.text);
    this.marks.processed = Date.now();
    if (this.cancelled) return this.finishCancelled(id, "cleanup");
    const styled = this.deps.styleText
      ? this.deps.styleText(processed.text, target.appBundleId)
      : processed.text;
    const final =
      this.deps.vibe && !target.secure && styled
        ? await this.deps.vibe
            .apply(styled, target.appBundleId)
            .catch(() => styled)
        : styled;
    const wordCount = countWords(final);
    this.saveHistory(() =>
      this.deps.history.update(id, DictationController.provenance(processed)),
    );
    if (!final) {
      this.saveHistory(() =>
        this.deps.history.update(id, {
          status: "empty",
          rawText: transcript.text,
          finalText: "",
        }),
      );
      this.finish("error", "Didn't catch that");
      return;
    }

    // Last point a cancel is honoured: after this the text is on its way to the app.
    if (this.cancelled) return this.finishCancelled(id, "insertion");
    this.inserting = true;
    this.disarmCancel?.();
    this.disarmCancel = null;
    this.deps.capsule.show("inserting");
    const outcome = await this.deps.inserter.insert(final, target, {
      durationMs: audio.durationMs,
    });
    this.marks.inserted = Date.now();
    const status =
      outcome.strategy === "clipboard-paste" || outcome.strategy === "direct"
        ? "inserted"
        : outcome.strategy === "clipboard-only"
          ? "copied"
          : "rejected";
    // The field turned out to be secure only at insertion.
    const secret = outcome.reason === "secure-field";
    this.saveHistory(() =>
      this.deps.history.update(id, {
        status,
        strategy: outcome.strategy,
        rawText: secret ? null : transcript.text,
        finalText: secret ? null : final,
        wordCount: secret ? 0 : wordCount,
        error: outcome.reason ?? null,
        // Drop what was saved before.
        ...(secret ? { aiRejectedText: null } : {}),
      }),
    );
    if (
      ((status === "inserted" && !this.keepRecordings) || secret) &&
      record.hasAudio
    ) {
      // Audio is otherwise only needed to retry (or, when kept, to play back until it expires).
      await this.deps.vault.remove(id).catch(() => {});
      this.saveHistory(() => this.deps.history.update(id, { hasAudio: false }));
    }
    if (status === "inserted") this.deps.inserted?.(final, target);
    if (this.enterAfter && status === "inserted") {
      const r = this.deps.pressEnter?.(target.pid);
      this.deps.log("enter.after-dictation", {
        ok: r?.ok ?? false,
        reason: r?.reason,
      });
    }
    this.deps.log("dictation.done", {
      id,
      status,
      strategy: outcome.strategy,
      reason: outcome.reason,
      words: wordCount,
      durationMs: audio.durationMs,
    });
    if (status === "inserted") this.finish("inserted");
    else if (status === "copied")
      this.finish(
        "copied",
        outcome.reason === "self-target"
          ? "Murmur is in front — copied, press ⌘V"
          : outcome.reason === "target-changed"
            ? "App changed — copied, press ⌘V"
            : outcome.reason === "no-post-event-permission"
              ? "Paste is off — copied, press ⌘V"
              : "Copied — press ⌘V to paste",
      );
    else
      this.finish(
        "error",
        outcome.reason === "secure-field"
          ? "Password field — not inserted"
          : "Couldn't insert — copy it from History",
      );
  }

  private processing(): ProcessingConfig {
    return (
      this.deps.processing?.() ?? {
        mode: this.config.cleanupLevel === "off" ? "off" : "deterministic",
        dictionary: [],
        snippets: [],
        vocabulary: [],
      }
    );
  }

  private async process(raw: string): Promise<PipelineResult> {
    const p = this.processing();
    const result = await processTranscript(raw, {
      mode: p.mode,
      dictionary: p.dictionary,
      snippets: p.snippets,
      ai: p.ai,
      language: this.config.language,
    });
    if (
      Object.keys(result.dictionaryHits).length ||
      Object.keys(result.snippetHits).length
    )
      this.deps.onHits?.({
        dictionary: result.dictionaryHits,
        snippets: result.snippetHits,
      });
    return result;
  }

  private static provenance(r: PipelineResult) {
    const note = r.aiFallbackReason
      ? `ai-fallback:${r.aiFallbackReason}`
      : r.aiLatencyMs != null
        ? `ai-latency:${r.aiLatencyMs}ms`
        : null;
    return {
      cleanupUsed: r.cleanupUsed,
      cleanupNote: note,
      aiRejectedText: r.aiRejectedText ?? null,
    };
  }

  private async transcribe(
    wav: Uint8Array<ArrayBuffer>,
    durationSec: number,
    cancel?: AbortSignal,
  ): Promise<
    { ok: true; text: string } | { ok: false; error: string; message: string }
  > {
    const provider = this.deps.provider();
    const notReady = await provider.readiness();
    if (notReady)
      return {
        ok: false,
        error: `not-configured: ${notReady}`,
        message: /Keychain/.test(notReady)
          ? "Keychain locked — allow Murmur, retry"
          : "Set up transcription in Settings",
      };
    try {
      const result = await provider.transcribe(
        { wav, durationSec },
        {
          language: this.config.language || undefined,
          languageHints: this.config.languageHints?.length
            ? this.config.languageHints
            : undefined,
          vocabulary: mergeVocabulary(
            this.processing().vocabulary,
            this.contextHints,
          ),
          signal: cancel
            ? AbortSignal.any([
                AbortSignal.timeout(this.config.transcribeTimeoutMs),
                cancel,
              ])
            : AbortSignal.timeout(this.config.transcribeTimeoutMs),
        },
      );
      return { ok: true, text: result.text };
    } catch (err) {
      const failure = transcriptionFailure(err);
      this.deps.log("transcription.failed", {
        kind: failure.kind,
        status: (err as { status?: number })?.status ?? null,
      });
      return {
        ok: false,
        error: failure.kind === "timeout" ? "timeout" : failure.error,
        message: failure.message,
      };
    }
  }

  /** Re-transcribes stored audio. The original target is gone, so the result is copied, never pasted. */
  async retry(
    id: string,
    copyToClipboard: (text: string) => Promise<void>,
  ): Promise<DictationRecord | null> {
    const row = this.deps.history.get(id);
    if (!row) return null;
    // A row without audio (a password field, a cancelled or inserted dictation) is never retried.
    if (!row.hasAudio) return row;
    // Too long for the service it was sent to: the same service would fail the same way.
    if (
      row.error?.startsWith("too-long:") &&
      row.provider === this.deps.provider().id
    )
      return row;
    const wav = await this.deps.vault.load(id);
    if (!wav) {
      // Expired or deleted: the row must stop offering a retry that cannot work.
      this.deps.history.update(id, {
        error: "audio no longer available",
        hasAudio: false,
      });
      return this.deps.history.get(id);
    }
    this.deps.history.update(id, {
      status: "transcribing",
      error: null,
      provider: this.deps.provider().id,
    });
    const transcript = await this.transcribe(wav, row.durationMs / 1000);
    if (!transcript.ok) {
      this.deps.history.update(id, {
        status: "failed",
        error: transcript.error,
      });
      return this.deps.history.get(id);
    }
    const processed = await this.process(transcript.text);
    const final = processed.text;
    await copyToClipboard(final);
    this.deps.history.update(id, DictationController.provenance(processed));
    this.deps.history.update(id, {
      status: "copied",
      strategy: "clipboard-only",
      rawText: transcript.text,
      finalText: final,
      wordCount: countWords(final),
      error: null,
    });
    return this.deps.history.get(id);
  }

  private finish(
    state: "resting" | "inserted" | "copied" | "cancelled" | "error",
    message?: string,
  ): void {
    this.phase = "idle";
    this.enterAfter = false;
    this.commandSelection = null;
    this.contextHints = [];
    this.deps.vibe?.end();
    this.logTiming(state);
    if (this.historyFailed) {
      this.historyFailed = false;
      if (state === "inserted" || state === "copied" || state === "error") {
        const base = (
          message ??
          (state === "inserted"
            ? "Inserted"
            : state === "copied"
              ? "Copied — press ⌘V"
              : "")
        ).replace(/ — retry from History| — copy it from History/, "");
        message = fitCapsule(base, " · not saved to History");
      }
    }
    const note = this.interruption;
    this.interruption = null;
    if (note) {
      if (state === "resting") {
        state = "error";
        message = `${note} — nothing was recorded`;
      } else if (state === "inserted")
        message = `${note} — inserted what it heard`;
      else if (state === "copied") message = `${note} — copied, press ⌘V`;
      // An error keeps its own reason, the more useful of the two.
    }
    this.showResult(state, message);
  }

  /** Stage durations in ms for this dictation (metadata only; never text or audio). */
  private logTiming(outcome: string): void {
    const m = this.marks;
    if (!m.pressed) return;
    const span = (a: string, b: string) =>
      m[a] != null && m[b] != null ? m[b] - m[a] : null;
    this.deps.log("dictation.timing", {
      outcome,
      micOpenMs: span("pressed", "micReady"),
      firstAudioMs:
        this.deps.audio.firstAudioAt != null
          ? this.deps.audio.firstAudioAt - m.pressed
          : null,
      recordingMs: span("pressed", "released"),
      stopMs: span("released", "stopped"),
      transcribeMs: span("transcribeStart", "transcribeEnd"),
      processMs: span("transcribeEnd", "processed"),
      insertMs: span("processed", "inserted"),
      releaseToResultMs: m.released != null ? Date.now() - m.released : null,
    });
    this.marks = {};
  }

  /**
   * Shows the result of something done outside a dictation (e.g. pasting the last transcript
   * from the menu bar) the same way a dictation's result is shown. Ignored while dictating.
   */
  announce(state: "inserted" | "copied" | "error", message?: string): void {
    if (this.phase !== "idle") return;
    this.showResult(state, message);
  }

  private showResult(
    state:
      "resting" | "inserted" | "copied" | "cancelled" | "error" | "warning",
    message?: string,
  ): void {
    this.clearResult?.();
    if (state === "inserted" || state === "copied") this.deps.sound?.("done");
    else if (state === "error") this.deps.sound?.("error");
    this.deps.capsule.show(state, message);
    if (state !== "resting") {
      const hold =
        state === "error" || state === "copied" || message
          ? this.config.resultDisplayMs * 4
          : this.config.resultDisplayMs;
      this.clearResult = this.deps.clock.setTimeout(() => {
        this.clearResult = null;
        this.deps.capsule.show("resting");
      }, hold);
    }
  }
}

export type { TargetSnapshot };

/**
 * What a failed transcription means for the person dictating. `error` (stored in History) keeps
 * the provider's message with secrets removed; `message` is the Capsule's plain explanation.
 */
export function transcriptionFailure(err: unknown): {
  kind:
    | "too-long"
    | "timeout"
    | "auth"
    | "rate-limit"
    | "quota"
    | "language"
    | "network"
    | "service"
    | "other";
  error: string;
  message: string;
} {
  const e = err as {
    name?: string;
    message?: string;
    status?: number;
    code?: string;
    providerId?: string;
    cause?: unknown;
  };
  const text = String(e?.message ?? err);
  const error = redactSecrets(text);
  const status = e?.status;
  // A longer recording than this service accepts: retrying with the same service never works.
  if (e?.code === "too-long")
    return {
      kind: "too-long",
      error: `too-long: ${error}`,
      message:
        e.providerId === "gemini"
          ? "Too long for Gemini — switch service"
          : "Too long — switch service",
    };
  if (e?.name === "TimeoutError" || e?.name === "AbortError")
    return {
      kind: "timeout",
      error,
      message: "Timed out — retry from History",
    };
  if (status === 401 || status === 403)
    return {
      kind: "auth",
      error,
      message: "API key rejected — check Settings",
    };
  // Out of credits or quota (OpenAI answers 429 "insufficient_quota"): waiting won't help.
  if (
    (status === 429 || status === 402) &&
    /quota|credit|billing|balance/i.test(text)
  )
    return {
      kind: "quota",
      error,
      message: "No credits left on this API key",
    };
  if (status === 429)
    return {
      kind: "rate-limit",
      error,
      message: "Service busy — retry from History",
    };
  if ((status === 400 || status === 422) && /language/i.test(text))
    return {
      kind: "language",
      error,
      message: "Language not supported — check Settings",
    };
  if (
    status === undefined &&
    (e?.name === "TypeError" ||
      /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|network/i.test(text))
  )
    return {
      kind: "network",
      error,
      message: "No connection — retry from History",
    };
  if (status !== undefined && status >= 500)
    return {
      kind: "service",
      error,
      message: "Service error — retry from History",
    };
  return {
    kind: "other",
    error,
    message: "Transcription failed — retry from History",
  };
}

/** The Capsule shows about 44 characters; longer messages are kept at or under this. */
export const CAPSULE_MESSAGE_MAX = 41;

/** `main` plus `extra` when both fit on the Capsule, else just `main`. */
export function fitCapsule(main: string, extra: string): string {
  return [...(main + extra)].length <= CAPSULE_MESSAGE_MAX
    ? main + extra
    : main;
}

/** Dictionary vocabulary first, then names from the context, without repeats (at most 50). */
function mergeVocabulary(dictionary: string[], context: string[]): string[] {
  const seen = new Set<string>();
  return [...dictionary, ...context]
    .filter((w) => {
      const k = w.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 50);
}
