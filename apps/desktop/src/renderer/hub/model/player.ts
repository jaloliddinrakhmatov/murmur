// One recording plays at a time (History's Play buttons). Pure logic with an injected engine so
// it can be unit-tested; `playback.ts` supplies the real one (Blob URL + HTMLAudioElement).
// Recordings are never played while a microphone is open, or the speakers would be transcribed.

export type PlayerPhase = "idle" | "loading" | "playing" | "paused";

export interface PlayerState {
  /** The dictation that owns the player, or null. */
  id: string | null;
  phase: PlayerPhase;
  positionMs: number;
  durationMs: number;
}

export interface PlaybackHooks {
  time(positionMs: number, durationMs: number): void;
  ended(): void;
  failed(): void;
}

export interface PlaybackEngine {
  play(): Promise<void>;
  pause(): void;
  /** Releases the Blob URL and drops the bytes. Safe to call twice. */
  dispose(): void;
}

export interface PlayerDeps {
  load(id: string): Promise<ArrayBuffer>;
  createEngine(bytes: ArrayBuffer, hooks: PlaybackHooks): PlaybackEngine;
  /** A playback problem to tell the person about (the usual toast, set by the screen). */
  onError(message: string): void;
}

export const NOT_WHILE_RECORDING = "Not while recording";

const IDLE: PlayerState = {
  id: null,
  phase: "idle",
  positionMs: 0,
  durationMs: 0,
};

export class RecordingPlayer {
  private readonly deps: PlayerDeps;
  private state: PlayerState = IDLE;
  private engine: PlaybackEngine | null = null;
  private micOpen = false;
  /** Increments for every start/stop, so a late load or event of an older playback is ignored. */
  private run = 0;
  private readonly listeners = new Set<() => void>();

  constructor(deps: PlayerDeps) {
    this.deps = deps;
  }

  getState = (): PlayerState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get recordingOpen(): boolean {
    return this.micOpen;
  }

  /** A dictation or meeting recording opened or closed the microphone. */
  setMicOpen(open: boolean): void {
    if (open === this.micOpen) return;
    this.micOpen = open;
    if (open) this.stop();
    this.emit();
  }

  /** Play, pause or resume `id`; starting it stops whatever else was playing. */
  async toggle(id: string): Promise<void> {
    if (this.micOpen) {
      this.deps.onError(NOT_WHILE_RECORDING);
      return;
    }
    if (this.state.id === id && this.engine) {
      if (this.state.phase === "playing") {
        this.engine.pause();
        this.set({ phase: "paused" });
        return;
      }
      if (this.state.phase === "paused") {
        await this.resume(this.run);
        return;
      }
    }
    if (this.state.id === id && this.state.phase === "loading") return;
    this.stop();
    const run = ++this.run;
    this.state = { ...IDLE, id, phase: "loading" };
    this.emit();
    let bytes: ArrayBuffer;
    try {
      bytes = await this.deps.load(id);
    } catch (e) {
      if (run !== this.run) return;
      this.fail(e instanceof Error ? e.message : String(e));
      return;
    }
    if (run !== this.run || this.micOpen) return;
    this.engine = this.deps.createEngine(bytes, {
      time: (positionMs, durationMs) => {
        if (run === this.run) this.set({ positionMs, durationMs });
      },
      ended: () => {
        if (run === this.run) this.stop();
      },
      failed: () => {
        if (run === this.run) this.fail("The recording couldn't be played.");
      },
    });
    await this.resume(run);
  }

  /** Stops and releases everything (playback ended, another recording opened, screen left). */
  stop(): void {
    this.run++;
    this.engine?.dispose();
    this.engine = null;
    if (this.state !== IDLE) {
      this.state = IDLE;
      this.emit();
    }
  }

  /** The owner of `id` went away (row or sheet unmounted): stop only if it is the one playing. */
  release(id: string): void {
    if (this.state.id === id) this.stop();
  }

  private async resume(run: number): Promise<void> {
    try {
      await this.engine?.play();
    } catch (e) {
      if (run === this.run)
        this.fail(
          e instanceof Error && e.message
            ? e.message
            : "The recording couldn't be played.",
        );
      return;
    }
    if (run === this.run) this.set({ phase: "playing" });
  }

  private fail(message: string): void {
    this.stop();
    this.deps.onError(message);
  }

  private set(patch: Partial<PlayerState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

/** "0:07", "1:05" (whole seconds, rounded down). */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
