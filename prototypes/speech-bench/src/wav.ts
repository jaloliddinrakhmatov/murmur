export interface Pcm {
  sampleRate: number;
  samples: Float32Array;
}

/** Reads a mono PCM16 WAV (the format produced by `afconvert -d LEI16@16000 -c 1`). */
export function readWav(buf: Uint8Array): Pcm {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o: number) =>
    String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a WAV file");
  let offset = 12;
  let sampleRate = 0;
  let bits = 0;
  let channels = 0;
  while (offset + 8 <= buf.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt ") {
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bits = view.getUint16(offset + 22, true);
    } else if (id === "data") {
      if (bits !== 16 || channels !== 1)
        throw new Error(`expected mono PCM16, got ${channels}ch ${bits}bit`);
      const n = Math.floor(size / 2);
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++)
        samples[i] = view.getInt16(offset + 8 + i * 2, true) / 32768;
      return { sampleRate, samples };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("no data chunk");
}

export function writeWav({ sampleRate, samples }: Pcm): Uint8Array {
  const buf = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(buf.buffer);
  const str = (o: number, s: string) =>
    [...s].forEach((c, i) => (buf[o + i] = c.charCodeAt(0)));
  str(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(v * 32767), true);
  }
  return buf;
}

export function rms(x: Float32Array): number {
  let s = 0;
  for (const v of x) s += v * v;
  return Math.sqrt(s / Math.max(1, x.length));
}

/** Mixes `noise` into `signal` at the given SNR (dB), looping the noise if shorter. */
export function mixAtSnr(
  signal: Float32Array,
  noise: Float32Array,
  snrDb: number,
): Float32Array {
  const gain = rms(signal) / (rms(noise) * Math.pow(10, snrDb / 20));
  const out = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++)
    out[i] = signal[i] + noise[i % noise.length] * gain;
  // Avoid clipping by normalizing the mix if needed.
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 0.99) for (let i = 0; i < out.length; i++) out[i] *= 0.99 / peak;
  return out;
}

export function concat(
  parts: Float32Array[],
  gapSamples: number,
): Float32Array {
  const total =
    parts.reduce((n, p) => n + p.length, 0) + gapSamples * (parts.length - 1);
  const out = new Float32Array(total);
  let o = 0;
  parts.forEach((p, i) => {
    out.set(p, o);
    o += p.length + (i < parts.length - 1 ? gapSamples : 0);
  });
  return out;
}
