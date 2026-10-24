/** Timeline of the hero demo: pure, so the animation can be tested without a browser. */

export interface DemoScript {
  id: string;
  app: string;
  style: string;
  /** What the person says, as it arrives from the microphone (no punctuation, fillers kept). */
  spoken: string;
  /** What lands in the app after cleanup. */
  written: string;
}

export type DemoPhase = "listen" | "think" | "write" | "hold";

export interface DemoFrame {
  phase: DemoPhase;
  spokenCount: number;
  writtenCount: number;
}

export const LISTEN_MS_PER_WORD = 230;
export const LISTEN_TAIL_MS = 350;
export const THINK_MS = 650;
export const WRITE_MS_PER_WORD = 85;
export const HOLD_MS = 3200;

export function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

export function durations(script: DemoScript) {
  const listen =
    words(script.spoken).length * LISTEN_MS_PER_WORD + LISTEN_TAIL_MS;
  const write = words(script.written).length * WRITE_MS_PER_WORD;
  return { listen, think: THINK_MS, write, hold: HOLD_MS };
}

export function totalMs(script: DemoScript): number {
  const d = durations(script);
  return d.listen + d.think + d.write + d.hold;
}

/** The state of the demo `t` milliseconds into a script. */
export function frameAt(script: DemoScript, t: number): DemoFrame {
  const d = durations(script);
  const spokenTotal = words(script.spoken).length;
  const writtenTotal = words(script.written).length;
  const time = Math.max(0, t);
  if (time < d.listen) {
    return {
      phase: "listen",
      spokenCount: Math.min(spokenTotal, Math.floor(time / LISTEN_MS_PER_WORD)),
      writtenCount: 0,
    };
  }
  const afterListen = time - d.listen;
  if (afterListen < d.think) {
    return { phase: "think", spokenCount: spokenTotal, writtenCount: 0 };
  }
  const afterThink = afterListen - d.think;
  if (afterThink < d.write) {
    return {
      phase: "write",
      spokenCount: spokenTotal,
      writtenCount: Math.min(
        writtenTotal,
        Math.floor(afterThink / WRITE_MS_PER_WORD) + 1,
      ),
    };
  }
  return {
    phase: "hold",
    spokenCount: spokenTotal,
    writtenCount: writtenTotal,
  };
}

/** The finished state, used for the server render and for reduced motion. */
export function finalFrame(script: DemoScript): DemoFrame {
  return {
    phase: "hold",
    spokenCount: words(script.spoken).length,
    writtenCount: words(script.written).length,
  };
}
