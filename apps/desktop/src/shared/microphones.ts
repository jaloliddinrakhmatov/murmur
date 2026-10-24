// Microphone devices as the audio renderer sees them, and the rules for choosing one (Stage 6B).
// Pure functions, shared by the audio renderer, the main process and the Hub.

/** One entry of `navigator.mediaDevices.enumerateDevices()`, as the audio renderer reports it. */
export interface RawInputDevice {
  deviceId: string;
  label: string;
  groupId: string;
}

export type Transport = "built-in" | "usb" | "bluetooth" | "virtual" | null;

export interface MicrophoneDevice {
  /**
   * Chromium's device id: stable across restarts for the same profile and origin (measured with
   * Electron 44), never a display name.
   */
  id: string;
  /** Null when macOS hides names (no microphone access yet). */
  name: string | null;
  transport: Transport;
}

export interface DeviceList {
  devices: MicrophoneDevice[];
  /** The device macOS currently uses as its default input, when it can be identified. */
  systemDefault: string | null;
}

/** Chromium's pseudo-entries that stand for another device rather than being one. */
const PSEUDO = new Set(["default", "communications", ""]);

const TRANSPORTS: Record<string, Transport> = {
  "built-in": "built-in",
  usb: "usb",
  bluetooth: "bluetooth",
  virtual: "virtual",
};

/** "MacBook Air Microphone (Built-in)" → name and transport, as Chromium labels inputs on macOS. */
export function parseDeviceLabel(label: string): {
  name: string | null;
  transport: Transport;
} {
  const text = label.replace(/^Default - /, "").trim();
  if (!text) return { name: null, transport: null };
  const m = /^(.*\S)\s+\(([^()]+)\)$/.exec(text);
  const transport = m ? (TRANSPORTS[m[2].toLowerCase()] ?? null) : null;
  return { name: transport ? m![1] : text, transport };
}

/**
 * Real input devices without Chromium's "default"/"communications" aliases or duplicates, and
 * which of them is the system default (the alias shares its group id with the real device).
 */
export function normalizeDevices(raw: RawInputDevice[]): DeviceList {
  const alias = raw.find((d) => d.deviceId === "default");
  const seen = new Set<string>();
  const devices: MicrophoneDevice[] = [];
  let systemDefault: string | null = null;
  for (const d of raw) {
    if (PSEUDO.has(d.deviceId) || seen.has(d.deviceId)) continue;
    seen.add(d.deviceId);
    devices.push({ id: d.deviceId, ...parseDeviceLabel(d.label) });
    if (alias && !systemDefault && alias.groupId && d.groupId === alias.groupId)
      systemDefault = d.deviceId;
  }
  // Two devices in one group (rare): the alias's label names the real one.
  if (alias?.label && systemDefault) {
    const named = raw.find(
      (d) =>
        !PSEUDO.has(d.deviceId) &&
        d.groupId === alias.groupId &&
        `Default - ${d.label}` === alias.label,
    );
    if (named) systemDefault = named.deviceId;
  }
  return { devices, systemDefault };
}

export type InputChoice =
  /** Open this device exactly. */
  | { open: string; fallback: false }
  /** Open the system default, either by choice or because the selected device is missing. */
  | { open: null; fallback: boolean };

/** Which device a recording opens: the selection when it is connected, else the system default. */
export function chooseInput(
  selected: string | null,
  available: readonly { id: string }[],
): InputChoice {
  if (selected === null) return { open: null, fallback: false };
  return available.some((d) => d.id === selected)
    ? { open: selected, fallback: false }
    : { open: null, fallback: true };
}

/** A device's name for people: never invented, but never blank either. */
export function deviceName(d: { name: string | null } | null | undefined) {
  return d?.name ?? "Unnamed microphone";
}

// ---- Level meter --------------------------------------------------------------------------------

/** Below this RMS (about −60 dBFS) the input counts as silent. */
export const SILENCE_RMS = 0.001;
/** A sample this close to full scale counts as clipping. */
export const CLIP_PEAK = 0.98;
const FLOOR_DB = -60;

/** RMS (0–1, full scale = 1) to a 0–1 meter position on a −60…0 dBFS scale. */
export function meterPosition(rms: number): number {
  if (!(rms > SILENCE_RMS)) return 0;
  const db = 20 * Math.log10(Math.min(1, rms));
  return Math.max(0, Math.min(1, (db - FLOOR_DB) / -FLOOR_DB));
}

/**
 * Ballistics: rises at once, falls at `fallPerSecond` of full scale, so speech reads steadily
 * without lagging behind a sudden sound.
 */
export function smoothMeter(
  previous: number,
  target: number,
  elapsedMs: number,
  fallPerSecond = 1.5,
): number {
  if (target >= previous) return target;
  return Math.max(
    target,
    previous - (fallPerSecond * Math.max(0, elapsedMs)) / 1000,
  );
}

/** RMS and peak of a block of float samples (−1…1). */
export function levelOf(samples: ArrayLike<number>): {
  rms: number;
  peak: number;
} {
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    sum += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  return {
    rms: samples.length ? Math.sqrt(sum / samples.length) : 0,
    peak,
  };
}
