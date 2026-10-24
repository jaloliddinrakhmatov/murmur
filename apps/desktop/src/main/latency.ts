// Stage 7 latency measurement (`electron . --latency[=dir]`): the real app in a throwaway
// profile with the real audio renderer and the Mac's microphone. The speech provider and the
// inserter are fakes (no paid requests, nothing pasted), so their numbers are not reported as
// provider or insertion latency. One process gives one cold sample (the first dictation after
// launch) and a set of warm samples; run it several times for more cold samples.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { testKeychain } from "./settings/secure-storage.ts";
import { createApp } from "./app.ts";
import type { InsertOutcome, TargetSnapshot } from "./core/types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function latencyDir(): string {
  const arg = process.argv.find((a) => a.startsWith("--latency="));
  return resolve(arg ? arg.slice("--latency=".length) : "results/latency");
}

type Sample = Record<string, number | string | null>;

export async function runLatency(
  outDir: string,
  warmRuns = 20,
): Promise<number> {
  // Collects Murmur's own diagnostics (metadata only) as the app emits them.
  const events: { event: string; [k: string]: unknown }[] = [];
  const original = console.log;
  console.log = (line: unknown, ...rest: unknown[]) => {
    try {
      const e = JSON.parse(String(line));
      if (e?.event) events.push(e);
    } catch {
      // not a diagnostic line
    }
    original(line, ...rest);
  };
  const inserted: string[] = [];
  // Start-up: process launch → Electron ready (index.ts) → app composed (createApp resolved).
  const readyMs = Math.round(process.uptime() * 1000);
  const m = await createApp({
    // MURMUR_TEST_KEYCHAIN simulates an unanswered (hang), denied or slow (delay:<ms>) Keychain.
    keychain: testKeychain(process.env.MURMUR_TEST_KEYCHAIN),
    headless: true,
    provider: {
      id: "latency-fake",
      kind: "cloud",
      readiness: async () => null,
      transcribe: async () => ({ text: "um latency check" }),
    } as never,
    inserter: {
      insert: async (text: string, _t: TargetSnapshot) => {
        inserted.push(text);
        return { strategy: "clipboard-paste" } as InsertOutcome;
      },
    },
    target: {
      snapshot: () => ({
        appBundleId: "com.example.latency",
        appName: "Latency",
        pid: 0,
        secure: false,
        takenAt: Date.now(),
      }),
    },
    env: { shortcut: "ctrl+opt+f12" },
  });
  const composedMs = Math.round(process.uptime() * 1000);
  for (let i = 0; i < 100 && m.audioWindow.webContents.isLoading(); i++)
    await sleep(50);
  const audioReadyMs = Math.round(process.uptime() * 1000);
  m.settings.update({ onboardingCompleted: true, history: { enabled: false } });
  // "Cold" is the first dictation of a launched app: wait until start-up has finished (the
  // audio renderer has reported its devices), as it has long before a person first dictates.
  for (let i = 0; i < 100 && !m.microphones.info().listed; i++) await sleep(50);
  await sleep(1000);

  const dictate = async () => {
    const from = events.length;
    m.controller.hotkey("down");
    await sleep(1200);
    m.controller.hotkey("up");
    for (let i = 0; i < 200 && m.controller.currentPhase !== "idle"; i++)
      await sleep(10);
    await sleep(300);
    const timing = events
      .slice(from)
      .find((e) => e.event === "dictation.timing") as Sample | undefined;
    const open = events
      .slice(from)
      .find((e) => e.event === "audio.open.timing") as Sample | undefined;
    return { ...(timing ?? {}), ...(open ?? {}) };
  };

  // The Capsule's first show after launch, send → on screen (Stage 9B follow-up).
  const capsuleFirstPaint = await m.capsule.timedShow(() =>
    m.capsule.show("listening"),
  );
  await m.capsule.showAndAwaitPaint("resting");
  const cold = await dictate();
  const warm: Sample[] = [];
  // MURMUR_LATENCY_IDLE_MS: pause between dictations, to see whether an idle audio device is
  // slower to open (the cold-start outlier investigation).
  const idleMs = Number(process.env.MURMUR_LATENCY_IDLE_MS ?? 400);
  const runs = Number(process.env.MURMUR_LATENCY_RUNS ?? warmRuns);
  for (let i = 0; i < runs; i++) {
    await sleep(idleMs);
    warm.push(await dictate());
  }
  console.log = original;
  // Memory of every Murmur process (main, renderers, GPU), in MB, after the run.
  const { app } = await import("electron");
  const metrics = app.getAppMetrics();
  const memory = {
    totalMB: Math.round(
      metrics.reduce((t, p) => t + p.memory.workingSetSize, 0) / 1024,
    ),
    byType: Object.fromEntries(
      metrics.map((p) => [
        `${p.type}-${p.pid}`,
        Math.round(p.memory.workingSetSize / 1024),
      ]),
    ),
  };
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `latency-${Date.now()}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        note: "Real microphone; fake provider and inserter (their stage times are not provider or paste latency).",
        electron: process.versions.electron,
        macOS: process.getSystemVersion(),
        startup: { readyMs, composedMs, audioReadyMs },
        capsuleFirstPaintMs: capsuleFirstPaint.visibleMs,
        keychain: process.env.MURMUR_TEST_KEYCHAIN ?? "available",
        secureStorage: (await m.service.getStatus()).secureStorage,
        memory,
        idleMs,
        cold,
        warm,
        delivered: inserted.length,
      },
      null,
      2,
    ),
  );
  original(`latency → ${file}`);
  await m.dispose();
  return cold.outcome === "inserted" && inserted.length === runs + 1 ? 0 : 1;
}
