/**
 * Owns the microphone inside the audio renderer: a recording, a level preview (Settings →
 * Microphone) and the device list. The rules:
 *
 * - At most one open stream. A recording always wins: starting one closes the preview, which
 *   resumes shortly after the recording ends if Settings still wants it.
 * - Commands run one at a time in arrival order (`serial`). A start already cancelled before its
 *   turn is skipped, so rapid press-and-cancel never opens the microphone late.
 * - The device is chosen when it is opened: the selected one if connected, otherwise the system
 *   default, and the reply says which device actually opened and whether that was a fallback.
 *
 * Browser APIs stay behind `MicPort`, so this file runs under Node's test runner.
 */
import {
  chooseInput,
  normalizeDevices,
  type RawInputDevice,
} from "../../shared/microphones.ts";
import { serial } from "./queue.ts";

export interface OpenMic {
  /** As the track reports it ("default" when opened without a device id). */
  deviceId: string;
  groupId: string;
  close(): Promise<void>;
  onEnded(cb: () => void): void;
  /** How long opening took: the device (getUserMedia) and the audio graph, in ms. */
  timing?: { mediaMs: number; graphMs: number };
}

export interface MicPort {
  list(): Promise<RawInputDevice[]>;
  /** Opens a stream; "record" streams PCM chunks, "preview" only level readings for `session`. */
  open(
    deviceId: string | null,
    mode: { kind: "record" } | { kind: "preview"; session: number },
  ): Promise<OpenMic>;
  /** AudioContexts created and not yet closed. */
  liveContexts(): number;
}

export type CoordinatorCommand =
  | { type: "start"; id: number; deviceId?: string | null }
  | { type: "stop" }
  | { type: "cancel" }
  | { type: "status" }
  | { type: "devices" }
  | { type: "preview"; session: number; deviceId?: string | null }
  | { type: "previewStop"; session: number };

export type CoordinatorMessage =
  | {
      type: "started";
      id: number;
      deviceId: string | null;
      fallback: boolean;
      timing?: { mediaMs: number; graphMs: number };
    }
  | { type: "stopped" }
  | { type: "ended" }
  | { type: "error"; name: string; message: string }
  | {
      type: "status";
      open: boolean;
      contexts: number;
      recording: boolean;
      preview: boolean;
    }
  | { type: "devices"; devices: RawInputDevice[] }
  | {
      type: "preview";
      session: number;
      state: "live" | "paused" | "stopped" | "ended" | "error";
      deviceId?: string | null;
      fallback?: boolean;
      error?: { name: string; message: string };
    };

/** Delay before a preview reopens after a recording, so a quick next dictation supersedes it. */
export const PREVIEW_RESUME_MS = 300;

const MISSING_DEVICE = new Set(["OverconstrainedError", "NotFoundError"]);

export class MicCoordinator {
  private rec: OpenMic | null = null;
  private pre: { mic: OpenMic; session: number } | null = null;
  private wanted: { session: number; deviceId: string | null } | null = null;
  private generation = 0;
  /**
   * The device list as last reported (at launch and after every device change). Opening uses it
   * instead of listing again: the first listing after launch alone cost ~250 ms (Stage 7
   * measurement). A device unplugged since then fails to open and falls back as usual.
   */
  private cache: RawInputDevice[] | null = null;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly port: MicPort;
  private readonly send: (m: CoordinatorMessage) => void;
  private readonly run: (
    c: CoordinatorCommand & { generation: number },
  ) => Promise<void>;

  constructor(port: MicPort, send: (m: CoordinatorMessage) => void) {
    this.port = port;
    this.send = send;
    this.run = serial((c) => this.handle(c));
  }

  /** Every command enters here; resolves when it has been handled. */
  command(c: CoordinatorCommand): Promise<void> {
    // Only stop and cancel make an earlier, still-queued start stale.
    if (c.type === "stop" || c.type === "cancel") this.generation++;
    return this.run({ ...c, generation: this.generation });
  }

  private async handle(
    c: CoordinatorCommand & { generation: number },
  ): Promise<void> {
    switch (c.type) {
      case "start":
        if (c.generation === this.generation) await this.startRecording(c);
        return;
      case "stop":
        await this.closeRecording();
        this.send({ type: "stopped" });
        this.scheduleResume();
        return;
      case "cancel":
        await this.closeRecording();
        this.scheduleResume();
        return;
      case "status":
        this.send({
          type: "status",
          open: Boolean(this.rec || this.pre),
          contexts: this.port.liveContexts(),
          recording: Boolean(this.rec),
          preview: Boolean(this.pre),
        });
        return;
      case "devices":
        this.cache = await this.safeList();
        this.send({ type: "devices", devices: this.cache });
        return;
      case "preview":
        this.wanted = { session: c.session, deviceId: c.deviceId ?? null };
        await this.closePreview();
        if (this.rec) {
          this.send({ type: "preview", session: c.session, state: "paused" });
          return;
        }
        await this.openPreview();
        return;
      case "previewStop":
        if (this.wanted?.session !== c.session) return;
        this.wanted = null;
        await this.closePreview();
        this.send({ type: "preview", session: c.session, state: "stopped" });
        return;
    }
  }

  private async safeList(): Promise<RawInputDevice[]> {
    try {
      return await this.port.list();
    } catch {
      return [];
    }
  }

  /** Opens the chosen device; if it vanished between listing and opening, the system default. */
  private async openChosen(
    selected: string | null,
    mode: Parameters<MicPort["open"]>[1],
  ): Promise<{ mic: OpenMic; deviceId: string | null; fallback: boolean }> {
    const list = normalizeDevices(this.cache ?? (await this.safeList()));
    const choice = chooseInput(selected, list.devices);
    let mic: OpenMic;
    let fallback = choice.fallback;
    try {
      mic = await this.port.open(choice.open, mode);
    } catch (err) {
      if (choice.open === null || !MISSING_DEVICE.has((err as Error)?.name))
        throw err;
      mic = await this.port.open(null, mode);
      fallback = true;
    }
    // A stream opened as "default" reports the alias; name the real device behind it.
    const deviceId =
      mic.deviceId === "default" || !mic.deviceId
        ? (list.systemDefault ?? (await this.relistDefault()))
        : mic.deviceId;
    return { mic, deviceId, fallback };
  }

  /** The cached list couldn't name the default (e.g. access granted since launch): list again. */
  private async relistDefault(): Promise<string | null> {
    this.cache = await this.safeList();
    return normalizeDevices(this.cache).systemDefault;
  }

  private async startRecording(c: {
    id: number;
    deviceId?: string | null;
  }): Promise<void> {
    this.cancelResume();
    await this.closePreview(true);
    await this.closeRecording();
    try {
      const opened = await this.openChosen(c.deviceId ?? null, {
        kind: "record",
      });
      const mic = opened.mic;
      this.rec = mic;
      mic.onEnded(() => {
        if (this.rec === mic) this.send({ type: "ended" });
      });
      this.send({
        type: "started",
        id: c.id,
        deviceId: opened.deviceId,
        fallback: opened.fallback,
        ...(mic.timing ? { timing: mic.timing } : {}),
      });
    } catch (err) {
      const e = err as { name?: string; message?: string };
      this.send({
        type: "error",
        name: e?.name ?? "Error",
        message: e?.message ?? String(err),
      });
      this.scheduleResume();
    }
  }

  private async closeRecording(): Promise<void> {
    const mic = this.rec;
    this.rec = null;
    await mic?.close();
  }

  private async openPreview(): Promise<void> {
    const want = this.wanted;
    if (!want) return;
    try {
      const opened = await this.openChosen(want.deviceId, {
        kind: "preview",
        session: want.session,
      });
      // Superseded while opening (stopped, or a newer preview asked for): release it at once.
      if (this.wanted !== want || this.rec) {
        await opened.mic.close();
        return;
      }
      const mic = opened.mic;
      this.pre = { mic, session: want.session };
      mic.onEnded(() => {
        if (this.pre?.mic !== mic) return;
        this.send({ type: "preview", session: want.session, state: "ended" });
        void this.closeEndedPreview(mic);
      });
      this.send({
        type: "preview",
        session: want.session,
        state: "live",
        deviceId: opened.deviceId,
        fallback: opened.fallback,
      });
    } catch (err) {
      const e = err as { name?: string; message?: string };
      this.send({
        type: "preview",
        session: want.session,
        state: "error",
        error: { name: e?.name ?? "Error", message: e?.message ?? "" },
      });
    }
  }

  private async closeEndedPreview(mic: OpenMic): Promise<void> {
    if (this.pre?.mic !== mic) return;
    this.pre = null;
    await mic.close();
  }

  /** `paused`: closed for a recording, and says so to the Settings window. */
  private async closePreview(paused = false): Promise<void> {
    const p = this.pre;
    this.pre = null;
    if (!p) return;
    await p.mic.close();
    if (paused)
      this.send({ type: "preview", session: p.session, state: "paused" });
  }

  private scheduleResume(): void {
    if (!this.wanted || this.resumeTimer) return;
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      const want = this.wanted;
      if (want)
        void this.run({
          type: "preview",
          session: want.session,
          deviceId: want.deviceId,
          generation: this.generation,
        });
    }, PREVIEW_RESUME_MS);
  }

  private cancelResume(): void {
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
  }
}
