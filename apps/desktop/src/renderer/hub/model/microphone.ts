// Settings → Microphone as cards (pure; unit-tested in test/microphones.test.ts). Layout follows
// the reference: the chosen microphone first (with the level meter), then the system default,
// then the remaining devices behind “Show other devices”. Names come from macOS only.
import type { MicrophonesInfo } from "../../../shared/ipc.ts";
import {
  CLIP_PEAK,
  deviceName,
  meterPosition,
  smoothMeter,
  type MicrophoneDevice,
  type Transport,
} from "../../../shared/microphones.ts";

export interface MicCard {
  /** "system" or the device id. */
  key: string;
  /** What choosing this card saves (null = follow the macOS default). */
  value: string | null;
  title: string;
  detail: string;
  selected: boolean;
  connected: boolean;
  /** The card of the device the meter is listening to (the one dictation would use now). */
  metered: boolean;
}

const TRANSPORT_LABELS: Record<Exclude<Transport, null>, string> = {
  "built-in": "Built-in",
  usb: "USB",
  bluetooth: "Bluetooth",
  virtual: "Virtual device (provided by another app)",
};

export function transportLabel(t: Transport): string {
  return t ? TRANSPORT_LABELS[t] : "";
}

export function microphoneCards(info: MicrophonesInfo): {
  primary: MicCard[];
  others: MicCard[];
} {
  const byId = (id: string | null) =>
    id ? (info.devices.find((d) => d.id === id) ?? null) : null;
  const def = byId(info.systemDefault);
  const systemSelected = info.selected === null;
  const meterOnSystem = systemSelected || !info.selectedAvailable;
  const system: MicCard = {
    key: "system",
    value: null,
    title: def ? `System default (${deviceName(def)})` : "System default",
    detail:
      !systemSelected && !info.selectedAvailable
        ? "In use until your microphone is connected again"
        : "Follows System Settings → Sound",
    selected: systemSelected,
    connected: info.devices.length > 0,
    metered: meterOnSystem && info.devices.length > 0,
  };
  const card = (d: MicrophoneDevice, selected: boolean): MicCard => ({
    key: d.id,
    value: d.id,
    title: deviceName(d),
    detail: transportLabel(d.transport),
    selected,
    connected: true,
    metered: selected && !meterOnSystem,
  });
  if (systemSelected)
    return {
      primary: [system],
      others: info.devices.map((d) => card(d, false)),
    };
  const chosen = byId(info.selected!.id);
  const selectedCard: MicCard = chosen
    ? card(chosen, true)
    : {
        key: info.selected!.id,
        value: info.selected!.id,
        title: info.selected!.name ?? "Your microphone",
        detail: "Not connected — dictation uses the system default for now",
        selected: true,
        connected: false,
        metered: false,
      };
  return {
    primary: [selectedCard, system],
    others: info.devices
      .filter((d) => d.id !== info.selected!.id)
      .map((d) => card(d, false)),
  };
}

/** One line for Settings → General: what dictation records from right now. */
export function microphoneSummary(info: MicrophonesInfo): string {
  const next = info.devices.find((d) => d.id === info.next) ?? null;
  if (!info.devices.length) return "No microphone found";
  if (info.selected && !info.selectedAvailable)
    return `${info.selected.name ?? "Your microphone"} isn't connected — using ${deviceName(next)}`;
  return info.selected
    ? deviceName(next)
    : `${deviceName(next)} (system default)`;
}

// ---- Level meter --------------------------------------------------------------------------------

export interface MeterState {
  /** 0–1 meter position after ballistics. */
  position: number;
  /** Until when the clip light stays on (epoch ms). */
  clipUntil: number;
  /** Since when the input has been silent (epoch ms), or null while there is sound. */
  silentSince: number | null;
  muted: boolean;
  at: number;
}

export const EMPTY_METER: MeterState = {
  position: 0,
  clipUntil: 0,
  silentSince: null,
  muted: false,
  at: 0,
};

/** Folds one reading (every 50 ms) into the meter. */
export function nextMeter(
  m: MeterState,
  reading: { rms: number; peak: number; muted: boolean },
  now: number,
): MeterState {
  const target = meterPosition(reading.rms);
  return {
    position: smoothMeter(m.position, target, m.at ? now - m.at : 0),
    clipUntil: reading.peak >= CLIP_PEAK ? now + 1000 : m.clipUntil,
    silentSince: target > 0 ? null : (m.silentSince ?? now),
    muted: reading.muted,
    at: now,
  };
}

export const METER_BARS = 7;

/** How many of the meter's bars are lit. */
export function litBars(position: number, bars = METER_BARS): number {
  return Math.max(0, Math.min(bars, Math.round(position * bars)));
}

/** A short hint under the meter, or null while the level looks normal. */
export function meterHint(m: MeterState, now: number): string | null {
  if (m.muted) return "The microphone is muted or not sending sound.";
  if (m.clipUntil > now)
    return "Too loud — move back a little or lower the input volume.";
  if (m.silentSince !== null && now - m.silentSince > 3000)
    return "No sound yet — speak to test, or check the microphone isn't muted.";
  return null;
}
