// Main-process support for the first-run setup (shared/onboarding.ts documents the screens' API):
//  - practice fields in the Hub: while one has focus a dictation goes straight into it;
//  - the shortcut test: the dictation shortcut only reports key up/down, nothing is recorded;
//  - the "Your Mac's sound" Allow: a short-lived probe of the sound tap, on a click only.
// Nothing here posts a keystroke, opens the microphone or records.
import { countWords } from "@murmur/text";
import {
  PracticeFocusSchema,
  WatchShortcutSchema,
  type PracticeTextEvent,
  type ShortcutStateEvent,
  type SystemAudioStatus,
} from "../../shared/onboarding.ts";
import { systemAudioReason } from "../../shared/meetings.ts";
import type {
  Inserter,
  InsertMeta,
  InsertOutcome,
  TargetSnapshot,
} from "../core/types.ts";

/** The shortcut test ends by itself so a forgotten test can't leave dictation switched off. */
export const WATCH_TTL_MS = 2 * 60_000;
/** The macOS prompt can stay open for a while; after this the probe gives up and stops. */
export const PROBE_TIMEOUT_MS = 90_000;

/** The sound tap, as the probe uses it (the meeting recorder's SystemAudio has more). */
export interface SoundTapProbe {
  support(): string;
  start(): Promise<void>;
  stop(): void;
}

export interface OnboardingPorts {
  /** Sends a Hub event; false when there is no Hub window to receive it. */
  send(channel: "hub:practiceText", payload: PracticeTextEvent): boolean;
  send(channel: "hub:shortcutState", payload: ShortcutStateEvent): boolean;
  /** The Hub window is visible and has the keyboard. */
  hubFocused(): boolean;
  /** Null in automated runs (they must never show macOS's permission prompt). */
  soundTap: SoundTapProbe | null;
  /** A meeting recording or a dictation is using audio: don't probe then. */
  audioBusy(): boolean;
  /** Where the last Allow result is kept. */
  access: {
    read(): SystemAudioStatus["access"];
    write(value: SystemAudioStatus["access"]): void;
  };
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export class OnboardingSupport {
  private readonly p: OnboardingPorts;
  private focus: { fieldId: string; since: number } | null = null;
  private watching = false;
  private watchTimer: unknown = null;
  private keyDown = false;
  /** The test took the current press, so its release is the test's too. */
  private consumedDown = false;
  private probing: Promise<SystemAudioStatus> | null = null;

  constructor(ports: OnboardingPorts) {
    this.p = ports;
  }

  private now(): number {
    return (this.p.now ?? Date.now)();
  }

  // ---- Practice fields -------------------------------------------------------------------------

  setPracticeFocus(input: unknown): void {
    const { active, fieldId } = PracticeFocusSchema.parse(input);
    if (active) {
      if (this.focus?.fieldId !== fieldId)
        this.focus = { fieldId, since: this.now() };
    } else if (this.focus?.fieldId === fieldId) this.focus = null;
  }

  /** True when a practice field has had the keyboard, without a break, since `takenAt`. */
  acceptsDictation(takenAt: number): boolean {
    return (
      this.focus !== null && this.focus.since <= takenAt && this.p.hubFocused()
    );
  }

  /** Delivers `text` to the focused practice field; false when it couldn't. */
  insert(text: string, durationMs: number): boolean {
    const focus = this.focus;
    if (!focus) return false;
    return this.p.send("hub:practiceText", {
      fieldId: focus.fieldId,
      text,
      words: countWords(text),
      durationMs: Math.max(0, Math.round(durationMs)),
    });
  }

  // ---- Shortcut test -------------------------------------------------------------------------

  watchShortcut(input: unknown): boolean {
    const { on } = WatchShortcutSchema.parse(input);
    if (on) {
      this.clearWatchTimer();
      this.watching = true;
      this.watchTimer = (this.p.setTimer ?? setTimeout)(
        () => this.watchShortcutOff(),
        WATCH_TTL_MS,
      );
    } else this.watchShortcutOff();
    return this.watching;
  }

  private clearWatchTimer(): void {
    if (this.watchTimer !== null)
      (this.p.clearTimer ?? ((t) => clearTimeout(t as never)))(this.watchTimer);
    this.watchTimer = null;
  }

  private watchShortcutOff(): void {
    this.clearWatchTimer();
    this.watching = false;
    if (this.keyDown) {
      this.keyDown = false;
      this.p.send("hub:shortcutState", { down: false });
    }
  }

  /**
   * The dictation shortcut went down or up. True when the test consumed it: the controller
   * must then not start (or end) a recording. A press the test consumed is also consumed on
   * release, even if the test ended in between; a press the controller got is released to it.
   */
  shortcutEvent(kind: "down" | "up"): boolean {
    if (kind === "down") {
      if (!this.watching) return false;
      this.keyDown = true;
      this.consumedDown = true;
      this.p.send("hub:shortcutState", { down: true });
      return true;
    }
    if (!this.consumedDown) return false;
    this.consumedDown = false;
    if (this.keyDown) {
      this.keyDown = false;
      this.p.send("hub:shortcutState", { down: false });
    }
    return true;
  }

  /** The Hub window reloaded, closed or crashed: nothing it asked for stays on. */
  releaseAll(): void {
    this.focus = null;
    this.watchShortcutOff();
  }

  // ---- Your Mac's sound ------------------------------------------------------------------------

  systemAudioStatus(): SystemAudioStatus {
    const support = this.p.soundTap?.support() ?? "available";
    const access = this.p.access.read();
    return {
      support,
      access,
      message:
        support !== "available"
          ? systemAudioReason(support)
          : access === "denied"
            ? DENIED_MESSAGE
            : null,
    };
  }

  /**
   * Shows macOS's permission prompt for your Mac's sound by starting the sound tap and
   * stopping it again at once. Call it only from the person's click. Nothing is recorded: the
   * tap's audio is never read.
   */
  requestSystemAudio(): Promise<SystemAudioStatus> {
    if (this.probing) return this.probing;
    this.probing = this.probe().finally(() => (this.probing = null));
    return this.probing;
  }

  private async probe(): Promise<SystemAudioStatus> {
    const tap = this.p.soundTap;
    const status = this.systemAudioStatus();
    if (!tap || status.support !== "available") return status;
    if (this.p.audioBusy())
      return {
        ...status,
        message: "Finish the recording that is running, then try again.",
      };
    let timer: unknown;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = (this.p.setTimer ?? setTimeout)(
        () => resolve("timeout"),
        PROBE_TIMEOUT_MS,
      );
    });
    try {
      const result = await Promise.race([
        tap.start().then(() => "started" as const),
        timedOut,
      ]);
      if (result === "timeout")
        return {
          ...this.systemAudioStatus(),
          message: "macOS is still waiting for your answer. Try Allow again.",
        };
      this.p.access.write("allowed");
    } catch {
      this.p.access.write("denied");
    } finally {
      (this.p.clearTimer ?? ((t) => clearTimeout(t as never)))(timer);
      try {
        tap.stop();
      } catch {
        // Already stopped.
      }
    }
    return this.systemAudioStatus();
  }
}

const DENIED_MESSAGE =
  "Murmur can't hear your Mac's sound. Turn it on in System Settings → Privacy & Security → Screen & System Audio Recording, then try again.";

/**
 * Practice dictation (outermost inserter): when a practice field in the Hub has had focus since
 * release, the text goes straight into it. Everything else, including a failed delivery, goes
 * to the next inserter unchanged. Never pastes or posts a key.
 */
export class PracticeAwareInserter implements Inserter {
  private readonly inner: Inserter;
  private readonly practice: Pick<
    OnboardingSupport,
    "acceptsDictation" | "insert"
  >;
  private readonly ownPid: number;
  private readonly secureNow: () => boolean;
  private readonly log: (event: string, data?: Record<string, unknown>) => void;

  constructor(
    inner: Inserter,
    practice: PracticeAwareInserter["practice"],
    log: PracticeAwareInserter["log"],
    secureNow: () => boolean = () => false,
    ownPid = process.pid,
  ) {
    this.inner = inner;
    this.practice = practice;
    this.log = log;
    this.secureNow = secureNow;
    this.ownPid = ownPid;
  }

  async insert(
    text: string,
    target: TargetSnapshot,
    meta?: InsertMeta,
  ): Promise<InsertOutcome> {
    if (
      target.pid !== this.ownPid ||
      target.secure ||
      this.secureNow() ||
      !this.practice.acceptsDictation(target.takenAt)
    )
      return this.inner.insert(text, target, meta);
    const ok = this.practice.insert(text, meta?.durationMs ?? 0);
    this.log("insert.practice", { ok });
    if (ok) return { strategy: "direct" };
    return this.inner.insert(text, target, meta);
  }
}
