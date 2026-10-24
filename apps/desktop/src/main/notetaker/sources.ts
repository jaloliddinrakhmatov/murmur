// Adapters for the meeting recorder (Stage 9D-2): the microphone through the audio renderer (the
// only place it opens; the same commands dictation uses, with their own start ids), the native
// system-audio tap, and encrypted audio parts in their own vault folder, apart from dictation
// recordings so clearing History never touches a meeting waiting to be transcribed.
import { decodeWav, encodeWav } from "@murmur/speech";
import type { AudioRendererLink } from "../audio/capture.ts";
import { toCaptureError } from "../audio/capture.ts";
import { AudioCaptureError } from "../core/types.ts";
import type { AudioVault } from "../history/vault.ts";
import type { AudioParts, MeetingMic, SystemAudio, Track } from "./recorder.ts";
import { SAMPLE_RATE } from "./recorder.ts";

const START_TIMEOUT_MS = 4000;

/** What a microphone failure means for a meeting recording, for the person. */
const MIC_MESSAGES: Record<AudioCaptureError["code"], string> = {
  "permission-denied":
    "Microphone access is off. Turn Murmur on in System Settings → Privacy & Security → Microphone.",
  "no-device": "No microphone is connected.",
  "device-busy": "The microphone is in use by another app.",
  unavailable: "The microphone didn't start. Try again.",
  cancelled: "The recording was cancelled.",
};
const STOP_TIMEOUT_MS = 2000;

/**
 * One microphone start. It owns its listener, timer and pending promise, so a late timeout,
 * error or stop of an older start can never unsubscribe, cancel or end a newer one.
 */
interface MicSession {
  readonly id: number;
  started: boolean;
  stopping: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** Rejects the start promise while it is still waiting for the renderer. */
  fail: ((e: Error) => void) | null;
  onStopped: (() => void) | null;
  off: (() => void) | null;
}

export class RendererMeetingMic implements MeetingMic {
  private readonly link: AudioRendererLink;
  private readonly device: () => string | null;
  private session: MicSession | null = null;
  /** Start ids apart from dictation's, so neither acknowledges the other's start. */
  private nextId = 1_000_000;

  constructor(link: AudioRendererLink, device: () => string | null) {
    this.link = link;
    this.device = device;
  }

  /** Ends a session's listener and timer; a start still waiting settles as cancelled. */
  private drop(s: MicSession, reason?: Error): void {
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    s.off?.();
    s.off = null;
    const fail = s.fail;
    s.fail = null;
    if (this.session === s) this.session = null;
    // A stop still waiting for the renderer has nothing left to wait for.
    const stopped = s.onStopped;
    s.onStopped = null;
    stopped?.();
    fail?.(
      reason ?? new AudioCaptureError("cancelled", MIC_MESSAGES.cancelled),
    );
  }

  start(
    onChunk: (pcm: Int16Array) => void,
    onEnded: () => void,
  ): Promise<void> {
    if (this.session) this.drop(this.session);
    const s: MicSession = {
      id: ++this.nextId,
      started: false,
      stopping: null,
      timer: null,
      fail: null,
      onStopped: null,
      off: null,
    };
    this.session = s;
    return new Promise<void>((resolve, reject) => {
      s.fail = reject;
      s.timer = setTimeout(() => {
        s.timer = null;
        // The renderer may still open the microphone later: close it, and stop listening.
        if (this.session === s) this.link.send({ type: "cancel" });
        this.drop(
          s,
          new AudioCaptureError("unavailable", MIC_MESSAGES.unavailable),
        );
      }, START_TIMEOUT_MS);
      s.off = this.link.onMessage((m) => {
        if (m.type === "started" && m.id === s.id) {
          if (s.timer) clearTimeout(s.timer);
          s.timer = null;
          s.fail = null;
          s.started = true;
          resolve();
        } else if (m.type === "chunk") {
          if (s.started) onChunk(new Int16Array(m.samples));
        } else if (m.type === "ended") {
          if (s.started && !s.stopping) onEnded();
        } else if (m.type === "stopped") {
          s.onStopped?.();
        } else if (m.type === "error") {
          if (!s.started) {
            const err = toCaptureError(m.name, m.message);
            this.drop(
              s,
              new AudioCaptureError(err.code, MIC_MESSAGES[err.code]),
            );
          }
          s.onStopped?.();
        }
      });
      this.link.send({ type: "start", id: s.id, deviceId: this.device() });
    });
  }

  /** Stops; chunks still on their way arrive before this resolves. */
  stop(): Promise<void> {
    const s = this.session;
    if (!s) return Promise.resolve();
    if (s.stopping) return s.stopping;
    if (!s.started) {
      // Still waiting for the microphone to open: cancel that start.
      this.link.send({ type: "cancel" });
      this.drop(s);
      return Promise.resolve();
    }
    s.stopping = new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        s.onStopped = null;
        this.drop(s);
        resolve();
      };
      const timer = setTimeout(done, STOP_TIMEOUT_MS);
      s.onStopped = done;
      this.link.send({ type: "stop" });
    });
    return s.stopping;
  }
}

/** The part of the native addon the system-audio adapter needs. */
export interface NativeSystemAudio {
  systemAudioSupport(): string;
  SystemAudioTap: new () => {
    start(): Promise<void>;
    read(): Buffer;
    stop(): void;
    readonly lostReason?: string | null;
    readonly droppedBlocks?: number;
  };
}

export class NativeSystemAudioSource implements SystemAudio {
  private readonly native: NativeSystemAudio;
  private tap: InstanceType<NativeSystemAudio["SystemAudioTap"]> | null = null;

  constructor(native: NativeSystemAudio) {
    this.native = native;
  }

  support(): string {
    return this.native.systemAudioSupport();
  }

  async start(): Promise<void> {
    this.tap?.stop();
    const tap = new this.native.SystemAudioTap();
    this.tap = tap;
    try {
      await tap.start();
    } catch (err) {
      if (this.tap === tap) this.tap = null;
      throw err;
    }
    // Stopped while macOS was still asking: release what just started.
    if (this.tap !== tap) tap.stop();
  }

  read(): Int16Array {
    if (!this.tap) return new Int16Array(0);
    const b = this.tap.read();
    // Copy into an aligned buffer: Node buffers can start at any byte offset.
    const out = new Int16Array(b.length >> 1);
    new Uint8Array(out.buffer).set(b.subarray(0, out.length * 2));
    return out;
  }

  lostReason(): string | null {
    return this.tap?.lostReason ?? null;
  }

  droppedBlocks(): number {
    return this.tap?.droppedBlocks ?? 0;
  }

  stop(): void {
    this.tap?.stop();
    this.tap = null;
  }
}

/**
 * Encrypted parts in the meeting vault: `<meeting id>_<n>` (one mixed track), or
 * `<meeting id>_<n>_mic` and `<meeting id>_<n>_system` (a split recording).
 */
export class VaultAudioParts implements AudioParts {
  private readonly vault: AudioVault;

  constructor(vault: AudioVault) {
    this.vault = vault;
  }

  private static key(meetingId: string, index: number, track: Track): string {
    return track === "mixed"
      ? `${meetingId}_${index}`
      : `${meetingId}_${index}_${track}`;
  }

  save(
    meetingId: string,
    index: number,
    pcm: Int16Array,
    track: Track = "mixed",
  ): Promise<void> {
    return this.vault.save(
      VaultAudioParts.key(meetingId, index, track),
      encodeWav(pcm, SAMPLE_RATE),
    );
  }

  async load(
    meetingId: string,
    index: number,
    track: Track = "mixed",
  ): Promise<Int16Array | null> {
    const wav = await this.vault.load(
      VaultAudioParts.key(meetingId, index, track),
    );
    return wav ? decodeWav(wav).samples : null;
  }

  async removeMeeting(meetingId: string, parts: number): Promise<void> {
    for (let i = 0; i < parts; i++)
      for (const track of ["mixed", "mic", "system"] as const)
        await this.vault.remove(VaultAudioParts.key(meetingId, i, track));
  }

  clearAll(): Promise<void> {
    return this.vault.clearAll();
  }

  archiveAll(folder: string): Promise<number> {
    return this.vault.archiveAll(folder);
  }
}
