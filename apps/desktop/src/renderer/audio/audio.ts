// Hidden audio renderer: the only place Murmur opens the microphone. A recording streams 16 kHz
// mono PCM16 chunks of ~100 ms to the main process; a preview (Settings → Microphone) sends only
// level readings (RMS and peak, 20 per second), never audio. Devices are closed as soon as they
// aren't needed, so the macOS microphone indicator is only on while one of the two is running.
// The rules for which stream may be open live in coordinator.ts.
declare global {
  interface Window {
    audioBridge: {
      onCommand(cb: (command: CoordinatorCommand) => void): void;
      send(message: object): void;
    };
  }
}

import {
  MicCoordinator,
  type CoordinatorCommand,
  type MicPort,
  type OpenMic,
} from "./coordinator.ts";

const SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = 1600;
const LEVEL_SAMPLES = 800;

// Runs inside the AudioWorklet. "pcm-chunker" accumulates 128-frame blocks into ~100 ms Int16
// chunks; "level-meter" reports RMS and peak every 50 ms.
const WORKLET_SOURCE = `
class PcmChunker extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Int16Array(${CHUNK_SAMPLES}); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const v = Math.max(-1, Math.min(1, ch[i]));
      this.buf[this.n++] = v < 0 ? v * 32768 : v * 32767;
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf.buffer.slice(0));
        this.n = 0;
      }
    }
    return true;
  }
}
class LevelMeter extends AudioWorkletProcessor {
  constructor() { super(); this.sum = 0; this.peak = 0; this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i];
      this.sum += v * v;
      const a = v < 0 ? -v : v;
      if (a > this.peak) this.peak = a;
      if (++this.n === ${LEVEL_SAMPLES}) {
        this.port.postMessage({ rms: Math.sqrt(this.sum / this.n), peak: this.peak });
        this.sum = 0; this.peak = 0; this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-chunker", PcmChunker);
registerProcessor("level-meter", LevelMeter);
`;

let workletUrl: string | null = null;
let contexts = 0;

const port: MicPort = {
  liveContexts: () => contexts,

  async list() {
    return (await navigator.mediaDevices.enumerateDevices())
      .filter((d) => d.kind === "audioinput")
      .map((d) => ({
        deviceId: d.deviceId,
        label: d.label,
        groupId: d.groupId,
      }));
  },

  async open(deviceId, mode) {
    const t0 = performance.now();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const track = stream.getAudioTracks()[0];
    const t1 = performance.now();
    let context: AudioContext | null = null;
    let node: AudioWorkletNode | null = null;
    const ended: (() => void)[] = [];
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      node?.disconnect();
      for (const t of stream.getTracks()) t.stop();
      if (context) {
        await context.close().catch(() => {});
        contexts--;
      }
    };
    try {
      context = new AudioContext({ sampleRate: SAMPLE_RATE });
      contexts++;
      workletUrl ??= URL.createObjectURL(
        new Blob([WORKLET_SOURCE], { type: "text/javascript" }),
      );
      await context.audioWorklet.addModule(workletUrl);
      node = new AudioWorkletNode(
        context,
        mode.kind === "record" ? "pcm-chunker" : "level-meter",
        { numberOfInputs: 1, numberOfOutputs: 0 },
      );
      if (mode.kind === "record")
        node.port.onmessage = (e: MessageEvent<ArrayBuffer>) =>
          window.audioBridge.send({ type: "chunk", samples: e.data });
      else
        node.port.onmessage = (
          e: MessageEvent<{ rms: number; peak: number }>,
        ) =>
          window.audioBridge.send({
            type: "level",
            session: mode.session,
            rms: e.data.rms,
            peak: e.data.peak,
            // macOS reports a muted (or stalled) input as a muted track.
            muted: Boolean(track?.muted),
          });
      context.createMediaStreamSource(stream).connect(node);
    } catch (err) {
      await close();
      throw err;
    }
    track?.addEventListener("ended", () => {
      for (const cb of ended) cb();
    });
    const settings = track?.getSettings() ?? {};
    const mic: OpenMic = {
      timing: {
        mediaMs: Math.round(t1 - t0),
        graphMs: Math.round(performance.now() - t1),
      },
      deviceId: settings.deviceId ?? "default",
      groupId: settings.groupId ?? "",
      close,
      onEnded: (cb) => ended.push(cb),
    };
    return mic;
  },
};

// Warm the audio graph once at launch (an AudioContext and the worklet module; no microphone,
// so no permission prompt and no recording indicator). The first dictation otherwise pays this
// one-time setup on top of opening the device (Stage 7 measurement).
void (async () => {
  try {
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    workletUrl ??= URL.createObjectURL(
      new Blob([WORKLET_SOURCE], { type: "text/javascript" }),
    );
    await ctx.audioWorklet.addModule(workletUrl);
    await ctx.close();
  } catch {
    // Warm-up only; a real start reports its own errors.
  }
})();

const coordinator = new MicCoordinator(port, (m) => window.audioBridge.send(m));
window.audioBridge.onCommand((command) => void coordinator.command(command));

// Device changes are pushed, never polled: plugging in or removing a microphone, or changing the
// macOS default, refreshes the list a moment later (rapid changes collapse into one report).
let deviceTimer: ReturnType<typeof setTimeout> | null = null;
navigator.mediaDevices.addEventListener("devicechange", () => {
  if (deviceTimer) clearTimeout(deviceTimer);
  deviceTimer = setTimeout(() => {
    deviceTimer = null;
    void coordinator.command({ type: "devices" });
  }, 250);
});
void coordinator.command({ type: "devices" });

export {};
