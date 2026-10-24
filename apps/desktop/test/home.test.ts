import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryDb } from "../src/main/history/db.ts";
import type { DictationRecord } from "../src/main/core/types.ts";
import type { DictationRow, StatusInfo } from "../src/shared/ipc.ts";
import { setupChecklist } from "../src/renderer/hub/model/setup.ts";
import {
  estimateTimeSavedMs,
  TYPING_WPM,
  WEEK_MS,
} from "../src/shared/stats.ts";
import {
  formatDuration,
  greeting,
  timeSavedLabel,
  readiness,
  recentRows,
  whenLabel,
} from "../src/renderer/hub/model/home.ts";
import { ipcErrorMessage } from "../src/renderer/hub/model/errors.ts";

const NOW = new Date(2026, 9, 16, 14, 30).getTime();
const tmp = () =>
  join(mkdtempSync(join(tmpdir(), "murmur-home-")), "db.sqlite");
const row = (
  id: string,
  extra: Partial<DictationRecord> = {},
): DictationRecord => ({
  id,
  startedAt: NOW - 60_000,
  durationMs: 6_000,
  status: "inserted",
  strategy: "clipboard-paste",
  rawText: "hello there",
  finalText: "Hello there.",
  wordCount: 2,
  appName: "TextEdit",
  appBundleId: "com.apple.TextEdit",
  error: null,
  provider: "fake",
  hasAudio: false,
  ...extra,
});

test("history stats are zero with no history, never invented", () => {
  const db = new HistoryDb(tmp());
  assert.deepEqual(db.stats(NOW), {
    dictations: 0,
    words: 0,
    speakingMs: 0,
    firstAt: null,
    lastWeek: { dictations: 0, words: 0 },
    wpm: null,
    streakDays: 0,
  });
  db.close();
});

test("history stats count only delivered dictations with text", () => {
  const db = new HistoryDb(tmp());
  db.insert(row("inserted", { wordCount: 10, durationMs: 4_000 }));
  db.insert(row("copied", { status: "copied", wordCount: 5 }));
  db.insert(
    row("old", {
      startedAt: NOW - WEEK_MS - 1,
      wordCount: 100,
      durationMs: 30_000,
    }),
  );
  // Not delivered or no words: none of these count.
  db.insert(row("failed", { status: "failed", finalText: null, wordCount: 0 }));
  db.insert(row("rejected", { status: "rejected", wordCount: 3 }));
  db.insert(row("cancelled", { status: "cancelled", finalText: null }));
  db.insert(row("empty", { status: "empty", finalText: null, wordCount: 0 }));
  db.insert(row("transcribing", { status: "transcribing", finalText: null }));
  const s = db.stats(NOW);
  assert.equal(s.dictations, 3);
  assert.equal(s.words, 115);
  assert.equal(s.speakingMs, 4_000 + 6_000 + 30_000);
  assert.equal(s.firstAt, NOW - WEEK_MS - 1);
  assert.deepEqual(s.lastWeek, { dictations: 2, words: 15 });
  db.close();
});

test("history stats follow deletions (no separate counters)", () => {
  const db = new HistoryDb(tmp());
  db.insert(row("a", { wordCount: 7 }));
  db.insert(row("b", { wordCount: 3 }));
  db.delete("a");
  assert.equal(db.stats(NOW).words, 3);
  db.clear();
  assert.equal(db.stats(NOW).dictations, 0);
  db.close();
});

test("time saved: typing time at the assumed speed minus speaking time, never negative", () => {
  assert.equal(TYPING_WPM, 40);
  // 400 words take 10 min to type at 40 wpm; 2 min were spent speaking.
  assert.equal(
    estimateTimeSavedMs({ words: 400, speakingMs: 120_000 }),
    480_000,
  );
  assert.equal(estimateTimeSavedMs({ words: 10, speakingMs: 600_000 }), 0);
  assert.equal(estimateTimeSavedMs({ words: 0, speakingMs: 0 }), 0);
  assert.equal(estimateTimeSavedMs({ words: 60, speakingMs: 0 }, 60), 60_000);
});

const status = (over: {
  microphone?: StatusInfo["permissions"]["microphone"];
  accessibility?: boolean;
  providerReady?: string | null;
  registered?: boolean;
}): StatusInfo => ({
  permissions: {
    microphone: over.microphone ?? "granted",
    accessibility: over.accessibility ?? true,
    postEvents: true,
    inputMonitoring: false,
  },
  providerId: "openai",
  providerReady: over.providerReady ?? null,
  actions: {
    pasteLast: null,
    copyLast: null,
    copyOriginal: null,
    openScratchpad: null,
    transformViewChanges: null,
    commandMode: null,
    pressEnter: null,
    startNotetaker: null,
  },
  shortcut: {
    combo: "Ctrl+Opt+Space",
    registered: over.registered ?? true,
    error: null,
  },
  version: "0.1.0",
  lastHotkeyAt: null,
});

test("readiness reflects real permission, shortcut and provider state", () => {
  const ok = readiness(status({}), "OpenAI (cloud)");
  assert.deepEqual(
    ok.map((i) => [i.key, i.tone, i.blocking, i.section]),
    [
      ["microphone", "success", false, "microphone"],
      ["shortcut", "success", false, "shortcuts"],
      ["transcription", "success", false, "transcription"],
    ],
  );
  assert.equal(ok[2].label, "OpenAI (cloud)");

  const broken = readiness(
    status({
      microphone: "denied",
      registered: false,
      providerReady: "OpenAI API key is not set.",
      accessibility: false,
    }),
    "OpenAI (cloud)",
  );
  assert.deepEqual(
    broken.map((i) => [i.key, i.tone, i.blocking, i.section]),
    [
      ["microphone", "danger", true, "microphone"],
      ["shortcut", "danger", true, "shortcuts"],
      ["transcription", "danger", true, "transcription"],
      ["accessibility", "warning", false, "system"],
    ],
  );

  const ask = readiness(status({ microphone: "not-determined" }), "x")[0];
  assert.equal(ask.label, "Microphone not allowed yet");
  assert.equal(ask.blocking, true);
  assert.equal(
    readiness(status({ microphone: "unknown" }), "x")[0].blocking,
    false,
  );
});

test("recent rows skip cancelled and silent recordings and keep order", () => {
  const rows = (["inserted", "cancelled", "failed", "empty", "copied"] as const)
    .map((s, i) => ({ ...row(String(i), { status: s }) }) as DictationRow)
    .concat(
      Array.from(
        { length: 6 },
        (_, i) => ({ ...row(`x${i}`) }) as DictationRow,
      ),
    );
  const recent = recentRows(rows);
  assert.equal(recent.length, 5);
  assert.deepEqual(
    recent.map((r) => r.id),
    ["0", "2", "4", "x0", "x1"],
  );
  assert.deepEqual(recentRows([]), []);
});

test("greeting and labels use local time", () => {
  assert.equal(greeting(new Date(2026, 9, 16, 4, 59)), "Good evening");
  assert.equal(greeting(new Date(2026, 9, 16, 5, 0)), "Good morning");
  assert.equal(greeting(new Date(2026, 9, 16, 12, 0)), "Good afternoon");
  assert.equal(greeting(new Date(2026, 9, 16, 18, 0)), "Good evening");

  const now = new Date(NOW);
  assert.doesNotMatch(whenLabel(NOW - 60_000, now), /Yesterday|,/);
  assert.match(
    whenLabel(new Date(2026, 9, 15, 23, 0).getTime(), now),
    /^Yesterday, /,
  );
  assert.doesNotMatch(
    whenLabel(new Date(2026, 9, 1, 9, 0).getTime(), now),
    /2026/,
  );
  assert.match(whenLabel(new Date(2025, 9, 1, 9, 0).getTime(), now), /2025/);

  assert.equal(formatDuration(59_999), "< 1 min");
  assert.equal(formatDuration(12 * 60_000), "12 min");
  assert.equal(formatDuration(65 * 60_000), "1 h 05 min");
  assert.equal(
    ipcErrorMessage(
      new Error(
        "Error invoking remote method 'hub:historyStats': Error: database is locked",
      ),
    ),
    "database is locked",
  );
  assert.equal(ipcErrorMessage("offline"), "offline");
  assert.equal(timeSavedLabel(30_000), "< 1 min");
  assert.equal(timeSavedLabel(8 * 60_000), "≈ 8 min");
});

test("setup checklist: complete only when every required check passes; reappears when one fails", () => {
  const ready = setupChecklist(status({}));
  assert.equal(ready.complete, true);
  assert.equal(ready.done, 3);
  assert.equal(ready.next, null);

  const noKey = setupChecklist(
    status({ providerReady: "OpenAI API key is not set." }),
  );
  assert.equal(
    noKey.complete,
    false,
    "card comes back when transcription breaks",
  );
  assert.equal(noKey.next, "transcription");
  assert.deepEqual(
    noKey.steps.map((s) => [s.key, s.done]),
    [
      ["microphone", true],
      ["shortcut", true],
      ["transcription", false],
    ],
  );

  const fresh = setupChecklist(
    status({
      microphone: "not-determined",
      registered: false,
      providerReady: "x",
    }),
  );
  assert.equal(fresh.done, 0);
  assert.equal(
    fresh.next,
    "microphone",
    "first unfinished step in setup order",
  );
  assert.equal(
    setupChecklist(status({ microphone: "denied" })).next,
    "microphone",
  );
  assert.equal(setupChecklist(status({ registered: false })).next, "shortcuts");
});

test("setup checklist: missing Accessibility (automatic pasting) never keeps setup incomplete", () => {
  const noPaste = setupChecklist(status({ accessibility: false }));
  assert.equal(noPaste.complete, true);
  assert.ok(!noPaste.steps.some((s) => (s.key as string) === "accessibility"));
});
