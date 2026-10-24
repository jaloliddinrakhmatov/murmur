// Microphones in the main process (Stage 6B): the device list the audio renderer reports, the
// saved selection, which device the last dictation really used, and level previews for
// Settings → Microphone. The audio renderer stays the only place a microphone is opened.
import {
  MicrophoneSelectSchema,
  type MicLevelEvent,
  type MicPreviewEvent,
  type MicrophonesInfo,
  type PermissionsInfo,
} from "../../shared/ipc.ts";
import {
  chooseInput,
  normalizeDevices,
  type RawInputDevice,
} from "../../shared/microphones.ts";
import type { SettingsStore } from "../settings/store.ts";
import type { AudioRendererLink } from "./capture.ts";

export interface MicrophoneDeps {
  link: AudioRendererLink;
  settings: SettingsStore;
  permission: () => PermissionsInfo["microphone"];
  log: (event: string, data?: Record<string, unknown>) => void;
}

type PreviewSink = (e: MicLevelEvent | MicPreviewEvent) => void;

const LIST_TIMEOUT_MS = 1500;

export class MicrophoneService {
  private raw: RawInputDevice[] | null = null;
  private last: MicrophonesInfo["last"] = null;
  private nextSession = 1;
  private readonly previews = new Map<number, PreviewSink>();
  private readonly listeners = new Set<() => void>();
  private readonly d: MicrophoneDeps;

  constructor(deps: MicrophoneDeps) {
    this.d = deps;
    // The choice can also change outside `select` (a reset restores the default): tell the UI.
    let saved = deps.settings.get().microphone.deviceId;
    deps.settings.onChange((next) => {
      if (next.microphone.deviceId === saved) return;
      saved = next.microphone.deviceId;
      this.notify();
    });
    deps.link.onMessage((m) => {
      if (m.type === "devices") {
        const changed = JSON.stringify(m.devices) !== JSON.stringify(this.raw);
        this.raw = m.devices;
        if (changed) this.notify();
      } else if (m.type === "level")
        this.previews.get(m.session)?.({
          type: "level",
          session: m.session,
          rms: m.rms,
          peak: m.peak,
          muted: m.muted,
          source: "preview",
        });
      else if (m.type === "preview")
        this.previews.get(m.session)?.({
          type: "state",
          session: m.session,
          state: m.state,
          deviceId: m.deviceId ?? null,
          fallback: m.fallback ?? false,
          error: m.error?.name ?? null,
        });
    });
  }

  onChanged(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  /** Asks the renderer for a fresh list (names appear once access is granted). */
  refresh(timeoutMs = LIST_TIMEOUT_MS): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, timeoutMs);
      const off = this.d.link.onMessage((m) => {
        if (m.type === "devices") done();
      });
      function done() {
        clearTimeout(timer);
        off();
        resolve();
      }
      this.d.link.send({ type: "devices" });
    });
  }

  info(): MicrophonesInfo {
    const { devices, systemDefault } = normalizeDevices(this.raw ?? []);
    const saved = this.d.settings.get().microphone;
    const choice = chooseInput(saved.deviceId, devices);
    return {
      permission: this.d.permission(),
      listed: this.raw !== null,
      devices,
      systemDefault,
      selected: saved.deviceId
        ? { id: saved.deviceId, name: saved.name }
        : null,
      selectedAvailable: !choice.fallback,
      next: choice.open ?? systemDefault,
      last: this.last,
    };
  }

  async list(): Promise<MicrophonesInfo> {
    await this.refresh();
    return this.info();
  }

  /**
   * Saves the microphone dictation uses (null = the macOS default). Only a connected device can
   * be chosen; an open preview moves to it at once.
   */
  async select(input: unknown): Promise<MicrophonesInfo> {
    const { deviceId } = MicrophoneSelectSchema.parse(input);
    await this.refresh();
    const device = deviceId
      ? normalizeDevices(this.raw ?? []).devices.find((d) => d.id === deviceId)
      : null;
    if (deviceId && !device)
      throw new Error("That microphone isn't connected anymore.");
    this.d.settings.set("microphone", {
      deviceId,
      name: device?.name ?? null,
    });
    this.d.log("microphone.selected", { systemDefault: deviceId === null });
    for (const session of this.previews.keys())
      this.d.link.send({ type: "preview", session, deviceId });
    return this.info();
  }

  /** The saved selection, read at every recording start. */
  requested(): string | null {
    return this.d.settings.get().microphone.deviceId;
  }

  /** What the renderer opened for a dictation (never a guess). */
  recordingStarted(info: {
    deviceId: string | null;
    fallback: boolean;
    timing?: { mediaMs: number; graphMs: number };
  }): void {
    this.last = {
      deviceId: info.deviceId,
      fallback: info.fallback,
      at: Date.now(),
    };
    if (info.timing) this.d.log("audio.open.timing", { ...info.timing });
    if (info.fallback) this.d.log("microphone.fallback", {});
    this.notify();
  }

  /** Recording levels, shown in an open preview while the recording holds the microphone. */
  recordingLevel(rms: number): void {
    for (const [session, sink] of this.previews)
      sink({
        type: "level",
        session,
        rms,
        peak: 0,
        muted: false,
        source: "recording",
      });
  }

  startPreview(sink: PreviewSink): number {
    const session = this.nextSession++;
    this.previews.set(session, sink);
    this.d.link.send({ type: "preview", session, deviceId: this.requested() });
    return session;
  }

  stopPreview(session: number): void {
    if (!this.previews.delete(session)) return;
    this.d.link.send({ type: "previewStop", session });
  }

  get previewCount(): number {
    return this.previews.size;
  }
}
