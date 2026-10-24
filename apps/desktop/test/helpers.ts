// Fakes for the controller tests. The hold-to-talk machine is the real native one (validated in M0).
import { createRequire } from "node:module";
import type {
  TranscriptionProvider,
  TranscribeOptions,
  TranscriptionResult,
} from "@murmur/speech";
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
  InsertOutcome,
  TargetProbe,
  TargetSnapshot,
} from "../src/main/core/types.ts";
import { AudioCaptureError } from "../src/main/core/types.ts";

const require = createRequire(import.meta.url);
const native = require("@murmur/native") as {
  HoldToTalk: new (c?: object) => HoldMachine;
};

export function realHold(): HoldMachine {
  return new native.HoldToTalk({ minHoldMs: 300, doubleTapMs: 400 });
}

/** Manual clock: tests advance time explicitly and timers fire deterministically. */
export class FakeClock implements Clock {
  t = 0;
  private timers: { at: number; fn: () => void; interval?: number }[] = [];
  now() {
    return this.t;
  }
  setInterval(fn: () => void, ms: number) {
    const timer = { at: this.t + ms, fn, interval: ms };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((x) => x !== timer);
    };
  }
  setTimeout(fn: () => void, ms: number) {
    const timer = { at: this.t + ms, fn };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((x) => x !== timer);
    };
  }
  async advance(ms: number) {
    const end = this.t + ms;
    while (true) {
      const due = this.timers
        .filter((x) => x.at <= end)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.t = due.at;
      if (due.interval) due.at += due.interval;
      else this.timers = this.timers.filter((x) => x !== due);
      due.fn();
      await flush();
    }
    this.t = end;
    await flush();
  }
}

export const flush = () => new Promise<void>((r) => setTimeout(r, 0));

export function pcm(
  durationMs: number,
  amplitude = 0.3,
  sampleRate = 16000,
): CapturedAudio {
  const n = Math.round((durationMs / 1000) * sampleRate);
  const samples = new Int16Array(n);
  for (let i = 0; i < n; i++)
    samples[i] = Math.round(Math.sin(i / 7) * amplitude * 32767);
  return { samples, sampleRate, durationMs, peakRms: amplitude / Math.SQRT2 };
}

export class FakeAudio implements AudioPort {
  started = 0;
  stopped = 0;
  cancelled = 0;
  next: CapturedAudio = pcm(1500);
  startError: AudioCaptureError | null = null;
  /** When set, start() waits until the test settles it (a microphone that is slow to open). */
  holdStart = false;
  pending: { resolve: () => void; reject: (e: Error) => void } | null = null;
  async start() {
    if (this.startError) throw this.startError;
    if (this.holdStart)
      await new Promise<void>((resolve, reject) => {
        this.pending = { resolve, reject };
      });
    this.started++;
  }
  async stop() {
    this.stopped++;
    return this.next;
  }
  async cancel() {
    this.cancelled++;
  }
}

export class FakeCapsule implements CapsulePort {
  states: { state: string; message?: string }[] = [];
  show(state: string, message?: string) {
    this.states.push({ state, message });
  }
  get last() {
    return this.states[this.states.length - 1];
  }
}

export class FakeInserter implements Inserter {
  calls: { text: string; target: TargetSnapshot }[] = [];
  outcome: InsertOutcome = { strategy: "clipboard-paste" };
  async insert(text: string, target: TargetSnapshot) {
    this.calls.push({ text, target });
    return this.outcome;
  }
}

export class FakeHistory implements HistoryPort {
  rows = new Map<string, DictationRecord>();
  insert(row: DictationRecord) {
    this.rows.set(row.id, { ...row });
  }
  update(id: string, patch: Partial<DictationRecord>) {
    const row = this.rows.get(id);
    if (row) Object.assign(row, patch);
  }
  get(id: string) {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }
  get only() {
    const all = [...this.rows.values()];
    if (all.length !== 1) throw new Error(`expected 1 row, got ${all.length}`);
    return all[0];
  }
}

export class FakeVault implements AudioVaultPort {
  files = new Map<string, Uint8Array<ArrayBuffer>>();
  async save(id: string, wav: Uint8Array) {
    this.files.set(id, new Uint8Array(wav));
  }
  async load(id: string) {
    return this.files.get(id) ?? null;
  }
  async remove(id: string) {
    this.files.delete(id);
  }
}

export class FakeProvider implements TranscriptionProvider {
  readonly id = "fake";
  readonly kind = "cloud";
  ready: string | null = null;
  text = "um hello world";
  fail: Error | null = null;
  delayMs = 0;
  calls = 0;
  async readiness() {
    return this.ready;
  }
  async transcribe(
    _audio: unknown,
    options: TranscribeOptions,
  ): Promise<TranscriptionResult> {
    this.calls++;
    if (this.fail) throw this.fail;
    if (this.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const h = setTimeout(resolve, this.delayMs);
        options.signal?.addEventListener("abort", () => {
          clearTimeout(h);
          reject(options.signal!.reason);
        });
      });
    }
    return { text: this.text };
  }
}

export class FakeCancelHotkey implements CancelHotkeyPort {
  armed = 0;
  disarmed = 0;
  trigger: (() => void) | null = null;
  arm(onCancel: () => void) {
    this.armed++;
    this.trigger = onCancel;
    return () => {
      this.disarmed++;
      this.trigger = null;
    };
  }
}

export function fakeTarget(
  overrides: Partial<TargetSnapshot> = {},
): TargetProbe {
  return {
    snapshot: () => ({
      appBundleId: "com.apple.TextEdit",
      appName: "TextEdit",
      pid: 1,
      secure: false,
      takenAt: 0,
      ...overrides,
    }),
  };
}
