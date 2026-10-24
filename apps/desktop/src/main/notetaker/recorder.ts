// Meeting recording (Stage 9D-2). Records only after the person starts it, for one meeting at a
// time: the microphone (through the audio renderer, the only place it opens) and, when allowed,
// what this Mac plays (a Core Audio process tap). Both arrive as 16 kHz mono PCM16 and are mixed
// into one track, or (Stage 9D-3, for You / Others labels) kept as two tracks, written as
// encrypted 30-second parts so a crash loses at most the last part.
// Pausing closes the microphone and the tap; nothing is captured while paused. The recording
// stops by itself at the chosen maximum length, after a warning a minute before.
import { rmsOfPcm16 } from "@murmur/text";
import {
  IDLE_RECORDING,
  systemAudioReason,
  type AudioLayout,
  type Meeting,
  type RecordingState,
  type SystemAudioState,
} from "../../shared/meetings.ts";

export const SAMPLE_RATE = 16_000;
/** One encrypted part: 30 s of audio. */
export const PART_SAMPLES = 30 * SAMPLE_RATE;
const TICK_MS = 250;
const WARN_BEFORE_MS = 60_000;
/** A source more than this far behind the other has stalled; its gap is filled with silence. */
const MAX_LAG = SAMPLE_RATE;

/** The microphone, through the audio renderer. */
export interface MeetingMic {
  start(onChunk: (pcm: Int16Array) => void, onEnded: () => void): Promise<void>;
  stop(): Promise<void>;
}

/** What this Mac plays (the native process tap). */
export interface SystemAudio {
  /** "available", "unsupported-os" or "missing-usage-description". Asks macOS nothing. */
  support(): string;
  /** Resolves once capturing (the first time, after macOS's permission prompt is answered);
   * rejects with a message the person can read. */
  start(): Promise<void>;
  /** PCM16 collected since the last call. */
  read(): Int16Array;
  stop(): void;
  /** "output-changed" once capture can no longer be trusted (the Mac's output device changed). */
  lostReason?(): string | null;
  /** Blocks of sound dropped so far in this capture (diagnostics; a count only). */
  droppedBlocks?(): number;
}

/** "mixed": one track; "mic" / "system": the two tracks of a split recording. */
export type Track = "mixed" | "mic" | "system";

export interface AudioParts {
  save(
    meetingId: string,
    index: number,
    pcm: Int16Array,
    track?: Track,
  ): Promise<void>;
}

export interface RecorderMeetings {
  get(id: string): Meeting | null;
  beginRecording(
    id: string,
    startedAt: number,
    systemAudio: boolean,
    now?: number,
    layout?: AudioLayout,
  ): boolean;
  recordingProgress(id: string, recordedMs: number, audioParts: number): void;
  finishRecording(
    id: string,
    r: {
      endedAt: number;
      recordedMs: number;
      audioParts: number;
      status: "processing" | "failed";
      error: string | null;
    },
  ): void;
  setStatus(id: string, status: "notes", error: null): void;
}

export interface RecorderClock {
  now(): number;
  every(ms: number, fn: () => void): () => void;
}

export interface RecorderDeps {
  mic: MeetingMic;
  system: SystemAudio;
  parts: AudioParts;
  meetings: RecorderMeetings;
  options: () => {
    systemAudio: boolean;
    maxMinutes: number;
    speakerLabels: boolean;
  };
  /** Why recording can't start now (a dictation in progress), or null. */
  blocked: () => string | null;
  onState: (s: RecordingState) => void;
  /** The recording ended with audio saved: transcribe it. */
  onRecorded: (meetingId: string) => void;
  log: (event: string, data?: Record<string, unknown>) => void;
  clock: RecorderClock;
}

/** A FIFO of PCM chunks. */
class PcmQueue {
  private chunks: Int16Array[] = [];
  length = 0;

  push(a: Int16Array): void {
    if (!a.length) return;
    this.chunks.push(a);
    this.length += a.length;
  }

  /** The next `n` samples, padded with silence when fewer are queued. */
  take(n: number): Int16Array {
    const out = new Int16Array(n);
    let o = 0;
    while (o < n && this.chunks.length) {
      const c = this.chunks[0];
      const k = Math.min(c.length, n - o);
      out.set(c.subarray(0, k), o);
      o += k;
      if (k === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(k);
    }
    this.length = Math.max(0, this.length - n);
    return out;
  }

  clear(): void {
    this.chunks = [];
    this.length = 0;
  }
}

/** Sums two tracks sample by sample, clipped to PCM16. */
export function mixPcm(a: Int16Array, b: Int16Array): Int16Array {
  const out = new Int16Array(Math.max(a.length, b.length));
  for (let i = 0; i < out.length; i++) {
    const v = (a[i] ?? 0) + (b[i] ?? 0);
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return out;
}

export class MeetingRecorder {
  private readonly d: RecorderDeps;
  private meetingId: string | null = null;
  private phase: RecordingState["phase"] = "idle";
  private systemAudio: SystemAudioState = { state: "off" };
  /** Whether system audio is captured in this recording (resumes with it after a pause). */
  private withSystem = false;
  private systemLive = false;
  private micLive = false;
  private readonly mic = new PcmQueue();
  private readonly sys = new PcmQueue();
  private readonly pending = new PcmQueue();
  /** The Mac's-sound track of a split recording (`pending` then holds the microphone). */
  private readonly pendingSystem = new PcmQueue();
  private layout: AudioLayout = "mixed";
  private recordedSamples = 0;
  private partIndex = 0;
  private savedParts = 0;
  private saving: Promise<void> = Promise.resolve();
  private saveError: string | null = null;
  private maxMs = 0;
  private warned = false;
  private warning: string | null = null;
  private micLevel = 0;
  private systemLevel = 0;
  private stopTicking: (() => void) | null = null;
  /** What each source delivered in this recording (levels only, for the log). */
  private stats = {
    micSamples: 0,
    micPeak: 0,
    systemSamples: 0,
    systemPeak: 0,
    systemDroppedBlocks: 0,
  };
  /** The microphone is closing after a pause or stop: audio still on its way is kept. */
  private micClosing = false;

  constructor(deps: RecorderDeps) {
    this.d = deps;
  }

  get state(): RecordingState {
    if (!this.meetingId) return IDLE_RECORDING;
    return {
      meetingId: this.meetingId,
      phase: this.phase,
      elapsedMs: this.elapsedMs,
      maxMs: this.maxMs,
      systemAudio: this.systemAudio,
      micLevel: this.phase === "recording" ? this.micLevel : 0,
      systemLevel: this.phase === "recording" ? this.systemLevel : 0,
      warning: this.warning,
    };
  }

  get active(): boolean {
    return this.phase !== "idle";
  }

  private get elapsedMs(): number {
    return Math.round((this.recordedSamples / SAMPLE_RATE) * 1000);
  }

  private emit(): void {
    this.d.onState(this.state);
  }

  /** Starts recording a meeting that has never been recorded. Only on the person's request. */
  async start(meetingId: string): Promise<void> {
    if (this.phase !== "idle")
      throw new Error("A meeting is already being recorded.");
    const blocked = this.d.blocked();
    if (blocked) throw new Error(blocked);
    const m = this.d.meetings.get(meetingId);
    if (!m) throw new Error("This meeting no longer exists.");
    if (m.status !== "notes")
      throw new Error(
        "This meeting already has a recording. Start a new meeting note to record another.",
      );

    const opts = this.d.options();
    this.reset(meetingId);
    this.maxMs = opts.maxMinutes * 60_000;
    this.phase = "starting";
    this.withSystem = opts.systemAudio;
    this.emit();
    try {
      await this.openSources();
    } catch (err) {
      await this.closeSources();
      this.reset(null);
      this.emit();
      throw err;
    }
    // Two tracks only when there is a second one to label.
    this.layout = opts.speakerLabels && this.systemLive ? "split" : "mixed";
    if (
      !this.d.meetings.beginRecording(
        meetingId,
        this.d.clock.now(),
        this.systemLive,
        this.d.clock.now(),
        this.layout,
      )
    ) {
      await this.closeSources();
      this.reset(null);
      this.emit();
      throw new Error("This meeting already has a recording.");
    }
    this.phase = "recording";
    this.stopTicking = this.d.clock.every(TICK_MS, () => this.tick());
    this.d.log("meeting.recording.started", {
      id: meetingId,
      systemAudio: this.systemAudio.state,
      layout: this.layout,
      maxMinutes: opts.maxMinutes,
    });
    this.emit();
  }

  async pause(): Promise<void> {
    if (this.phase !== "recording") return;
    this.phase = "paused";
    if (this.systemLive) this.sys.push(this.d.system.read());
    // The microphone's last chunks arrive while it closes; they belong before the pause.
    await this.closeSources();
    this.drain(true);
    this.d.log("meeting.recording.paused", { id: this.meetingId });
    this.emit();
  }

  async resume(): Promise<void> {
    if (this.phase !== "paused") return;
    const blocked = this.d.blocked();
    if (blocked) throw new Error(blocked);
    this.phase = "starting";
    this.emit();
    try {
      await this.openSources();
    } catch (err) {
      await this.closeSources();
      this.phase = "paused";
      this.emit();
      throw err;
    }
    this.phase = "recording";
    this.d.log("meeting.recording.resumed", { id: this.meetingId });
    this.emit();
  }

  /**
   * Stops and keeps what was recorded. With audio saved the meeting goes on to transcription;
   * with none (stopped at once), it returns to an unrecorded meeting.
   */
  async stop(reason: "user" | "limit" | "mic-lost" = "user"): Promise<void> {
    if (this.phase !== "recording" && this.phase !== "paused") return;
    const id = this.meetingId!;
    this.phase = "stopping";
    this.emit();
    this.stopTicking?.();
    this.stopTicking = null;
    let transcribe = false;
    try {
      if (this.systemLive) this.sys.push(this.d.system.read());
      await this.closeSources();
      this.drain(true);
      this.flush();
      await this.saving;
      const recordedMs = this.elapsedMs;
      if (this.saveError)
        this.d.meetings.finishRecording(id, {
          endedAt: this.d.clock.now(),
          recordedMs,
          audioParts: this.savedParts,
          status: "failed",
          error: this.saveError,
        });
      else if (this.savedParts === 0) {
        this.d.meetings.setStatus(id, "notes", null);
        this.d.meetings.recordingProgress(id, 0, 0);
      } else
        this.d.meetings.finishRecording(id, {
          endedAt: this.d.clock.now(),
          recordedMs,
          audioParts: this.savedParts,
          status: "processing",
          error: null,
        });
      this.d.log("meeting.recording.stopped", {
        id,
        reason,
        recordedMs,
        parts: this.savedParts,
        saveFailed: Boolean(this.saveError),
        micMs: Math.round((this.stats.micSamples / SAMPLE_RATE) * 1000),
        micPeak: Math.round(this.stats.micPeak * 1e4) / 1e4,
        systemMs: Math.round((this.stats.systemSamples / SAMPLE_RATE) * 1000),
        systemPeak: Math.round(this.stats.systemPeak * 1e4) / 1e4,
        systemDroppedBlocks: this.stats.systemDroppedBlocks,
      });
      transcribe = !this.saveError && this.savedParts > 0;
    } catch (err) {
      // The meeting stays "recording" until the next start-up recovers it; dictation isn't blocked.
      this.d.log("meeting.recording.stop.failed", {
        id,
        error: (err as Error).name,
      });
    } finally {
      this.reset(null);
      this.emit();
    }
    if (transcribe) this.d.onRecorded(id);
  }

  private reset(meetingId: string | null): void {
    this.meetingId = meetingId;
    this.phase = "idle";
    this.systemAudio = { state: "off" };
    this.withSystem = false;
    this.mic.clear();
    this.sys.clear();
    this.pending.clear();
    this.pendingSystem.clear();
    this.layout = "mixed";
    this.recordedSamples = 0;
    this.partIndex = 0;
    this.savedParts = 0;
    this.saving = Promise.resolve();
    this.saveError = null;
    this.maxMs = 0;
    this.warned = false;
    this.warning = null;
    this.micLevel = 0;
    this.systemLevel = 0;
    this.stats = {
      micSamples: 0,
      micPeak: 0,
      systemSamples: 0,
      systemPeak: 0,
      systemDroppedBlocks: 0,
    };
    this.micClosing = false;
  }

  private async openSources(): Promise<void> {
    this.systemLive = false;
    if (this.withSystem) {
      const support = this.d.system.support();
      if (support !== "available")
        this.systemAudio = {
          state: "unavailable",
          reason: systemAudioReason(support),
        };
      else
        try {
          await this.d.system.start();
          this.systemLive = true;
          this.systemAudio = { state: "on" };
        } catch (err) {
          this.systemAudio = {
            state: "unavailable",
            reason: (err as Error).message,
          };
        }
    } else this.systemAudio = { state: "off" };
    await this.d.mic.start(
      (pcm) => this.onMic(pcm),
      () => void this.stop("mic-lost"),
    );
    this.micLive = true;
  }

  private async closeSources(): Promise<void> {
    this.stopSystem();
    if (this.micLive) {
      this.micLive = false;
      this.micClosing = true;
      try {
        await this.d.mic.stop();
      } finally {
        this.micClosing = false;
      }
    }
  }

  private stopSystem(): void {
    if (!this.systemLive) return;
    this.stats.systemDroppedBlocks += this.d.system.droppedBlocks?.() ?? 0;
    this.d.system.stop();
    this.systemLive = false;
  }

  private onMic(pcm: Int16Array): void {
    if (
      this.phase !== "recording" &&
      this.phase !== "stopping" &&
      !this.micClosing
    )
      return;
    this.mic.push(pcm);
    this.micLevel = rmsOfPcm16(pcm);
    this.stats.micSamples += pcm.length;
    this.stats.micPeak = Math.max(this.stats.micPeak, this.micLevel);
  }

  private tick(): void {
    if (this.phase !== "recording") return;
    if (this.systemLive) {
      const s = this.d.system.read();
      this.sys.push(s);
      this.systemLevel = s.length ? rmsOfPcm16(s) : 0;
      this.stats.systemSamples += s.length;
      this.stats.systemPeak = Math.max(this.stats.systemPeak, this.systemLevel);
      this.checkSystemLost();
    }
    this.drain(false);
    if (this.pending.length >= PART_SAMPLES) this.flush();
    const elapsed = this.elapsedMs;
    if (!this.warned && elapsed >= this.maxMs - WARN_BEFORE_MS) {
      this.warned = true;
      this.warning = "Stopping in 1 minute (recording limit)";
    }
    this.emit();
    if (elapsed >= this.maxMs) void this.stop("limit");
  }

  /**
   * The Mac's sound stopped being captured (its output device changed). The microphone keeps
   * recording; the panel says why the other side is no longer heard.
   */
  private checkSystemLost(): void {
    const lost = this.d.system.lostReason?.() ?? null;
    if (!lost) return;
    this.stopSystem();
    this.systemAudio = {
      state: "unavailable",
      reason: "Your Mac's sound stopped: the output device changed",
    };
    this.systemLevel = 0;
    this.d.log("meeting.system-audio.lost", {
      id: this.meetingId,
      reason: lost,
      droppedBlocks: this.stats.systemDroppedBlocks,
    });
  }

  /** Moves aligned audio from the sources into the recording. */
  private drain(final: boolean): void {
    let n: number;
    if (!this.systemLive && !this.sys.length) n = this.mic.length;
    else {
      const hi = Math.max(this.mic.length, this.sys.length);
      const lo = Math.min(this.mic.length, this.sys.length);
      n = final ? hi : hi - lo > MAX_LAG ? hi - MAX_LAG : lo;
    }
    // Never past the maximum length (the rest is dropped as the recording stops).
    if (this.maxMs)
      n = Math.min(
        n,
        Math.max(0, (this.maxMs * SAMPLE_RATE) / 1000 - this.recordedSamples),
      );
    if (n <= 0) return;
    const mic = this.mic.take(n);
    const sys = this.sys.take(n);
    if (this.layout === "split") {
      this.pending.push(mic);
      this.pendingSystem.push(sys);
    } else this.pending.push(mixPcm(mic, sys));
    this.recordedSamples += n;
  }

  /** Writes what's pending as the next encrypted part (in order, one at a time). */
  private flush(): void {
    if (!this.pending.length || !this.meetingId) return;
    const id = this.meetingId;
    const pcm = this.pending.take(this.pending.length);
    const split = this.layout === "split";
    const system = split ? this.pendingSystem.take(pcm.length) : null;
    const index = this.partIndex++;
    const recordedMs = this.elapsedMs;
    this.saving = this.saving.then(async () => {
      if (this.saveError) return;
      try {
        if (system) {
          await this.d.parts.save(id, index, pcm, "mic");
          await this.d.parts.save(id, index, system, "system");
        } else await this.d.parts.save(id, index, pcm);
        this.savedParts = index + 1;
        this.d.meetings.recordingProgress(id, recordedMs, this.savedParts);
      } catch (err) {
        this.saveError = `The recording couldn't be saved: ${(err as Error).message}`;
        this.d.log("meeting.recording.save.failed", {
          id,
          part: index,
          error: (err as Error).name,
        });
        void this.stop("user");
      }
    });
  }
}
