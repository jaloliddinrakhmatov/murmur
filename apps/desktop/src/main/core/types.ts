// Ports the DictationController depends on. Electron- and native-backed implementations live in
// ../native, ../audio and ../windows; tests supply fakes. Nothing in core imports electron.
import type { CapsuleState } from "../../shared/ipc.ts";

export interface HoldMachine {
  handle(
    kind: "down" | "up" | "other" | "cancel" | "tick",
    tMs: number,
  ): string[];
  readonly state: string;
}

export interface CapturedAudio {
  samples: Int16Array;
  sampleRate: number;
  durationMs: number;
  /** Peak RMS over 100 ms windows, 0..1. Used to detect silence. */
  peakRms: number;
}

export class AudioCaptureError extends Error {
  readonly code:
    | "permission-denied"
    | "no-device"
    | "device-busy"
    | "unavailable"
    /** The recording was cancelled before the microphone finished opening. */
    | "cancelled";
  constructor(code: AudioCaptureError["code"], message: string) {
    super(message);
    this.name = "AudioCaptureError";
    this.code = code;
  }
}

export interface AudioPort {
  /** When the current recording's first audio arrived, if the adapter knows (diagnostics). */
  readonly firstAudioAt?: number | null;
  start(): Promise<void>;
  stop(): Promise<CapturedAudio>;
  cancel(): Promise<void>;
}

export interface TargetSnapshot {
  appBundleId: string | null;
  appName: string | null;
  pid: number | null;
  secure: boolean;
  takenAt: number;
}

export interface TargetProbe {
  snapshot(): TargetSnapshot;
}

/** "direct": typed into Murmur's own Scratchpad editor, without the clipboard (Stage 9B). */
export type InsertStrategy =
  "clipboard-paste" | "direct" | "clipboard-only" | "rejected";

export interface InsertOutcome {
  strategy: InsertStrategy;
  /** Why the text was not pasted (rejected / clipboard-only). */
  reason?: string;
}

/** What the controller knows about the dictation being inserted. */
export interface InsertMeta {
  /** Recording length. */
  durationMs: number;
}

export interface Inserter {
  insert(
    text: string,
    target: TargetSnapshot,
    meta?: InsertMeta,
  ): Promise<InsertOutcome>;
}

export interface CapsulePort {
  show(state: CapsuleState, message?: string): void;
}

export interface CancelHotkeyPort {
  /** Registers Esc as a global cancel while recording; returns an unregister function. */
  arm(onCancel: () => void): () => void;
}

export interface DictationRecord {
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
  provider: string | null;
  hasAudio: boolean;
  /** M2: which cleanup produced finalText, and why an AI result was rejected (if it was). */
  cleanupUsed?: "off" | "deterministic" | "ai" | null;
  cleanupNote?: string | null;
  aiRejectedText?: string | null;
}

export interface DictionaryRecord {
  id: string;
  phrase: string;
  misheardAs: string | null;
  enabled: boolean;
  usageCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface SnippetRecord {
  id: string;
  trigger: string;
  replacement: string;
  enabled: boolean;
  usageCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface HistoryPort {
  insert(row: DictationRecord): void;
  update(id: string, patch: Partial<DictationRecord>): void;
  get(id: string): DictationRecord | null;
}

export interface AudioVaultPort {
  save(id: string, wav: Uint8Array): Promise<void>;
  load(id: string): Promise<Uint8Array<ArrayBuffer> | null>;
  remove(id: string): Promise<void>;
}

export interface Clock {
  now(): number;
  setInterval(fn: () => void, ms: number): () => void;
  setTimeout(fn: () => void, ms: number): () => void;
}

export const realClock: Clock = {
  now: () => performance.now(),
  setInterval: (fn, ms) => {
    const h = setInterval(fn, ms);
    return () => clearInterval(h);
  },
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms);
    return () => clearTimeout(h);
  },
};
