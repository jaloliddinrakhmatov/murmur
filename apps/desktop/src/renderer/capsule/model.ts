// Pure Capsule logic (no DOM), unit-tested under Node (test/capsule.test.ts).
import type { CapsuleState } from "../../shared/ipc.ts";

export type Icon =
  | "mark"
  | "rec"
  | "progress"
  | "sparkle"
  | "check"
  | "clipboard"
  | "alert"
  | "clock"
  | "dash";

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

export interface Presentation {
  icon: Icon;
  tone: Tone;
  /** Visible text. Empty while listening: the waveform says it, the accessible name says it too. */
  text: string;
  /** What assistive technology announces. */
  spoken: string;
  /** Show the live waveform (real microphone levels). */
  wave: boolean;
  /** Show the cancel button. */
  cancel: boolean;
}

/**
 * How each controller state looks. Every state here is emitted by the dictation controller;
 * a message from the controller (e.g. why text was copied) replaces the default text.
 */
export function present(
  state: CapsuleState,
  message?: string,
  notice?: string | null,
  /**
   * Whether the microphone has delivered audio yet. Until it has, a recording state says the
   * microphone is starting, in a neutral tone and without the recording dot or waveform, so
   * nothing suggests speech is being captured before it is (Stage 8).
   */
  live = true,
  /** Stage 9D-2: a meeting recording, shown at rest (its time; the spoken text has none). */
  meeting: { text: string; paused: boolean } | null = null,
): Presentation {
  const base = { wave: false, cancel: false };
  if ((state === "listening" || state === "handsFree") && !live)
    return {
      icon: "progress",
      tone: "neutral",
      text: "Starting mic…",
      spoken:
        state === "handsFree"
          ? "Microphone starting, hands-free"
          : "Microphone starting",
      wave: false,
      cancel: true,
    };
  switch (state) {
    case "resting":
      if (notice)
        return {
          ...base,
          icon: "alert",
          tone: "warning",
          text: notice,
          spoken: notice,
        };
      return meeting
        ? {
            ...base,
            icon: meeting.paused ? "clock" : "rec",
            tone: meeting.paused ? "neutral" : "danger",
            text: meeting.text,
            spoken: meeting.paused
              ? "Meeting recording paused"
              : "Meeting recording on",
          }
        : {
            ...base,
            icon: "mark",
            tone: "neutral",
            text: "",
            spoken: "Murmur is ready",
          };
    case "listening":
      return {
        icon: "rec",
        tone: "accent",
        text: message ?? "",
        spoken: message ?? "Recording",
        wave: true,
        cancel: true,
      };
    case "handsFree":
      return {
        icon: "rec",
        tone: "accent",
        text: message ?? "Hands-free",
        spoken:
          message ??
          "Listening hands-free. Press the shortcut again to finish.",
        wave: true,
        cancel: true,
      };
    case "processing":
      return {
        ...base,
        icon: "progress",
        tone: "neutral",
        text: message ?? "Transcribing…",
        spoken: message ?? "Transcribing",
      };
    case "refining":
      return {
        ...base,
        icon: "sparkle",
        tone: "neutral",
        text: message ?? "Cleaning up…",
        spoken: message ?? "Cleaning up with AI",
      };
    case "inserting":
      return {
        ...base,
        icon: "progress",
        tone: "neutral",
        text: message ?? "Inserting…",
        spoken: message ?? "Inserting text",
      };
    case "inserted":
      return {
        ...base,
        icon: "check",
        tone: "success",
        text: message ?? "Inserted",
        spoken: message ?? "Text inserted",
      };
    case "copied":
      return {
        ...base,
        icon: "clipboard",
        tone: "warning",
        text: message ?? "Copied — press ⌘V",
        spoken: message ?? "Copied to the clipboard. Press Command V to paste.",
      };
    case "cancelled":
      return {
        ...base,
        icon: "dash",
        tone: "neutral",
        text: message ?? "Cancelled",
        spoken: message ?? "Dictation cancelled",
      };
    case "warning":
      return {
        ...base,
        icon: "clock",
        tone: "warning",
        text: message ?? "Warning",
        spoken: message ?? "Warning",
        wave: true,
        cancel: true,
      };
    case "error":
      return {
        ...base,
        icon: "alert",
        tone: "danger",
        text: message ?? "Something went wrong",
        spoken: message ?? "Something went wrong",
      };
  }
}

export const BARS = 9;
const FLOOR_DB = -50;
const CEIL_DB = -8;

/**
 * Maps an RMS level (0..1, from the recorder) to a bar height fraction 0..1 on a decibel scale,
 * so quiet speech is visible and silence is flat. Nothing is added that the microphone didn't
 * hear.
 */
export function levelFraction(rms: number): number {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  const linear = Math.min(
    1,
    Math.max(0, (db - FLOOR_DB) / (CEIL_DB - FLOOR_DB)),
  );
  // A gentle curve keeps ordinary speech (RMS ~0.03–0.2) from all reaching the top.
  return linear ** 1.5;
}

/** The waveform: the most recent levels, newest on the right; one bar per ~100 ms chunk. */
export function pushLevel(history: number[], rms: number): number[] {
  const next = [...history, levelFraction(rms)];
  return next.length > BARS ? next.slice(next.length - BARS) : next;
}

/** Bar heights in px for the current history, left-padded with flat bars. */
export function barHeights(history: number[], min = 3, max = 18): number[] {
  const padded = [
    ...Array<number>(Math.max(0, BARS - history.length)).fill(0),
    ...history,
  ];
  return padded.map((f) => Math.round(min + (max - min) * f));
}
