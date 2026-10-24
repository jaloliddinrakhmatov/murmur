// Audio capture through a hidden renderer (Chromium owns device access, permission prompts and
// resampling). The renderer streams 16 kHz PCM16 chunks over IPC; this adapter assembles them
// and exposes the AudioPort used by the controller. The renderer opens the selected microphone,
// or the system default when it isn't connected, and says which one it opened.
import { concatPcm16 } from "@murmur/speech";
import { rmsOfPcm16 } from "@murmur/text";
import type { AudioPort, CapturedAudio } from "../core/types.ts";
import { AudioCaptureError } from "../core/types.ts";
import type {
  CoordinatorCommand,
  CoordinatorMessage,
} from "../../renderer/audio/coordinator.ts";

export const SAMPLE_RATE = 16000;

/** Messages from the renderer (see renderer/audio/coordinator.ts). */
export type AudioRendererMessage =
  | CoordinatorMessage
  | { type: "chunk"; samples: ArrayBuffer }
  | {
      type: "level";
      session: number;
      rms: number;
      peak: number;
      muted: boolean;
    };

export interface AudioRendererLink {
  send(command: CoordinatorCommand): void;
  onMessage(cb: (m: AudioRendererMessage) => void): () => void;
}

export interface CaptureOptions {
  /** The selected microphone (null = system default), read at every start. */
  device?: () => string | null;
  /** Which device actually opened, and whether it stood in for a missing selection. */
  onStarted?: (info: {
    deviceId: string | null;
    fallback: boolean;
    timing?: { mediaMs: number; graphMs: number };
  }) => void;
  /** The microphone went away mid-recording (unplugged, or access revoked). */
  onEnded?: () => void;
}

const START_TIMEOUT_MS = 4000;
const STOP_TIMEOUT_MS = 2000;

/**
 * One recording attempt. It owns its chunks and its single listener, so a late timeout, error
 * or stop of an older attempt can never touch a newer one.
 */
interface Session {
  readonly id: number;
  chunks: Int16Array[];
  peakRms: number;
  /** True from the renderer's "started" until stop or cancel. */
  live: boolean;
  /** stop() was called: the last chunks still count, and "stopped" ends the wait. */
  stopping: boolean;
  onStopped: (() => void) | null;
  off: (() => void) | null;
}

export class RendererAudioCapture implements AudioPort {
  private session: Session | null = null;
  private startedAt = 0;
  private startId = 0;
  /** Settles a start that is still waiting for the renderer (see cancel()). */
  private abortStart: (() => void) | null = null;
  private readonly link: AudioRendererLink;
  private readonly onLevel: (rms: number) => void;
  private readonly options: CaptureOptions;

  constructor(
    link: AudioRendererLink,
    onLevel: (rms: number) => void = () => {},
    options: CaptureOptions = {},
  ) {
    this.link = link;
    this.onLevel = onLevel;
    this.options = options;
  }

  /** When the first audio of the current recording arrived (Stage 7 latency diagnostics). */
  firstAudioAt: number | null = null;

  private drop(s: Session): void {
    s.off?.();
    s.off = null;
    if (this.session === s) this.session = null;
  }

  async start(): Promise<void> {
    const id = ++this.startId;
    this.firstAudioAt = null;
    // An earlier start still waiting is over: its timer must not outlive it.
    this.abortStart?.();
    if (this.session) this.drop(this.session);
    const s: Session = {
      id,
      chunks: [],
      peakRms: 0,
      live: false,
      stopping: false,
      onStopped: null,
      off: null,
    };
    this.session = s;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        // The renderer may still open the microphone later: close it, and stop listening.
        if (this.session === s) {
          this.link.send({ type: "cancel" });
          if (!s.stopping) this.drop(s);
        }
        reject(
          new AudioCaptureError(
            "unavailable",
            "audio renderer did not start in time",
          ),
        );
      }, START_TIMEOUT_MS);
      const abort = () => {
        cleanup();
        reject(new AudioCaptureError("cancelled", "cancelled while starting"));
      };
      const cleanup = () => {
        clearTimeout(timer);
        if (this.abortStart === abort) this.abortStart = null;
      };
      this.abortStart = abort;
      s.off = this.link.onMessage((m) => {
        // Only this start's acknowledgement counts; a cancelled earlier start may still report.
        if (m.type === "started" && m.id === id) {
          cleanup();
          this.startedAt = Date.now();
          s.live = true;
          this.options.onStarted?.({
            deviceId: m.deviceId,
            fallback: m.fallback,
            ...(m.timing ? { timing: m.timing } : {}),
          });
          resolve();
        } else if (m.type === "ended") {
          if (s.live) this.options.onEnded?.();
        } else if (m.type === "chunk") {
          if (!s.live && !s.stopping) return;
          const samples = new Int16Array(m.samples);
          this.firstAudioAt ??= Date.now();
          s.chunks.push(samples);
          const rms = rmsOfPcm16(samples);
          s.peakRms = Math.max(s.peakRms, rms);
          if (s.live) this.onLevel(rms);
        } else if (m.type === "stopped") {
          s.onStopped?.();
        } else if (m.type === "error") {
          if (!s.live) {
            cleanup();
            if (!s.stopping) this.drop(s);
            reject(toCaptureError(m.name, m.message));
          }
          s.onStopped?.();
        }
      });
      this.link.send({
        type: "start",
        id,
        deviceId: this.options.device?.() ?? null,
      });
    });
  }

  async stop(): Promise<CapturedAudio> {
    const s = this.session;
    if (!s) {
      this.link.send({ type: "stop" });
      return {
        samples: new Int16Array(0),
        sampleRate: SAMPLE_RATE,
        durationMs: 0,
        peakRms: 0,
      };
    }
    s.live = false;
    s.stopping = true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => done(), STOP_TIMEOUT_MS);
      const done = () => {
        clearTimeout(timer);
        s.onStopped = null;
        resolve();
      };
      s.onStopped = done;
      this.link.send({ type: "stop" });
    });
    // Only this recording's own listener goes; a newer start keeps its own.
    this.drop(s);
    const samples = concatPcm16(s.chunks);
    s.chunks = [];
    return {
      samples,
      sampleRate: SAMPLE_RATE,
      durationMs: Math.round((samples.length / SAMPLE_RATE) * 1000),
      peakRms: s.peakRms,
    };
  }

  async cancel(): Promise<void> {
    // A start still waiting for the microphone must not fail later (after its timeout) and be
    // reported as an error for a dictation the user already cancelled.
    this.abortStart?.();
    const s = this.session;
    if (s) {
      s.live = false;
      s.chunks = [];
      s.onStopped?.();
      this.drop(s);
    }
    this.link.send({ type: "cancel" });
  }

  get elapsedMs(): number {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }
}

/** Whether the audio renderer still holds a live microphone track or AudioContext. */
export function audioRendererStatus(
  link: AudioRendererLink,
  timeoutMs = 3000,
): Promise<{
  open: boolean;
  contexts: number;
  recording: boolean;
  preview: boolean;
}> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error("audio renderer status timed out"));
    }, timeoutMs);
    const off = link.onMessage((m) => {
      if (m.type !== "status") return;
      clearTimeout(timer);
      off();
      resolve({
        open: m.open,
        contexts: m.contexts,
        recording: m.recording,
        preview: m.preview,
      });
    });
    link.send({ type: "status" });
  });
}

export function toCaptureError(
  name: string,
  message: string,
): AudioCaptureError {
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return new AudioCaptureError("permission-denied", message);
    case "NotFoundError":
    case "OverconstrainedError":
      return new AudioCaptureError("no-device", message);
    case "NotReadableError":
    case "AbortError":
      return new AudioCaptureError("device-busy", message);
    default:
      return new AudioCaptureError("unavailable", `${name}: ${message}`);
  }
}
