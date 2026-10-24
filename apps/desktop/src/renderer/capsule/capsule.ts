// The Capsule renderer: shows the controller's state and the live microphone level. The window
// is non-activating and click-through except over the pill itself.
import type { CapsuleState } from "../../shared/ipc.ts";
import { BARS, barHeights, present, pushLevel, type Icon } from "./model.ts";

declare global {
  interface Window {
    capsuleBridge: {
      onState(
        cb: (payload: {
          state: CapsuleState;
          message?: string;
          seq: number;
        }) => void,
      ): void;
      onLevel(cb: (rms: number) => void): void;
      onNotice(cb: (notice: string | null) => void): void;
      onMeeting(
        cb: (meeting: { text: string; paused: boolean } | null) => void,
      ): void;
      onProbe(cb: (seq: number) => void): void;
      onSound(cb: (kind: string) => void): void;
      painted(
        seq: number,
        receivedAt: number,
        workDoneAt: number,
        paintedAt: number,
      ): void;
      setInteractive(on: boolean): void;
      clicked(): void;
      cancel(): void;
    };
  }
}

const ICONS: Record<Icon, string> = {
  mark: '<svg viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="10" rx="5" class="mark-body"/><circle cx="16" cy="12" r="2.1" class="mark-dot"/></svg>',
  rec: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="4" class="fill"/></svg>',
  progress:
    '<svg viewBox="0 0 16 16" class="spin"><circle cx="8" cy="8" r="5.5" class="track"/><path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5"/></svg>',
  sparkle:
    '<svg viewBox="0 0 16 16"><path d="M8 2.5l1.3 3.6 3.7 1.4-3.7 1.4L8 12.5 6.7 8.9 3 7.5l3.7-1.4z"/></svg>',
  check: '<svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7"/></svg>',
  clipboard:
    '<svg viewBox="0 0 16 16"><rect x="4" y="3.5" width="8" height="10" rx="1.5"/><path d="M6.5 3.5V2.8c0-.4.3-.8.8-.8h1.4c.5 0 .8.4.8.8v.7"/></svg>',
  alert:
    '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/><path d="M8 5.2v3.3M8 10.8v.01"/></svg>',
  clock:
    '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2 1.3"/></svg>',
  dash: '<svg viewBox="0 0 16 16"><path d="M4.5 8h7"/></svg>',
};

const capsule = document.getElementById("capsule")!;
const icon = capsule.querySelector<HTMLElement>(".icon")!;
const label = capsule.querySelector<HTMLElement>(".label")!;
const wave = capsule.querySelector<HTMLElement>(".wave")!;
const cancel = capsule.querySelector<HTMLButtonElement>(".cancel")!;
const spoken = capsule.querySelector<HTMLElement>(".sr")!;

const bars = Array.from({ length: BARS }, () => {
  const b = document.createElement("i");
  wave.append(b);
  return b;
});

let state: CapsuleState = "resting";
let lastMessage: string | undefined;
let notice: string | null = null;
let meeting: { text: string; paused: boolean } | null = null;
let history: number[] = [];
/** False until the first level arrives: the microphone can take a moment to open. */
let live = false;

function drawWave(): void {
  capsule.dataset.live = String(live);
  barHeights(history).forEach((h, i) => {
    bars[i].style.height = `${h}px`;
  });
}

function render(): void {
  const p = present(state, lastMessage, notice, live, meeting);
  capsule.dataset.state = state;
  capsule.dataset.tone = p.tone;
  capsule.dataset.wave = String(p.wave);
  capsule.dataset.cancel = String(p.cancel);
  capsule.dataset.text = String(Boolean(p.text));
  icon.innerHTML = ICONS[p.icon];
  label.textContent = p.text;
  capsule.setAttribute("aria-label", p.spoken);
  // Only state changes are announced, never level updates.
  if (spoken.textContent !== p.spoken) spoken.textContent = p.spoken;
}

const now = () => performance.timeOrigin + performance.now();

window.capsuleBridge.onState(({ state: next, message, seq }) => {
  const receivedAt = now();
  const wasRecording = state === "listening" || state === "handsFree";
  state = next;
  lastMessage = message;
  // A new recording starts flat; leaving recording resets the waveform.
  if (next === "listening" && !wasRecording) {
    history = [];
    live = false;
  }
  if (next !== "listening" && next !== "handsFree" && next !== "warning") {
    history = [];
    live = false;
  }
  drawWave();
  render();
  reportPaint(seq, receivedAt, true);
});

/**
 * Timing report for the main process: received, our work done (state applied and layout
 * forced), and on screen (two animation frames later). A probe changes nothing, so its timing is
 * the frame-scheduling baseline that real state changes are compared against.
 */
function reportPaint(seq: number, receivedAt: number, layout: boolean): void {
  if (layout) capsule.getBoundingClientRect();
  const workDoneAt = now();
  requestAnimationFrame(() =>
    requestAnimationFrame(() =>
      window.capsuleBridge.painted(seq, receivedAt, workDoneAt, now()),
    ),
  );
}

window.capsuleBridge.onProbe((seq) => reportPaint(seq, now(), false));

/**
 * Feedback sounds (Settings → System). Murmur's own short tones, synthesized here rather than
 * bundled: two soft notes falling for “stop”, rising for “done”, low for “error”. They play
 * through the Mac's current output at its volume (muted Mac, muted sound).
 */
const TONES: Record<string, [frequency: number, at: number][]> = {
  stop: [
    [660, 0],
    [520, 0.07],
  ],
  done: [
    [523, 0],
    [784, 0.08],
  ],
  error: [
    [330, 0],
    [262, 0.11],
  ],
};
let soundContext: AudioContext | null = null;
let soundsPlayed = 0;
window.capsuleBridge.onSound((kind) => {
  const notes = TONES[kind];
  if (!notes) return;
  soundContext ??= new AudioContext();
  const t0 = soundContext.currentTime + 0.01;
  for (const [frequency, at] of notes) {
    const osc = soundContext.createOscillator();
    const gain = soundContext.createGain();
    osc.type = "sine";
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0, t0 + at);
    gain.gain.linearRampToValueAtTime(0.12, t0 + at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.12);
    osc.connect(gain).connect(soundContext.destination);
    osc.start(t0 + at);
    osc.stop(t0 + at + 0.14);
  }
  // Observable by the smoke test (no other effect).
  document.documentElement.dataset.soundsPlayed = String(++soundsPlayed);
  document.documentElement.dataset.lastSound = kind;
});

window.capsuleBridge.onNotice((text) => {
  notice = text;
  render();
});

window.capsuleBridge.onMeeting((m) => {
  meeting = m;
  render();
});

// One bar per audio chunk (~100 ms) from the recorder: real levels only.
window.capsuleBridge.onLevel((rms) => {
  if (state !== "listening" && state !== "handsFree" && state !== "warning")
    return;
  history = pushLevel(history, rms);
  const first = !live;
  live = true;
  drawWave();
  // The first real audio: switch from "Starting mic…" to recording (announced once).
  if (first) render();
});

capsule.addEventListener("mouseenter", () =>
  window.capsuleBridge.setInteractive(true),
);
capsule.addEventListener("mouseleave", () =>
  window.capsuleBridge.setInteractive(false),
);
capsule.addEventListener("click", (e) => {
  if (cancel.contains(e.target as Node)) return;
  window.capsuleBridge.clicked();
});
cancel.addEventListener("click", (e) => {
  e.stopPropagation();
  window.capsuleBridge.cancel();
});

drawWave();
render();

export {};
