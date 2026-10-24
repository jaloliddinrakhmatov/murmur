import { types } from "node:util";
import type { AudioRendererMessage } from "./capture.ts";

/** A chunk is ~100 ms of 16 kHz audio (a few KB); anything near 1 MB is not from the worklet. */
export const CHUNK_MAX_BYTES = 1024 * 1024;

const TYPES = new Set([
  "started",
  "stopped",
  "ended",
  "error",
  "status",
  "devices",
  "preview",
  "chunk",
  "level",
]);

/**
 * The worklet transfers an ArrayBuffer; a typed-array view is accepted too (copied to an exact
 * buffer, so a view's offset never leaks in). Whole 16-bit samples, at most CHUNK_MAX_BYTES.
 */
function toArrayBuffer(s: unknown): ArrayBuffer | null {
  let buf: ArrayBuffer;
  if (types.isAnyArrayBuffer(s)) buf = s as ArrayBuffer;
  else if (ArrayBuffer.isView(s))
    buf = new Uint8Array(s.buffer, s.byteOffset, s.byteLength).slice().buffer;
  else return null;
  return buf.byteLength > CHUNK_MAX_BYTES || buf.byteLength % 2 !== 0
    ? null
    : buf;
}

/**
 * Checks a message from the audio window before anything is built from it: a known `type`, and
 * for audio an ArrayBuffer (or typed-array view) of whole 16-bit samples no larger than CHUNK_MAX_BYTES. Returns null
 * for anything else (dropped, never thrown into the dictation path).
 */
export function parseAudioMessage(m: unknown): AudioRendererMessage | null {
  if (!m || typeof m !== "object") return null;
  const msg = m as { type?: unknown; samples?: unknown };
  if (typeof msg.type !== "string" || !TYPES.has(msg.type)) return null;
  if (msg.type === "chunk") {
    const samples = toArrayBuffer(msg.samples);
    if (!samples) return null;
    return { type: "chunk", samples };
  }
  if (msg.type === "level") {
    const l = m as Record<string, unknown>;
    if (
      !Number.isFinite(l.rms) ||
      !Number.isFinite(l.peak) ||
      !Number.isFinite(l.session) ||
      typeof l.muted !== "boolean"
    )
      return null;
  }
  return m as AudioRendererMessage;
}
