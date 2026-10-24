// Microphone lifecycle against the real audio renderer and microphone: opening latency, and
// that no session stays open after cancels at any point, rapid cycles, or a new recording right
// after a cancel. Runs inside `npm run smoke` when microphone access is granted.
import { systemPreferences } from "electron";
import type { MurmurApp } from "./app.ts";
import { audioRendererStatus, RendererAudioCapture } from "./audio/capture.ts";

type Record = (
  name: string,
  status: "PASS" | "FAIL" | "NOT-TESTED",
  details?: unknown,
) => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const q = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[
    Math.min(xs.length - 1, Math.floor(xs.length * p))
  ];

export async function runAudioLifecycleChecks(
  m: MurmurApp,
  record: Record,
): Promise<{ openMs: number[] } | null> {
  if (systemPreferences.getMediaAccessStatus("microphone") !== "granted") {
    record(
      "audio lifecycle (real microphone)",
      "NOT-TESTED",
      "microphone access not granted to this build",
    );
    return null;
  }
  const check = (name: string, ok: boolean, details?: unknown) =>
    record(name, ok ? "PASS" : "FAIL", details);
  const cap = new RendererAudioCapture(m.audioLink);
  const closed = async () => {
    await sleep(150);
    const s = await audioRendererStatus(m.audioLink);
    return { ok: !s.open && s.contexts === 0, ...s };
  };
  const isCancelled = (e: unknown) =>
    (e as { code?: string })?.code === "cancelled";

  // Opening latency: start → microphone delivering audio, 20 times.
  const openMs: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    await cap.start();
    openMs.push(performance.now() - t0);
    await sleep(120);
    await cap.stop();
    await sleep(250);
  }
  const afterNormal = await closed();
  check(
    "audio: microphone opens and closes cleanly (20 recordings)",
    afterNormal.ok,
    {
      openMs: {
        p50: Math.round(q(openMs, 0.5)),
        p95: Math.round(q(openMs, 0.95)),
        max: Math.round(Math.max(...openMs)),
      },
      ...afterNormal,
    },
  );

  // Cancel before the microphone has opened.
  let early: unknown = null;
  const p1 = cap.start().catch((e) => (early = e));
  await cap.cancel();
  await p1;
  const afterEarly = await closed();
  check(
    "audio: cancel before the microphone opens settles as cancelled and leaves nothing open",
    isCancelled(early) && afterEarly.ok,
    { error: String(early), ...afterEarly },
  );

  // Cancel during an active recording.
  await cap.start();
  await sleep(300);
  await cap.cancel();
  const afterActive = await closed();
  check(
    "audio: cancel during recording closes the microphone",
    afterActive.ok,
    afterActive,
  );

  // Repeated start/cancel at different points of the opening sequence.
  let unexpected = 0;
  for (const delay of [0, 20, 60, 120, 180, 250, 0, 90, 300, 10]) {
    const p = cap.start().catch((e) => !isCancelled(e) && unexpected++);
    await sleep(delay);
    await cap.cancel();
    await p;
  }
  const afterCycles = await closed();
  check(
    "audio: ten start/cancel cycles at varied timings: no failures, nothing left open",
    unexpected === 0 && afterCycles.ok,
    { unexpected, ...afterCycles },
  );

  // A new recording immediately after a cancel works and captures audio.
  const p2 = cap.start().catch(() => {});
  await sleep(40);
  await cap.cancel();
  await p2;
  const t0 = performance.now();
  let next: { ok: boolean; startMs: number; durationMs: number } = {
    ok: false,
    startMs: 0,
    durationMs: 0,
  };
  try {
    await cap.start();
    const startMs = performance.now() - t0;
    await sleep(400);
    const got = await cap.stop();
    next = { ok: got.durationMs >= 200, startMs, durationMs: got.durationMs };
  } catch (e) {
    next.ok = false;
    void e;
  }
  const afterNext = await closed();
  check(
    "audio: recording right after a cancel captures audio, then closes",
    next.ok && afterNext.ok,
    {
      startMs: Math.round(next.startMs),
      durationMs: next.durationMs,
      ...afterNext,
    },
  );
  return { openMs };
}
