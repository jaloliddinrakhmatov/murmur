// Stage 6B microphones: device list rules, the meter maths, the Settings cards, the audio
// renderer's coordinator (fake MicPort: mocked hardware, no real device is opened), the capture
// adapter and the main-process MicrophoneService. Real-device behaviour is covered by the smoke
// test; hot-plugging physical hardware is a manual check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chooseInput,
  levelOf,
  meterPosition,
  normalizeDevices,
  parseDeviceLabel,
  smoothMeter,
  type RawInputDevice,
} from "../src/shared/microphones.ts";
import {
  EMPTY_METER,
  litBars,
  meterHint,
  microphoneCards,
  microphoneSummary,
  nextMeter,
} from "../src/renderer/hub/model/microphone.ts";
import {
  MicCoordinator,
  PREVIEW_RESUME_MS,
  type CoordinatorMessage,
  type MicPort,
  type OpenMic,
} from "../src/renderer/audio/coordinator.ts";
import {
  RendererAudioCapture,
  type AudioRendererLink,
  type AudioRendererMessage,
} from "../src/main/audio/capture.ts";
import { MicrophoneService } from "../src/main/audio/microphones.ts";
import { SettingsStore, plainCodec } from "../src/main/settings/store.ts";
import type { MicrophonesInfo } from "../src/shared/ipc.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The shape measured on a MacBook Air with two virtual inputs (ids shortened). */
const MEASURED: RawInputDevice[] = [
  {
    deviceId: "default",
    label: "Default - MacBook Air Microphone (Built-in)",
    groupId: "g1",
  },
  {
    deviceId: "builtin",
    label: "MacBook Air Microphone (Built-in)",
    groupId: "g1",
  },
  { deviceId: "camo", label: "Camo Microphone (Virtual)", groupId: "g2" },
  { deviceId: "zoom", label: "ZoomAudioDevice (Virtual)", groupId: "g3" },
];

test("device list: aliases and duplicates dropped, system default identified, names never invented", () => {
  const list = normalizeDevices([
    ...MEASURED,
    { deviceId: "communications", label: "Communications", groupId: "g1" },
    { deviceId: "camo", label: "Camo Microphone (Virtual)", groupId: "g2" },
  ]);
  assert.deepEqual(
    list.devices.map((d) => d.id),
    ["builtin", "camo", "zoom"],
  );
  assert.equal(list.systemDefault, "builtin");
  assert.deepEqual(list.devices[0], {
    id: "builtin",
    name: "MacBook Air Microphone",
    transport: "built-in",
  });
  assert.equal(list.devices[1].transport, "virtual");
  // Without microphone access macOS hides names: kept as unknown, not made up.
  const hidden = normalizeDevices([
    { deviceId: "default", label: "", groupId: "" },
    { deviceId: "a", label: "", groupId: "" },
  ]);
  assert.deepEqual(hidden.devices, [{ id: "a", name: null, transport: null }]);
  assert.equal(hidden.systemDefault, null, "no guess without a group");
  assert.deepEqual(normalizeDevices([]), { devices: [], systemDefault: null });
  assert.deepEqual(parseDeviceLabel("Shure MV7 (USB)"), {
    name: "Shure MV7",
    transport: "usb",
  });
  assert.deepEqual(parseDeviceLabel("Studio (Left) Mic"), {
    name: "Studio (Left) Mic",
    transport: null,
  });
});

test("choosing the input: the selection when connected, else the system default (marked as a fallback)", () => {
  const devices = [{ id: "builtin" }, { id: "usb" }];
  assert.deepEqual(chooseInput(null, devices), { open: null, fallback: false });
  assert.deepEqual(chooseInput("usb", devices), {
    open: "usb",
    fallback: false,
  });
  assert.deepEqual(chooseInput("gone", devices), {
    open: null,
    fallback: true,
  });
  assert.deepEqual(chooseInput("gone", []), { open: null, fallback: true });
});

test("meter: RMS on a −60…0 dBFS scale, fast rise and slow fall, silence, clipping and mute", () => {
  assert.equal(meterPosition(0), 0);
  assert.equal(meterPosition(0.0005), 0, "below −60 dBFS is silence");
  assert.equal(meterPosition(1), 1);
  assert.ok(Math.abs(meterPosition(0.1) - 2 / 3) < 1e-9, "−20 dBFS");
  assert.equal(smoothMeter(0.2, 0.9, 50), 0.9, "rises at once");
  assert.ok(Math.abs(smoothMeter(0.9, 0, 100) - 0.75) < 1e-9, "falls 1.5/s");
  const { rms, peak } = levelOf([0.5, -0.5, 0.5, -0.5]);
  assert.equal(rms, 0.5);
  assert.equal(peak, 0.5);
  assert.deepEqual(levelOf([]), { rms: 0, peak: 0 });

  let m = nextMeter(EMPTY_METER, { rms: 0.1, peak: 0.3, muted: false }, 1000);
  assert.equal(litBars(m.position), 5);
  assert.equal(meterHint(m, 1000), null);
  m = nextMeter(m, { rms: 0.5, peak: 0.99, muted: false }, 1050);
  assert.match(meterHint(m, 1050)!, /Too loud/);
  assert.equal(meterHint(m, 2100), null, "the clip light goes out after 1 s");
  let silent = EMPTY_METER;
  for (let t = 0; t <= 3100; t += 50)
    silent = nextMeter(silent, { rms: 0, peak: 0, muted: false }, t);
  assert.match(meterHint(silent, 3100)!, /No sound/);
  assert.equal(litBars(silent.position), 0);
  const muted = nextMeter(EMPTY_METER, { rms: 0, peak: 0, muted: true }, 5);
  assert.match(meterHint(muted, 5)!, /muted/);
});

const info = (over: Partial<MicrophonesInfo> = {}): MicrophonesInfo => ({
  permission: "granted",
  listed: true,
  devices: normalizeDevices(MEASURED).devices,
  systemDefault: "builtin",
  selected: null,
  selectedAvailable: true,
  next: "builtin",
  last: null,
  ...over,
});

test("Settings cards: chosen device first with the meter, then the system default, others folded", () => {
  const system = microphoneCards(info());
  assert.deepEqual(
    system.primary.map((c) => [c.title, c.selected, c.metered]),
    [["System default (MacBook Air Microphone)", true, true]],
  );
  assert.equal(system.others.length, 3);
  assert.equal(
    microphoneSummary(info()),
    "MacBook Air Microphone (system default)",
  );

  const camo = microphoneCards(
    info({ selected: { id: "camo", name: "Camo Microphone" }, next: "camo" }),
  );
  assert.deepEqual(
    camo.primary.map((c) => [c.key, c.selected, c.metered]),
    [
      ["camo", true, true],
      ["system", false, false],
    ],
  );
  assert.deepEqual(
    camo.others.map((c) => c.key),
    ["builtin", "zoom"],
  );
  assert.equal(
    microphoneSummary(
      info({ selected: { id: "camo", name: "Camo Microphone" }, next: "camo" }),
    ),
    "Camo Microphone",
  );

  // Saved microphone unplugged: said plainly; the meter listens to what dictation uses now.
  const gone = info({
    selected: { id: "usb-gone", name: "Shure MV7" },
    selectedAvailable: false,
    next: "builtin",
  });
  const cards = microphoneCards(gone);
  assert.deepEqual(
    cards.primary.map((c) => [c.title, c.connected, c.metered]),
    [
      ["Shure MV7", false, false],
      ["System default (MacBook Air Microphone)", true, true],
    ],
  );
  assert.match(cards.primary[0].detail, /Not connected/);
  assert.equal(
    microphoneSummary(gone),
    "Shure MV7 isn't connected — using MacBook Air Microphone",
  );
  assert.equal(
    microphoneSummary(info({ devices: [], systemDefault: null, next: null })),
    "No microphone found",
  );
});

// ---- Coordinator (audio renderer), with a fake microphone port ----------------------------------

function fakePort(devices: RawInputDevice[] = MEASURED) {
  const opened: { id: string | null; kind: string; mic: OpenMic }[] = [];
  let open = 0;
  let contexts = 0;
  const failNext: { name: string }[] = [];
  const port: MicPort & {
    devices: RawInputDevice[];
    opened: typeof opened;
    readonly openNow: number;
    failNext: typeof failNext;
    end(i?: number): void;
    delayMs: number;
  } = {
    devices,
    opened,
    failNext,
    delayMs: 0,
    get openNow() {
      return open;
    },
    liveContexts: () => contexts,
    list: async () => port.devices,
    async open(deviceId, mode) {
      if (port.delayMs) await sleep(port.delayMs);
      const fail = failNext.shift();
      if (fail) throw Object.assign(new Error(fail.name), { name: fail.name });
      if (deviceId && !port.devices.some((d) => d.deviceId === deviceId))
        throw Object.assign(new Error("gone"), {
          name: "OverconstrainedError",
        });
      open++;
      contexts++;
      const ended: (() => void)[] = [];
      let closed = false;
      const mic: OpenMic & { fireEnded(): void } = {
        deviceId: deviceId ?? "default",
        groupId: "",
        async close() {
          if (closed) return;
          closed = true;
          open--;
          contexts--;
        },
        onEnded: (cb) => ended.push(cb),
        fireEnded: () => ended.forEach((cb) => cb()),
      };
      opened.push({ id: deviceId, kind: mode.kind, mic });
      return mic;
    },
    end(i = opened.length - 1) {
      (opened[i].mic as OpenMic & { fireEnded(): void }).fireEnded();
    },
  };
  return port;
}

function coordinator(port = fakePort()) {
  const sent: CoordinatorMessage[] = [];
  const c = new MicCoordinator(port, (m) => sent.push(m));
  return { c, sent, port };
}

test("coordinator: the selected device is opened; a missing one falls back to the default and says so", async () => {
  const { c, sent, port } = coordinator();
  await c.command({ type: "start", id: 1, deviceId: "camo" });
  assert.deepEqual(sent.at(-1), {
    type: "started",
    id: 1,
    deviceId: "camo",
    fallback: false,
  });
  await c.command({ type: "stop" });
  await c.command({ type: "start", id: 2, deviceId: null });
  assert.deepEqual(
    sent.at(-1),
    { type: "started", id: 2, deviceId: "builtin", fallback: false },
    "the default alias is reported as the real device",
  );
  await c.command({ type: "stop" });
  await c.command({ type: "start", id: 3, deviceId: "unplugged" });
  assert.deepEqual(sent.at(-1), {
    type: "started",
    id: 3,
    deviceId: "builtin",
    fallback: true,
  });
  await c.command({ type: "stop" });
  // Listed, but gone by the time it opens (unplugged in between).
  port.failNext.push({ name: "OverconstrainedError" });
  await c.command({ type: "start", id: 4, deviceId: "zoom" });
  assert.deepEqual(sent.at(-1), {
    type: "started",
    id: 4,
    deviceId: "builtin",
    fallback: true,
  });
  await c.command({ type: "cancel" });
  assert.equal(port.openNow, 0);
  assert.equal(port.liveContexts(), 0);
});

test("coordinator: a recording takes the microphone from the preview, which resumes afterwards; never two streams", async () => {
  const { c, sent, port } = coordinator();
  await c.command({ type: "preview", session: 7, deviceId: null });
  assert.equal(port.openNow, 1);
  assert.deepEqual(sent.at(-1), {
    type: "preview",
    session: 7,
    state: "live",
    deviceId: "builtin",
    fallback: false,
  });
  await c.command({ type: "start", id: 1, deviceId: null });
  assert.equal(port.openNow, 1, "the preview was closed before recording");
  assert.ok(
    sent.some(
      (m) => m.type === "preview" && m.session === 7 && m.state === "paused",
    ),
  );
  assert.equal(port.opened.at(-1)!.kind, "record");
  // Settings asks for a preview while dictating: it waits.
  await c.command({ type: "preview", session: 7, deviceId: null });
  assert.equal(port.openNow, 1);
  await c.command({ type: "stop" });
  assert.equal(port.openNow, 0, "released at once");
  await sleep(PREVIEW_RESUME_MS + 50);
  assert.equal(port.openNow, 1, "preview resumed");
  assert.equal(port.opened.at(-1)!.kind, "preview");
  await c.command({ type: "previewStop", session: 7 });
  assert.equal(port.openNow, 0);
  assert.equal(port.liveContexts(), 0);
  await sleep(PREVIEW_RESUME_MS + 50);
  assert.equal(port.openNow, 0, "nothing reopens after the dialog closed");
});

test("coordinator: rapid preview open/close and press/cancel cycles leak no streams", async () => {
  const { c, port } = coordinator();
  port.delayMs = 2;
  const all: Promise<void>[] = [];
  for (let i = 1; i <= 20; i++) {
    all.push(c.command({ type: "preview", session: i, deviceId: null }));
    all.push(c.command({ type: "previewStop", session: i }));
    all.push(c.command({ type: "start", id: i, deviceId: null }));
    all.push(c.command({ type: "cancel" }));
  }
  await Promise.all(all);
  await sleep(PREVIEW_RESUME_MS + 50);
  assert.equal(port.openNow, 0);
  assert.equal(port.liveContexts(), 0);
  // Starts cancelled before their turn never opened the microphone at all.
  assert.ok(port.opened.filter((o) => o.kind === "record").length < 20);
});

test("coordinator: a status query doesn't cancel a pending start; stop and cancel do", async () => {
  const { c, sent, port } = coordinator();
  port.delayMs = 20;
  const a = c.command({ type: "start", id: 1, deviceId: null });
  void c.command({ type: "status" });
  void c.command({ type: "devices" });
  await a;
  assert.ok(sent.some((m) => m.type === "started" && m.id === 1));
  await c.command({ type: "stop" });
  const b = c.command({ type: "start", id: 2, deviceId: null });
  void c.command({ type: "cancel" });
  await b;
  assert.ok(!sent.some((m) => m.type === "started" && m.id === 2));
});

test("coordinator: a device lost mid-recording is reported; a lost preview closes; failures leave nothing open", async () => {
  const { c, sent, port } = coordinator();
  await c.command({ type: "start", id: 1, deviceId: "camo" });
  port.end();
  assert.deepEqual(sent.at(-1), { type: "ended" });
  await c.command({ type: "stop" });
  assert.equal(port.openNow, 0);

  await c.command({ type: "preview", session: 3, deviceId: null });
  port.end();
  await sleep(5);
  assert.deepEqual(sent.at(-1), {
    type: "preview",
    session: 3,
    state: "ended",
  });
  assert.equal(port.openNow, 0);

  port.failNext.push({ name: "NotAllowedError" });
  await c.command({ type: "start", id: 5, deviceId: null });
  assert.deepEqual(sent.at(-1), {
    type: "error",
    name: "NotAllowedError",
    message: "NotAllowedError",
  });
  port.failNext.push({ name: "NotAllowedError" });
  await c.command({ type: "preview", session: 4, deviceId: null });
  assert.deepEqual(sent.at(-1), {
    type: "preview",
    session: 4,
    state: "error",
    error: { name: "NotAllowedError", message: "NotAllowedError" },
  });
  assert.equal(port.openNow, 0);
  assert.equal(port.liveContexts(), 0);
});

// ---- Capture adapter and MicrophoneService ------------------------------------------------------

function fakeLink(
  onSend: (c: Parameters<AudioRendererLink["send"]>[0]) => void,
) {
  const listeners = new Set<(m: AudioRendererMessage) => void>();
  const link: AudioRendererLink & { emit(m: AudioRendererMessage): void } = {
    send: onSend,
    onMessage: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    emit: (m) => [...listeners].forEach((l) => l(m)),
  };
  return link;
}

test("capture adapter: asks for the selected device, reports what opened, and a loss only while recording", async () => {
  const sent: unknown[] = [];
  const started: unknown[] = [];
  let lost = 0;
  const link = fakeLink((c) => {
    sent.push(c);
    if (c.type === "start")
      queueMicrotask(() =>
        link.emit({
          type: "started",
          id: c.id,
          deviceId: "builtin",
          fallback: true,
        }),
      );
    if (c.type === "stop") queueMicrotask(() => link.emit({ type: "stopped" }));
  });
  const capture = new RendererAudioCapture(link, () => {}, {
    device: () => "usb-gone",
    onStarted: (i) => started.push(i),
    onEnded: () => lost++,
  });
  await capture.start();
  assert.deepEqual(sent[0], { type: "start", id: 1, deviceId: "usb-gone" });
  assert.deepEqual(started, [{ deviceId: "builtin", fallback: true }]);
  link.emit({ type: "ended" });
  assert.equal(lost, 1);
  await capture.stop();
  link.emit({ type: "ended" });
  assert.equal(lost, 1, "not after the recording ended");
});

function micService() {
  const dir = mkdtempSync(join(tmpdir(), "murmur-mic-"));
  const settings = new SettingsStore(dir, plainCodec);
  const sent: Parameters<AudioRendererLink["send"]>[0][] = [];
  let devices = MEASURED;
  const link = fakeLink((c) => {
    sent.push(c);
    if (c.type === "devices")
      queueMicrotask(() => link.emit({ type: "devices", devices }));
  });
  const logs: string[] = [];
  const mics = new MicrophoneService({
    link,
    settings,
    permission: () => "granted",
    log: (e) => logs.push(e),
  });
  return {
    dir,
    settings,
    sent,
    link,
    mics,
    logs,
    setDevices: (d: RawInputDevice[]) => (devices = d),
  };
}

test("microphone service: lists, saves a connected choice (and restores it after a restart), refuses a missing one", async () => {
  const s = micService();
  const first = await s.mics.list();
  assert.equal(first.listed, true);
  assert.deepEqual(
    first.devices.map((d) => d.id),
    ["builtin", "camo", "zoom"],
  );
  assert.equal(first.next, "builtin");
  const chosen = await s.mics.select({ deviceId: "camo" });
  assert.deepEqual(chosen.selected, { id: "camo", name: "Camo Microphone" });
  assert.equal(chosen.next, "camo");
  assert.equal(s.mics.requested(), "camo");
  await assert.rejects(s.mics.select({ deviceId: "nope" }), /isn't connected/);
  await assert.rejects(s.mics.select({ deviceId: 42 }));
  await assert.rejects(s.mics.select({}));
  assert.equal(s.mics.requested(), "camo", "a refused choice changes nothing");
  // Restart: the choice comes back from the settings file.
  const again = new SettingsStore(s.dir, plainCodec);
  assert.deepEqual(again.get().microphone, {
    deviceId: "camo",
    name: "Camo Microphone",
  });
  // Unplugged: reported as unavailable; dictation would use the default.
  s.setDevices(MEASURED.filter((d) => d.deviceId !== "camo"));
  const gone = await s.mics.list();
  assert.equal(gone.selectedAvailable, false);
  assert.equal(gone.next, "builtin");
  assert.equal(s.mics.requested(), "camo", "kept for when it is back");
  const back = await s.mics.select({ deviceId: null });
  assert.equal(back.selected, null);
  assert.equal(back.selectedAvailable, true);
  // A settings patch can't set the microphone (only the validated path can).
  s.settings.update({ microphone: { deviceId: "zoom", name: "x" } });
  assert.equal(s.settings.get().microphone.deviceId, null);
});

test("microphone service: device changes notify; previews are routed by session and follow a new choice", async () => {
  const s = micService();
  let changes = 0;
  s.mics.onChanged(() => changes++);
  await s.mics.list();
  assert.equal(changes, 1);
  s.link.emit({ type: "devices", devices: MEASURED });
  assert.equal(changes, 1, "an unchanged list is not a change");
  s.link.emit({ type: "devices", devices: MEASURED.slice(0, 2) });
  assert.equal(changes, 2);

  const a: unknown[] = [];
  const b: unknown[] = [];
  const sa = s.mics.startPreview((e) => a.push(e));
  const sb = s.mics.startPreview((e) => b.push(e));
  s.link.emit({
    type: "level",
    session: sa,
    rms: 0.1,
    peak: 0.2,
    muted: false,
  });
  assert.equal(a.length, 1);
  assert.equal(b.length, 0);
  s.mics.recordingLevel(0.3);
  assert.equal(a.length, 2);
  assert.equal(b.length, 1);
  assert.equal((b[0] as { source: string }).source, "recording");

  await s.mics.select({ deviceId: "builtin" });
  const moved = s.sent.filter((c) => c.type === "preview");
  assert.deepEqual(moved.slice(-2), [
    { type: "preview", session: sa, deviceId: "builtin" },
    { type: "preview", session: sb, deviceId: "builtin" },
  ]);
  s.mics.stopPreview(sa);
  s.mics.stopPreview(sa);
  assert.equal(
    s.sent.filter((c) => c.type === "previewStop").length,
    1,
    "stopping twice sends one stop",
  );
  s.mics.stopPreview(sb);
  assert.equal(s.mics.previewCount, 0);

  // A reset (or any other writer) changing the choice is announced too.
  const beforeReset = changes;
  s.settings.reset();
  assert.equal(changes, beforeReset + 1);
  s.settings.update({ appearance: "dark" });
  assert.equal(changes, beforeReset + 1, "other settings are not a change");

  s.mics.recordingStarted({ deviceId: "builtin", fallback: true });
  assert.equal(s.mics.info().last?.fallback, true);
  assert.ok(s.logs.includes("microphone.fallback"));
});
