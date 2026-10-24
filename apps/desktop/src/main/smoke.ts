// Electron smoke test (`npm run smoke`): boots the real app composition inside Electron with a fake
// microphone and provider, exercises the dictation pipeline against the real windows, native
// addon, SQLite and vault, and writes results/smoke.json. Exit code 1 on any FAIL.
// Nothing here pastes into another app: every insertion either targets a fake app id (copy-only
// path) or runs through a recording inserter.
import { app, BrowserWindow, systemPreferences } from "electron";
import { loadavg } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testKeychain } from "./settings/secure-storage.ts";
import { createApp } from "./app.ts";
import { runLibraryChecks } from "./smoke-library.ts";
import { runHistoryChecks } from "./smoke-history.ts";
import { runSettingsChecks } from "./smoke-settings.ts";
import { runShellChecks } from "./smoke-shell.ts";
import { runInsightsChecks } from "./smoke-insights.ts";
import { runScratchpadChecks } from "./smoke-scratchpad.ts";
import { runTransformChecks } from "./smoke-transforms.ts";
import { runNotetakerChecks } from "./smoke-notetaker.ts";
import { runStageEChecks } from "./smoke-stage-e.ts";
import { runSystemChecks } from "./smoke-system.ts";
import { runMicrophoneChecks } from "./smoke-microphone.ts";
import { uiDriver } from "./ui-driver.ts";
import { runCapsuleChecks } from "./smoke-capsule.ts";
import { runAudioLifecycleChecks } from "./smoke-audio.ts";
import type { PaintTiming } from "./windows/capsule.ts";
import type {
  AudioPort,
  CapturedAudio,
  Inserter,
  InsertOutcome,
  TargetSnapshot,
} from "./core/types.ts";
import { decodeWav, type TranscriptionProvider } from "@murmur/speech";
import { peakWindowRms } from "./notetaker/service.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Status = "PASS" | "FAIL" | "NOT-TESTED";
const results: { name: string; status: Status; details?: unknown }[] = [];
const record = (name: string, status: Status, details?: unknown) => {
  results.push({ name, status, details });
  console.log(
    `${status.padEnd(10)} ${name}${status === "PASS" ? "" : ` ${JSON.stringify(details)}`}`,
  );
};
const roundAll = (o: object): Record<string, unknown> =>
  JSON.parse(
    JSON.stringify(o, (_k, v) => (typeof v === "number" ? +v.toFixed(1) : v)),
  );
const check = (name: string, ok: boolean, details?: unknown) =>
  record(name, ok ? "PASS" : "FAIL", details);

function pcm(durationMs: number, amplitude: number): CapturedAudio {
  const n = Math.round((durationMs / 1000) * 16000);
  const samples = new Int16Array(n);
  for (let i = 0; i < n; i++)
    samples[i] = Math.round(Math.sin(i / 7) * amplitude * 32767);
  return {
    samples,
    sampleRate: 16000,
    durationMs,
    peakRms: amplitude / Math.SQRT2,
  };
}

class FakeAudio implements AudioPort {
  next = pcm(1200, 0.3);
  async start() {}
  async stop() {
    return this.next;
  }
  async cancel() {}
}

class FakeProvider implements TranscriptionProvider {
  readonly id = "smoke-fake";
  readonly kind = "cloud";
  text = "um smoke test comma works";
  fail: Error | null = null;
  async readiness() {
    return null;
  }
  /** The loudest 100 ms of each audio received (meeting checks: was anything heard?). */
  heard: number[] = [];
  async transcribe(audio: { wav: Uint8Array }) {
    if (this.fail) throw this.fail;
    this.heard.push(peakWindowRms(decodeWav(audio.wav).samples));
    return { text: this.text };
  }
}

class RecordingInserter implements Inserter {
  calls: { text: string; target: TargetSnapshot }[] = [];
  outcome: InsertOutcome = { strategy: "clipboard-paste" };
  async insert(text: string, target: TargetSnapshot) {
    this.calls.push({ text, target });
    return this.outcome;
  }
}

function frontBundleId(): string | null {
  try {
    const asn = execFileSync("lsappinfo", ["front"]).toString().trim();
    return (
      execFileSync("lsappinfo", ["info", "-only", "bundleid", asn])
        .toString()
        .match(/(?:"CFBundleIdentifier"|bundleID)="([^"]+)"/)?.[1] ?? null
    );
  } catch {
    return null;
  }
}

async function waitFor(fn: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(50);
  }
  return false;
}

async function runChecks(): Promise<void> {
  const audio = new FakeAudio();
  const provider = new FakeProvider();
  const inserter = new RecordingInserter();
  let targetId = "com.example.fake-target";
  // Press Enter is recorded, never posted: a real Return would land in the developer's app.
  let enterPresses = 0;
  const murmur = await createApp({
    keychain: testKeychain(),
    audio,
    provider,
    inserter,
    pressReturn: () => {
      enterPresses++;
      return { ok: true };
    },
    // A real ⌘C would copy from the developer's frontmost app.
    copySelection: () => ({ ok: false, reason: "nothing-copied" }),
    target: {
      snapshot: () => ({
        appBundleId: targetId,
        appName: "Fake Target",
        pid: 0,
        secure: false,
        takenAt: Date.now(),
      }),
    },
    env: { shortcut: "ctrl+opt+f12" },
  });
  const {
    capsule,
    controller,
    history,
    native,
    hotkeys,
    audioLink,
    audioWindow,
  } = murmur;

  // 1. Capsule window configuration and paint latency.
  const w = capsule.win;
  check(
    "capsule window: always-on-top, not focusable, all workspaces",
    w.isAlwaysOnTop() && !w.isFocusable() && w.isVisibleOnAllWorkspaces(),
  );
  // Capsule timing (method revised in Phase 8):
  // measured to the moment the state is on screen, not to when the main process reads the
  // report, with no-op probes interleaved as a frame-scheduling baseline.
  const cold = await capsule.timedShow(() => capsule.show("listening"));
  // Stage 9B follow-up: 25 controlled cold launches measured 9–29 ms (also under full CPU load
  // and on another display); the rare slow runs spent ~5 ms in Murmur and the rest waiting for
  // macOS to deliver frames. The details say which part was slow, and the load at the time.
  record(
    "capsule first paint after launch (cold) ≤ 100 ms, send → on screen",
    cold.visibleMs <= 100 ? "PASS" : "FAIL",
    {
      ...roundAll(cold),
      loadAverage: loadavg().map((l) => Math.round(l * 10) / 10),
    },
  );
  await capsule.showAndAwaitPaint("resting");
  const states: PaintTiming[] = [];
  const probes: PaintTiming[] = [];
  for (let i = 0; i < 25; i++)
    for (const s of [
      "listening",
      "processing",
      "inserted",
      "resting",
    ] as const) {
      states.push(await capsule.timedShow(() => capsule.show(s)));
      probes.push(await capsule.probe());
    }
  const q = (xs: number[], p: number) =>
    [...xs].sort((a, b) => a - b)[
      Math.min(xs.length - 1, Math.floor(xs.length * p))
    ];
  const visible = states.map((t) => t.visibleMs);
  const baseline = probes.map((t) => t.visibleMs);
  const timing = {
    samples: states.length,
    visible: { p50: q(visible, 0.5), p95: q(visible, 0.95) },
    baseline: { p50: q(baseline, 0.5), p95: q(baseline, 0.95) },
    ipcP95: q(
      states.map((t) => t.ipcMs),
      0.95,
    ),
    workP95: q(
      states.map((t) => t.workMs),
      0.95,
    ),
    ackP95: q(
      states.map((t) => t.ackMs),
      0.95,
    ),
  };
  const shown = roundAll(timing);
  // Our own costs: these don't depend on frame scheduling.
  check(
    "capsule IPC delivery ≤ 10 ms p95 (100 state changes)",
    timing.ipcP95 <= 10,
    shown,
  );
  check(
    "capsule render work ≤ 10 ms p95 (state applied, layout forced)",
    timing.workP95 <= 10,
    shown,
  );
  // A state change may only be slower than doing nothing by its own work.
  check(
    "capsule on-screen latency within 10 ms of the no-op frame baseline (p95)",
    timing.visible.p95 - timing.baseline.p95 <= 10,
    shown,
  );
  // The absolute budget. When even a no-op takes more than 40 ms to reach the screen, frames
  // are being delayed by the system, so the budget can't be judged on this run.
  record(
    "capsule on-screen latency ≤ 50 ms p95 (warm)",
    timing.visible.p95 <= 50
      ? "PASS"
      : timing.baseline.p95 > 40
        ? "NOT-TESTED"
        : "FAIL",
    timing.visible.p95 <= 50
      ? shown
      : {
          ...shown,
          reason: "system frame scheduling: no-op baseline p95 > 40 ms",
        },
  );

  // 2. Shortcut registered through Carbon (real), Esc armed only while recording.
  check(
    "push-to-talk shortcut registered (Carbon, no permission)",
    hotkeys.current.registered,
    hotkeys.current,
  );
  const escBefore = native.registerHotkey(
    77,
    "escape",
    { exclusive: true, action: "cancel" },
    () => {},
  );
  native.unregisterHotkey(77);
  check("Esc is free while idle", escBefore.ok);

  // 3. End-to-end dictation with the fake mic and provider → real cleanup, history, vault.
  controller.hotkey("down");
  await sleep(50);
  const escDuring = native.registerHotkey(
    77,
    "escape",
    { exclusive: true, action: "cancel" },
    () => {},
  );
  native.unregisterHotkey(77);
  check("Esc is held while recording", escDuring.status === -9878);
  await sleep(400);
  controller.hotkey("up");
  await waitFor(() => controller.currentPhase === "idle", 3000);
  let rows = history.list();
  check(
    "dictation inserted: history row with cleaned text",
    rows.length === 1 &&
      rows[0].status === "inserted" &&
      rows[0].finalText === "Smoke test, works." &&
      !rows[0].hasAudio,
    rows[0],
  );
  check(
    "inserter received cleaned text for the release-time target",
    inserter.calls.length === 1 &&
      inserter.calls[0].text === "Smoke test, works." &&
      inserter.calls[0].target.appBundleId === targetId,
  );

  // 4. Cancellation: nothing recorded.
  controller.hotkey("down");
  await sleep(400);
  controller.cancel();
  await sleep(100);
  controller.hotkey("up");
  await sleep(100);
  check(
    "cancel during recording stores nothing",
    history.list().length === 1 && controller.currentPhase === "idle",
  );

  // 5. Provider failure → row failed with encrypted audio kept → retry copies the result.
  provider.fail = new Error("HTTP 503");
  controller.hotkey("down");
  await sleep(400);
  controller.hotkey("up");
  await waitFor(() => controller.currentPhase === "idle", 3000);
  rows = history.list();
  const failed = rows.find((r) => r.status === "failed");
  const vaultFile = failed ? await murmur.vault.load(failed.id) : null;
  check(
    "provider failure keeps a recoverable row with encrypted audio",
    Boolean(failed && failed.hasAudio && vaultFile && vaultFile.length > 44),
    failed,
  );
  provider.fail = null;
  provider.text = "retried text";
  const clipBefore = native.clipboardReadText();
  const retried = failed
    ? await murmur.service.retryDictation({ id: failed.id })
    : null;
  check(
    "retry transcribes stored audio and copies (never pastes)",
    retried?.status === "copied" &&
      native.clipboardReadText() === "Retried text." &&
      inserter.calls.length === 1,
    retried,
  );
  if (clipBefore != null) native.clipboardWriteText(clipBefore, false);

  // 6. Silence and short tap.
  audio.next = pcm(1200, 0.0005);
  controller.hotkey("down");
  await sleep(400);
  controller.hotkey("up");
  await waitFor(() => controller.currentPhase === "idle", 2000);
  check(
    "silence is not transcribed or stored",
    history.list().length === 2 && inserter.calls.length === 1,
  );
  audio.next = pcm(1200, 0.3);
  controller.hotkey("down");
  await sleep(60);
  controller.hotkey("up");
  await sleep(700);
  check(
    "tap < 300 ms is ignored",
    history.list().length === 2 &&
      inserter.calls.length === 1 &&
      controller.currentPhase === "idle",
  );

  // 7. Secure field and app switch through the real native clipboard-first inserter (no paste: target differs).
  const { ClipboardFirstInserter, decideInsertion } =
    await import("./native/inserter.ts");
  const real = new ClipboardFirstInserter(
    native,
    () => {},
    () => {},
  );
  const before = native.clipboardChangeCount();
  const secure = await real.insert("secret", {
    appBundleId: targetId,
    appName: null,
    pid: null,
    secure: true,
    takenAt: 0,
  });
  check(
    "secure field: rejected, clipboard untouched",
    secure.strategy === "rejected" && native.clipboardChangeCount() === before,
  );
  const moved = await real.insert("moved", {
    appBundleId: "com.example.somewhere-else",
    appName: null,
    pid: null,
    secure: false,
    takenAt: 0,
  });
  check(
    "app switched after release: copy-only with hint",
    moved.strategy === "clipboard-only" &&
      moved.reason === "target-changed" &&
      native.clipboardReadText() === "moved",
  );
  check(
    "insertion policy pure function",
    decideInsertion(
      { appBundleId: "a", appName: null, pid: null, secure: false, takenAt: 0 },
      "a",
      false,
    ).action === "paste",
  );
  if (clipBefore != null) native.clipboardWriteText(clipBefore, false);

  // 8. Clipboard restore guard with the real pasteboard.
  native.clipboardWriteText("user content", false);
  const snap = (
    native as unknown as { clipboardSnapshot(): number }
  ).clipboardSnapshot();
  const cc = native.clipboardWriteText("dictation", true);
  native.clipboardWriteText("newer user copy", false);
  const restore = native.clipboardRestore(snap, cc);
  check(
    "never overwrites newer clipboard content",
    !restore.restored && native.clipboardReadText() === "newer user copy",
    restore,
  );
  if (clipBefore != null) native.clipboardWriteText(clipBefore, false);

  // 9. Real audio renderer: permission state determines what can be verified.
  const mic = systemPreferences.getMediaAccessStatus("microphone");
  await waitFor(() => !audioWindow.webContents.isLoading(), 5000);
  if (mic === "granted") {
    const { RendererAudioCapture } = await import("./audio/capture.ts");
    const cap = new RendererAudioCapture(audioLink);
    try {
      await cap.start();
      await sleep(400);
      const got = await cap.stop();
      check(
        "real microphone capture (400 ms) returns 16 kHz PCM",
        got.sampleRate === 16000 && got.durationMs >= 200,
        { durationMs: got.durationMs, peakRms: got.peakRms },
      );
    } catch (err) {
      record("real microphone capture", "FAIL", String(err));
    }
  } else {
    // Must surface a clean error, never hang or crash.
    const { RendererAudioCapture } = await import("./audio/capture.ts");
    const cap = new RendererAudioCapture(audioLink);
    const outcome = await cap.start().then(
      () => "started",
      (e) => `error:${(e as { code?: string }).code}`,
    );
    await cap.cancel();
    record("real microphone capture", "NOT-TESTED", {
      microphone: mic,
      startOutcome: outcome,
    });
    check(
      "microphone unavailable → clean error path",
      outcome.startsWith("error:") || outcome === "started",
      outcome,
    );
  }

  // 9b. Capsule rendering, waveform, notice, placement; rapid audio start/cancel.
  await runCapsuleChecks(murmur, check);

  // 9c. Microphone lifecycle against the real audio renderer.
  await runAudioLifecycleChecks(murmur, record);

  // 10. No focus steal against an external app (TextEdit), as in M0.
  const textEditRunning = spawnSync("pgrep", ["-x", "TextEdit"]).status === 0;
  if (textEditRunning)
    record(
      "no focus steal vs TextEdit",
      "NOT-TESTED",
      "TextEdit already running",
    );
  else {
    spawnSync("open", ["-a", "TextEdit"]);
    const front = await waitFor(
      () => frontBundleId() === "com.apple.TextEdit",
      8000,
    );
    // Only Murmur coming to the front is a focus steal; another app means someone used the Mac.
    const violations: string[] = [];
    const interruptions: string[] = [];
    if (front) {
      for (let i = 0; i < 20; i++) {
        capsule.show(i % 2 ? "listening" : "processing");
        w.moveTop();
        await sleep(40);
        const f = native.frontmostApp();
        if (f?.pid === process.pid) violations.push(String(f.bundleId));
        else if (f?.bundleId !== "com.apple.TextEdit")
          interruptions.push(String(f?.bundleId));
      }
      capsule.show("resting");
    }
    const pid = spawnSync("pgrep", ["-n", "-x", "TextEdit"])
      .stdout.toString()
      .trim();
    if (pid) process.kill(Number(pid), "SIGTERM");
    // macOS didn't bring TextEdit forward (its file picker, or someone typing elsewhere): the
    // precondition failed, so nothing was measured.
    if (!front)
      record(
        "no focus steal vs TextEdit",
        "NOT-TESTED",
        "TextEdit didn't come to the front within 8 s",
      );
    else if (violations.length === 0 && interruptions.length)
      record(
        "no focus steal vs TextEdit",
        "NOT-TESTED",
        `another app came to the front during the check: ${[...new Set(interruptions)].join(", ")}`,
      );
    else
      check(
        "no focus steal vs TextEdit (20 state changes)",
        violations.length === 0,
        { violations },
      );
  }

  // 10b. M2: dictionary + snippets through the real pipeline, history search, export, retention, deletion.
  const dict = murmur.service.addDictionaryEntry({
    phrase: "NestJS",
    misheardAs: "nest js",
  });
  murmur.service.addDictionaryEntry({ phrase: "Samsara" });
  let dupCaught = false;
  try {
    murmur.service.addDictionaryEntry({ phrase: "samsara" });
  } catch {
    dupCaught = true;
  }
  check("dictionary: duplicate detection is case-insensitive", dupCaught);
  murmur.service.addSnippet({
    trigger: "my email",
    replacement: "ravshan@example.com",
  });
  const issues = murmur.service.checkSnippet({
    trigger: "My Email",
    replacement: "x",
  });
  check(
    "snippets: conflict detection flags a duplicate trigger",
    issues.some((i) => i.code === "duplicate-trigger"),
    issues,
  );
  provider.text = "um deploy nest js for samsara then send it to my email";
  controller.hotkey("down");
  await sleep(400);
  controller.hotkey("up");
  await waitFor(() => controller.currentPhase === "idle", 3000);
  const latest = history.list({ limit: 1 })[0];
  check(
    "dictionary + snippets applied after deterministic cleanup",
    latest?.finalText ===
      "Deploy NestJS for Samsara then send it to ravshan@example.com." &&
      latest.cleanupUsed === "deterministic",
    latest,
  );
  check(
    "dictionary usage counted",
    murmur.service.listDictionary().find((e) => e.id === dict.id)
      ?.usageCount === 1,
  );
  check(
    "history search finds the row by refined and raw text",
    history.list({ search: "nestjs" }).length === 1 &&
      history.list({ search: "nest js" }).length === 1 &&
      history.list({ search: "zzz-none" }).length === 0,
  );
  const meeting = murmur.notetaker.create({ title: "Export check" });
  murmur.notetaker.saveNotes({ id: meeting.id, notes: "kept", revision: 1 });
  const exported = murmur.service.exportData();
  murmur.notetaker.delete({ id: meeting.id, confirm: true });
  check(
    "export contains dictations, dictionary, snippets and meetings",
    exported.dictations.length >= 3 &&
      exported.dictionary.length === 2 &&
      exported.snippets.length === 1 &&
      exported.meetings.some((m) => m.id === meeting.id && m.notes === "kept"),
  );
  murmur.settings.update({ history: { historyRetentionDays: 1 } });
  const old = history.list({ limit: 100 }).at(-1)!; // the oldest row (the retried one, with audio)
  history.update(old.id, { startedAt: Date.now() - 3 * 86_400_000 });
  const purged = await murmur.service.purgeExpiredHistory();
  check(
    "retention purge deletes expired rows with their audio",
    purged === 1 &&
      history.get(old.id) === null &&
      (await murmur.vault.load(old.id)) === null,
    { purged },
  );
  murmur.settings.update({ history: { historyRetentionDays: 0 } });
  const victim = history.list({ limit: 1 })[0];
  await murmur.service.deleteDictation({ id: victim.id });
  check("single deletion removes the row", history.get(victim.id) === null);
  // AI mode with an unconfigured provider must fall back, never fail the dictation.
  murmur.settings.update({ cleanup: { mode: "ai", aiProvider: "groq" } });
  provider.text = "um hello there";
  controller.hotkey("down");
  await sleep(400);
  controller.hotkey("up");
  await waitFor(() => controller.currentPhase === "idle", 3000);
  const aiRow = history.list({ limit: 1 })[0];
  check(
    "AI mode without a key falls back to deterministic cleanup and records why",
    aiRow?.finalText === "Hello there." &&
      aiRow.cleanupUsed === "deterministic" &&
      aiRow.cleanupNote === "ai-fallback:not-ready",
    aiRow,
  );
  murmur.settings.update({ cleanup: { mode: "deterministic" } });

  // 11. Hub window loads and renders (IPC handlers were registered by createApp).
  const hw = murmur.hub!.show("settings/transcription");
  await new Promise<void>((r) =>
    hw.webContents.once("did-finish-load", () => r()),
  );
  await sleep(600);
  // Setup is unfinished in the throwaway profile, so the window opens on onboarding; an
  // explicit navigation (as from the tray menu) must still reach the settings sheet.
  const firstLoad = await hw.webContents
    .executeJavaScript("document.body.innerText")
    .catch(() => "");
  check(
    "hub opens onboarding while setup is unfinished",
    /get started/i.test(firstLoad) && /welcome to murmur/i.test(firstLoad),
    firstLoad.slice(0, 80),
  );
  // First-run setup: every screen of the no-Notetaker path renders with its heading focused,
  // Continue stays off until a question is answered, Enter continues, Esc doesn't close setup,
  // choosing Notetaker adds the meeting questions, practice can be skipped, and finishing saves
  // the answers on this Mac and opens Home. No permission button is pressed.
  const ob = uiDriver(hw);
  const heading = () =>
    ob
      .js<string>(
        `document.querySelector("[data-step-heading]")?.textContent ?? ""`,
      )
      .catch(() => "");
  const waitHeading = async (re: RegExp) => {
    for (const end = Date.now() + 3000; Date.now() < end; await sleep(60))
      if (re.test(await heading())) return true;
    return false;
  };
  const continueOff = () =>
    ob
      .js<boolean>(
        `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Continue")?.disabled === true`,
      )
      .catch(() => false);
  const stage = () =>
    ob
      .js<string>(
        `document.querySelector('nav[aria-label="Setup progress"] [aria-current="step"]')?.innerText?.trim() ?? ""`,
      )
      .catch(() => "");
  const flow: Record<string, boolean | string> = {};
  const stages: string[] = [];
  const visit = async (re: RegExp, key: string) => {
    flow[key] = await waitHeading(re);
    stages.push(await stage());
  };
  await visit(/welcome to murmur/i, "account");
  flow.headingFocused = await ob
    .js<boolean>(`document.activeElement?.matches("[data-step-heading]")`)
    .catch(() => false);
  await ob.clickText("Continue without an account");
  await visit(/where did you hear/i, "heard");
  flow.heardBlocked = await continueOff();
  await ob.clickText("A web search");
  flow.heardPressed =
    (await ob
      .js<string>(
        `[...document.querySelectorAll("[data-chip]")].find((b) => b.textContent.trim() === "A web search")?.getAttribute("aria-pressed") ?? ""`,
      )
      .catch(() => "")) === "true";
  flow.heardOn = !(await continueOff());
  await ob.clickText("Continue");
  await visit(/how can murmur help/i, "help");
  flow.helpBlocked = await continueOff();
  await ob.clickText("Dictating text anywhere");
  await ob.clickText("Notes from my meetings");
  await ob.clickText("Continue");
  await visit(/what do you do for work/i, "work");
  await ob.clickText("Design");
  await ob.key("Return");
  await visit(/where do you spend time typing/i, "typing");
  await ob.clickText("Email");
  await ob.clickText("Continue");
  // Notetaker chosen: the meeting questions follow.
  await visit(/record meetings/i, "meetingTools");
  await ob.clickText("Back");
  await waitHeading(/where do you spend time typing/i);
  await ob.clickText("Back");
  await ob.clickText("Back");
  await waitHeading(/how can murmur help/i);
  await ob.clickText("Notes from my meetings");
  flow.notetakerOff =
    (await ob
      .js<string>(
        `[...document.querySelectorAll("[data-chip]")].find((b) => b.textContent.trim() === "Notes from my meetings")?.getAttribute("aria-pressed") ?? ""`,
      )
      .catch(() => "")) === "false";
  await ob.clickText("Continue");
  await waitHeading(/what do you do for work/i);
  await ob.clickText("Continue");
  await waitHeading(/where do you spend time typing/i);
  await ob.clickText("Continue");
  await visit(/in control of your data/i, "data");
  await ob.key("Escape");
  flow.escKeepsSetup = Boolean(
    await ob.js(`document.querySelector('nav[aria-label="Setup progress"]')`),
  );
  await ob.clickText("Continue");
  await visit(/allow murmur to/i, "permissions");
  await ob.clickText("Continue");
  await visit(/transcription service/i, "transcription");
  await ob.js(
    `[...document.querySelectorAll("button")].find((b) => /^Continue/.test(b.textContent.trim()))?.click()`,
  );
  await visit(/test your microphone/i, "mic");
  await ob.clickText("Yes");
  await visit(/set the languages/i, "languages");
  await ob.clickText("Continue");
  await visit(/test your dictation shortcut/i, "shortcut");
  await ob.clickText("Yes");
  await visit(/reply to a message/i, "learnChat");
  flow.skipChat = await ob.waitFor(
    `[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Skip")`,
    1000,
  );
  flow.noContinueBeforeText = !(await ob
    .js<boolean>(
      `[...document.querySelectorAll("main button")].some((b) => b.textContent.trim() === "Continue")`,
    )
    .catch(() => true));
  await ob.clickText("Skip");
  await visit(/write an email/i, "learnEmail");
  await ob.clickText("Skip");
  await visit(/make a list/i, "learnList");
  await ob.clickText("Skip");
  await visit(/dictation may not save|you could save/i, "savings");
  await ob.clickText("Continue");
  await visit(/free month/i, "referral");
  await ob.clickText("Finish");
  const finished = await ob.waitFor(
    `document.querySelector('nav[aria-label="Main"]')`,
    3000,
  );
  const profile = murmur.settings.get().profile;
  check(
    "onboarding: every screen renders in its stage, answers gate Continue, Notetaker adds its questions, finishing saves answers locally and opens Home",
    Object.values(flow).every((v) => v === true) &&
      stages.join(",") ===
        [
          "Get started",
          "Get started",
          "Get started",
          "Get started",
          "Get started",
          "Get started",
          "Get started",
          "Permissions",
          "Set up",
          "Set up",
          "Set up",
          "Set up",
          "Learn",
          "Learn",
          "Learn",
          "Personalize",
          "Personalize",
        ]
          .map((x) => x.toUpperCase())
          .join(",") &&
      finished &&
      murmur.settings.get().onboardingCompleted === true &&
      profile.heardFrom === "search" &&
      profile.uses.join() === "dictation" &&
      profile.work === "design" &&
      profile.typingPlaces.join() === "email" &&
      profile.completedAt !== null,
    { flow, stages, finished, profile },
  );
  murmur.hub!.show("settings/transcription");
  await sleep(400);
  const rendered = await hw.webContents
    .executeJavaScript("document.body.innerText")
    .catch(() => "");
  check(
    "hub renders settings sheet (section nav + transcription section)",
    /General/.test(rendered) &&
      /Data and Privacy/.test(rendered) &&
      /API key/.test(rendered),
    rendered.slice(0, 200),
  );
  // Regression: Tailwind v4 variable syntax. A primary button must have a visible background.
  const primaryBg = await hw.webContents
    .executeJavaScript(
      `(() => { const b = document.querySelector('button[data-variant=\"primary\"]'); return b ? getComputedStyle(b).backgroundColor : "no-button"; })()`,
    )
    .catch(() => "error");
  check(
    "hub primary buttons are styled (not white-on-white)",
    typeof primaryBg === "string" &&
      primaryBg !== "no-button" &&
      primaryBg !== "rgba(0, 0, 0, 0)" &&
      primaryBg !== "transparent",
    primaryBg,
  );
  const shell = await hw.webContents
    .executeJavaScript(
      `(() => { const nav = document.querySelector('nav[aria-label="Main"]'); const main = document.querySelector("main#main"); return Boolean(nav && main && nav.querySelectorAll("button").length >= 4); })()`,
    )
    .catch(() => false);
  check("hub renders app shell (sidebar + content sheet)", shell === true);
  for (const page of ["dictionary", "snippets", "history"] as const) {
    murmur.hub!.show(page);
    await sleep(400);
    const text = await hw.webContents
      .executeJavaScript("document.body.innerText")
      .catch(() => "");
    const expected =
      page === "dictionary"
        ? /Add word/
        : page === "snippets"
          ? /Create snippet/
          : /today|no dictations/i;
    check(`hub renders ${page} page`, expected.test(text), text.slice(0, 120));
  }

  // 12. Dictation: real totals, History deep links, the banner's action, the paste notice,
  // copy through the service, and an empty state once History is empty.
  const js = <T>(code: string, fallback: T): Promise<T> =>
    hw.webContents.executeJavaScript(code).catch(() => fallback);
  murmur.hub!.show("home");
  await sleep(600);
  const stats = murmur.service.historyStats();
  const homeText = await js("document.body.innerText", "");
  check(
    "home shows greeting and totals from History",
    /Good (morning|afternoon|evening)/.test(homeText) &&
      stats.dictations > 0 &&
      homeText.includes(stats.words.toLocaleString()) &&
      /Time saved/i.test(homeText),
    `stats=${JSON.stringify(stats)} text=${homeText.slice(0, 160)}`,
  );
  // Journey C: the newest dictation (recorded through the controller above) is the first row on
  // Dictation, and opening it shows what was saved.
  const newest = murmur.service.listHistory({ limit: 1 })[0];
  await js(`document.querySelector("[data-row-button]").click()`, null);
  await sleep(600);
  const firstRowId = await js<string | null>(
    `document.querySelector('[id^="dictation-"]')?.id ?? null`,
    null,
  );
  const sheetText = await js<string>(
    `document.querySelector('[role="dialog"]')?.innerText ?? ""`,
    "",
  );
  await js(
    `document.querySelector('[role="dialog"] button[aria-label="Close"]')?.click()`,
    null,
  );
  await sleep(300);
  check(
    "dictation: the newest dictation is the first row and its details show the saved text",
    Boolean(newest) &&
      firstRowId === `dictation-${newest.id}` &&
      (!newest.finalText || sheetText.includes(newest.finalText.slice(0, 40))),
    { newest: newest?.id, firstRowId, sheet: sheetText.slice(0, 120) },
  );

  // History moved into Dictation: old `history/<id>` links open Dictation on that record.
  const firstRecent = murmur.service
    .listHistory({ limit: 25 })
    .find((r) => r.status !== "cancelled" && r.status !== "empty");
  murmur.hub!.show(`history/${firstRecent?.id}`);
  await sleep(700);
  const focused = await js<string | null>(
    `document.querySelector('[id^="dictation-"][aria-current="true"]')?.id ?? null`,
    null,
  );
  const selectedNav = await js<string>(
    `document.querySelector('nav[aria-label="Main"] [aria-current="page"]')?.textContent.trim() ?? ""`,
    "",
  );
  const historyItem = await js<boolean>(
    `[...document.querySelectorAll('nav[aria-label="Main"] button')].some((b) => b.textContent.trim() === "History")`,
    true,
  );
  check(
    "history/<id> deep link opens Dictation and highlights that record; no separate History item",
    Boolean(firstRecent) &&
      focused === `dictation-${firstRecent!.id}` &&
      selectedNav === "Dictation" &&
      !historyItem,
    { expected: firstRecent?.id, focused, selectedNav, historyItem },
  );
  murmur.hub!.show("home");
  await sleep(500);
  await js(
    `[...document.querySelectorAll('section[data-banner="dictation"] button')].find((b) => b.textContent.trim() === "Change shortcut").click()`,
    null,
  );
  await sleep(500);
  const sectionTitle = await js(
    `document.getElementById("settings-section-title")?.textContent ?? ""`,
    "",
  );
  const dialogTitle = await js(
    `[...document.querySelectorAll('[role="dialog"] h2')].map((h) => h.textContent).join("|")`,
    "",
  );
  check(
    "dictation banner action opens Settings → General with the Shortcuts dialog",
    sectionTitle === "General" && dialogTitle.includes("Shortcuts"),
    { sectionTitle, dialogTitle },
  );
  const status = await murmur.service.getStatus();
  murmur.hub!.show("home");
  await sleep(500);
  const pasteNotice = await js<boolean>(
    `document.body.innerText.includes("Automatic pasting is off")`,
    false,
  );
  check(
    "dictation: the copy-instead notice shows exactly when automatic pasting is unavailable",
    pasteNotice === !status.permissions.accessibility,
    { accessibility: status.permissions.accessibility, pasteNotice },
  );
  murmur.hub!.show("home");
  await sleep(500);
  await js(
    `document.querySelector('button[aria-label="Copy text"]').click()`,
    null,
  );
  await sleep(500);
  const toastText = await js(
    `document.querySelector("[data-toast]")?.textContent ?? ""`,
    "",
  );
  check(
    "home copy uses the service and confirms",
    /Copied to the clipboard/.test(toastText),
    toastText,
  );
  await murmur.service.clearHistory();
  await sleep(600);
  const emptyText = await js("document.body.innerText", "");
  check(
    "home shows an empty state, not zeros, when History is empty",
    /Your first dictation is one shortcut away/.test(emptyText) &&
      !/Overview/.test(emptyText),
    emptyText.slice(0, 200),
  );

  // 12b. Reconstructed shell: sidebar, ⌘ keys, setup card, appearance, shared controls.
  await runShellChecks(murmur, hw, check);

  // 12c. Stage 9A Insights: figures from History, calendar, Share, Your voice.
  await runInsightsChecks(murmur, hw, check);

  // 12d. Stage 9B Scratchpad: page, note window, autosave, dictation, tabs, Esc order.
  await runScratchpadChecks(murmur, hw, check);

  // 12e. Stage 9C Transforms: page, editors, opt in, panel, TextEdit selection, Scratchpad.
  await runTransformChecks(murmur, hw, () => inserter.calls, check, record);

  // 12f. Notetaker: page, setup, meetings, autosave, reload, delete (9D-1); recording with the
  // real microphone, pause, dictation refused, transcription, audio deleted (9D-2); privacy.
  await runNotetakerChecks(murmur, hw, check, record, provider);

  // 12g. Stage E: new shortcuts, Command Mode, Press Enter, the Notetaker shortcut.
  await runStageEChecks(
    murmur,
    hw,
    check,
    record,
    provider,
    () => enterPresses,
  );

  // 13. Dictionary and Snippets screens: dialogs, keyboard, focus, search, persistence.
  await runLibraryChecks(murmur, hw, check);

  // 14. History: search, filters, keyboard, details, copy, retry, deletion, Home refresh.
  await runHistoryChecks(murmur, hw, provider, check);

  // 15. Settings: every section, persistence, shortcut recorder, keys, switches.
  await runSettingsChecks(murmur, hw, check);

  // 16. Stage 6B: microphones (real devices), meter, preview/recording, optional shortcuts.
  await runMicrophoneChecks(murmur, hw, inserter, check, record);

  // 17. Stage 6A: totals, sorting, login item, Dock, sounds, last transcript, reset (last).
  await runSystemChecks(murmur, hw, inserter, provider, check);
  murmur.hub!.close();

  await murmur.dispose();
}

export async function runSmoke(): Promise<number> {
  try {
    await runChecks();
  } catch (err) {
    record(
      "smoke run completed without exceptions",
      "FAIL",
      String((err as Error)?.stack ?? err),
    );
  }
  for (const win of BrowserWindow.getAllWindows()) win.destroy();
  // MURMUR_SMOKE_OUT: where to write results (an installed app's own folder is read-only).
  const outDir =
    process.env.MURMUR_SMOKE_OUT ?? join(app.getAppPath(), "results");
  const out = join(outDir, "smoke.json");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    out,
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        electron: process.versions.electron,
        results,
      },
      null,
      2,
    ) + "\n",
  );
  const failures = results.filter((r) => r.status === "FAIL").length;
  console.log(
    `\n${results.length} checks, ${failures} failed, ${results.filter((r) => r.status === "NOT-TESTED").length} not tested → ${out}`,
  );
  return failures ? 1 : 0;
}
