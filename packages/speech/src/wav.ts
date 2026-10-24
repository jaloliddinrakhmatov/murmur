/** Encodes mono PCM16 samples as a WAV file. */
export function encodeWav(
  samples: Int16Array,
  sampleRate: number,
): Uint8Array<ArrayBuffer> {
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
  for (let i = 0; i < samples.length; i++)
    view.setInt16(44 + i * 2, samples[i], true);
  return buf;
}

/** Decodes a mono PCM16 WAV produced by `encodeWav` (used for retry from stored audio). */
export function decodeWav(buf: Uint8Array): {
  sampleRate: number;
  samples: Int16Array;
} {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o: number) =>
    String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  if (buf.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE")
    throw new Error("not a WAV file");
  let offset = 12;
  let sampleRate = 0;
  while (offset + 8 <= buf.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt ") {
      if (size < 16 || offset + 8 + 16 > buf.length)
        throw new Error("truncated WAV format chunk");
      if (
        view.getUint16(offset + 10, true) !== 1 ||
        view.getUint16(offset + 22, true) !== 16
      )
        throw new Error("expected mono PCM16");
      sampleRate = view.getUint32(offset + 12, true);
    } else if (id === "data") {
      // The header's size is untrusted: a truncated or corrupt file must not read past its end
      // or allocate what it merely claims.
      const n = Math.min(size, buf.length - offset - 8) >> 1;
      const samples = new Int16Array(n);
      for (let i = 0; i < n; i++)
        samples[i] = view.getInt16(offset + 8 + i * 2, true);
      return { sampleRate, samples };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("no data chunk");
}

/** Concatenates PCM16 chunks into one array. */
export function concatPcm16(chunks: Int16Array[]): Int16Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Int16Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
