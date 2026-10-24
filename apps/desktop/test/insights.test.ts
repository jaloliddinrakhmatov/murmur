import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DictionaryRepo,
  HistoryDb,
  SnippetRepo,
  openDatabase,
} from "../src/main/history/db.ts";
import { HubService, type HubServiceDeps } from "../src/main/hub/service.ts";
import type { DictationRecord } from "../src/main/core/types.ts";
import type { VoiceProfile } from "../src/shared/ipc.ts";
import {
  categorizeApp,
  computeInsights,
  hourLabel,
  insightsSummary,
  longestStreak,
  type InsightRow,
} from "../src/shared/insights.ts";
import {
  CALENDAR_WEEKS,
  calendarPage,
  categoryRows,
  gaugeFraction,
  heatLevel,
  versusTyping,
  wordsToUnlock,
} from "../src/renderer/hub/model/insights.ts";

const TZ = "UTC";
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 18, 15, 0); // Sunday 18 Oct 2026, 15:00 UTC

const row = (extra: Partial<InsightRow>): InsightRow => ({
  startedAt: NOW,
  durationMs: 5000,
  rawText: "um hello there",
  finalText: "Hello there.",
  wordCount: 2,
  appName: "Slack",
  appBundleId: "com.tinyspeck.slackmacgap",
  ...extra,
});
const usage = { dictionary: 3, snippets: 2, wpm: 120 };

test("categorizeApp: known bundle ids and names; browsers and unknown apps are 'other'", () => {
  assert.equal(categorizeApp("com.openai.chat", "ChatGPT"), "ai");
  assert.equal(categorizeApp("com.apple.mail", "Mail"), "email");
  assert.equal(categorizeApp("com.tinyspeck.slackmacgap", null), "work");
  assert.equal(categorizeApp("ru.keepcoder.Telegram", "Telegram"), "personal");
  assert.equal(categorizeApp("com.apple.Notes", "Notes"), "documents");
  assert.equal(categorizeApp(null, "Telegram"), "personal");
  assert.equal(categorizeApp("com.google.Chrome", "Google Chrome"), "other");
  assert.equal(categorizeApp(null, null), "other");
});

test("longestStreak: consecutive local days, duplicates and gaps", () => {
  assert.equal(longestStreak([]), 0);
  assert.equal(longestStreak(["2026-10-01"]), 1);
  assert.equal(
    longestStreak([
      "2026-10-03",
      "2026-10-01",
      "2026-10-02",
      "2026-10-02",
      "2026-10-05",
    ]),
    3,
  );
  // Across a month boundary and daylight-saving change (dates, not 24 h steps).
  assert.equal(longestStreak(["2026-10-31", "2026-11-01", "2026-11-02"]), 3);
});

test("computeInsights: totals, categories, apps, days, streaks and fixes", () => {
  const ins = computeInsights(
    [
      row({ startedAt: NOW - 2 * DAY, wordCount: 10 }),
      row({
        startedAt: NOW - DAY,
        appName: "Mail",
        appBundleId: "com.apple.mail",
        wordCount: 20,
      }),
      row({
        startedAt: NOW,
        appName: "Notes",
        appBundleId: "com.apple.Notes",
        wordCount: 30,
        rawText: "same",
        finalText: "same",
      }),
      row({
        startedAt: NOW - 10 * DAY,
        appName: null,
        appBundleId: null,
        wordCount: 40,
      }),
    ],
    usage,
    NOW,
    TZ,
  );
  assert.equal(ins.dictations, 4);
  assert.equal(ins.words, 100);
  assert.equal(ins.wpm, 120);
  assert.deepEqual(ins.fixes, { dictionary: 3, snippets: 2, tidied: 3 });
  assert.deepEqual(ins.categories, {
    ai: 0,
    email: 20,
    work: 10,
    personal: 0,
    documents: 30,
    other: 40,
  });
  assert.deepEqual(
    ins.apps.map((a) => [a.name, a.words]),
    [
      ["Unknown app", 40],
      ["Notes", 30],
      ["Mail", 20],
      ["Slack", 10],
    ],
  );
  assert.equal(ins.currentStreak, 3);
  assert.equal(ins.longestStreak, 3);
  assert.deepEqual(Object.keys(ins.days).sort(), [
    "2026-10-08",
    "2026-10-16",
    "2026-10-17",
    "2026-10-18",
  ]);
});

test("computeInsights: an empty History has no figures to invent", () => {
  const ins = computeInsights(
    [],
    { dictionary: 0, snippets: 0, wpm: null },
    NOW,
    TZ,
  );
  assert.equal(ins.words, 0);
  assert.equal(ins.wpm, null);
  assert.equal(ins.currentStreak, 0);
  assert.equal(ins.longestStreak, 0);
  assert.equal(ins.voice.peakHour, null);
  assert.equal(ins.voice.topApp, null);
  assert.equal(ins.voice.catchphrase, null);
  assert.deepEqual(ins.voice.topWords, []);
});

test("computeInsights voice: peak hour in the time zone, top words without stop words, catchphrase", () => {
  const phrase = "Let me circle back on that tomorrow.";
  const rows = [
    row({ startedAt: Date.UTC(2026, 9, 18, 9, 5), finalText: phrase }),
    row({ startedAt: Date.UTC(2026, 9, 17, 9, 40), finalText: phrase }),
    row({ startedAt: Date.UTC(2026, 9, 16, 9, 0), finalText: phrase }),
    row({
      startedAt: Date.UTC(2026, 9, 16, 22, 0),
      finalText: "Shipment shipment invoice.",
    }),
  ];
  const ins = computeInsights(rows, usage, NOW, TZ);
  assert.equal(ins.voice.peakHour, 9);
  assert.equal(ins.voice.hours[22], 1);
  assert.equal(
    computeInsights(rows, usage, NOW, "Asia/Tashkent").voice.peakHour,
    14,
  );
  assert.ok(
    ins.voice.topWords.every(
      (w) => !["me", "on", "that", "let"].includes(w.word),
    ),
  );
  assert.deepEqual(ins.voice.topWords.slice(0, 2), [
    { word: "back", count: 3 },
    { word: "circle", count: 3 },
  ]);
  assert.match(
    ins.voice.catchphrase ?? "",
    /^(back on that|circle back on|let me circle|me circle back|on that tomorrow)$/,
  );
  // Fewer than three repeats: no catchphrase.
  assert.equal(
    computeInsights(rows.slice(0, 2), usage, NOW, TZ).voice.catchphrase,
    null,
  );
});

test("insightsSummary: totals and categories only, never dictated words", () => {
  const ins = computeInsights(
    [row({ wordCount: 1500, finalText: "Confidential merger with Acme" })],
    usage,
    NOW,
    TZ,
  );
  const s = insightsSummary(ins);
  assert.match(
    s,
    /^My Murmur insights\n1,500 words dictated in 1 dictation\n120 words per minute\n1 day streak \(longest 1 day\)\nWork messages 100%$/,
  );
  assert.doesNotMatch(s, /Acme|merger/i);
});

test("hourLabel: 12-hour clock", () => {
  assert.deepEqual([0, 9, 12, 13, 23].map(hourLabel), [
    "12 AM",
    "9 AM",
    "12 PM",
    "1 PM",
    "11 PM",
  ]);
});

test("calendarPage: 20 Sunday-first weeks ending this week; paging; future days", () => {
  const now = new Date(2026, 9, 14, 12); // Wednesday
  const page = calendarPage({ "2026-10-14": 2, "2026-01-02": 1 }, now);
  assert.equal(page.weeks.length, CALENDAR_WEEKS);
  assert.ok(
    page.weeks.every((w) => w.length === 7 && w[0].date.getDay() === 0),
  );
  const last = page.weeks.at(-1)!;
  assert.equal(last[3].key, "2026-10-14");
  assert.equal(last[3].count, 2);
  assert.equal(last[3].future, false);
  assert.equal(last[4].future, true);
  assert.equal(page.hasEarlier, true);
  assert.equal(page.hasLater, false);
  const earlier = calendarPage({ "2026-10-14": 2, "2026-01-02": 1 }, now, 1);
  const lastEarlier = earlier.weeks.at(-1)![6].date;
  const next = new Date(
    lastEarlier.getFullYear(),
    lastEarlier.getMonth(),
    lastEarlier.getDate() + 1,
  );
  assert.equal(next.getTime(), page.weeks[0][0].date.getTime());
  assert.equal(earlier.hasLater, true);
  assert.ok(earlier.weeks.flat().some((d) => d.key === "2026-03-01"));
  // Month labels are in order and never share a column with the one before.
  for (let i = 1; i < page.months.length; i++)
    assert.ok(page.months[i].column > page.months[i - 1].column + 1);
  assert.ok(page.months.some((m) => m.label === "Oct"));
});

test("heatLevel, gauge and typing comparison", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 6, 7, 50].map(heatLevel),
    [0, 1, 2, 2, 3, 3, 4, 4],
  );
  assert.equal(gaugeFraction(null), 0);
  assert.equal(gaugeFraction(80), 0.5);
  assert.equal(gaugeFraction(400), 1);
  assert.equal(versusTyping(null), null);
  assert.equal(versusTyping(84), "2.1× typing");
  assert.equal(versusTyping(400), "10× typing");
});

test("categoryRows and wordsToUnlock", () => {
  const ins = computeInsights(
    [
      row({ wordCount: 150 }),
      row({ appName: "Mail", appBundleId: "com.apple.mail", wordCount: 50 }),
    ],
    usage,
    NOW,
    TZ,
  );
  const rows = categoryRows(ins);
  assert.equal(rows[0].category, "other");
  assert.equal(rows.find((r) => r.category === "work")?.percent, 75);
  assert.equal(rows.find((r) => r.category === "email")?.percent, 25);
  assert.equal(wordsToUnlock(ins), 1800);
});

// ---- Service and History ---------------------------------------------------------------------

let n = 0;
function record(extra: Partial<DictationRecord>): DictationRecord {
  return {
    id: `r-${++n}`,
    startedAt: NOW,
    durationMs: 6000,
    status: "inserted",
    strategy: "clipboard-paste",
    rawText: "send it",
    finalText: "Send it.",
    wordCount: 2,
    appName: "Slack",
    appBundleId: "com.tinyspeck.slackmacgap",
    error: null,
    provider: "fake",
    hasAudio: false,
    ...extra,
  };
}

function setup() {
  const db = openDatabase(
    join(mkdtempSync(join(tmpdir(), "murmur-insights-")), "db.sqlite"),
  );
  const history = new HistoryDb(db);
  let stored: VoiceProfile | null = null;
  const writes: (VoiceProfile | null)[] = [];
  const hub = new HubService({
    history,
    dictionary: new DictionaryRepo(db),
    snippets: new SnippetRepo(db),
    voiceProfileStore: {
      read: () => stored,
      write: (p: VoiceProfile | null) => {
        stored = p;
        writes.push(p);
      },
    },
  } as unknown as HubServiceDeps);
  return { history, hub, writes, stored: () => stored };
}

test("HistoryDb.insightRows: only delivered rows with words, oldest first", () => {
  const { history } = setup();
  history.insert(record({ startedAt: NOW, wordCount: 4 }));
  history.insert(
    record({ startedAt: NOW - DAY, status: "copied", wordCount: 3 }),
  );
  history.insert(record({ status: "failed", finalText: null, wordCount: 0 }));
  history.insert(
    record({ status: "cancelled", finalText: null, wordCount: 0 }),
  );
  history.insert(record({ finalText: null, wordCount: 0, rawText: null }));
  const rows = history.insightRows();
  assert.deepEqual(
    rows.map((r) => r.wordCount),
    [3, 4],
  );
  assert.equal(rows[0].appBundleId, "com.tinyspeck.slackmacgap");
});

test("HubService.insights uses History, dictionary/snippet usage and the same wpm as Home", () => {
  const { history, hub } = setup();
  history.insert(
    record({
      wordCount: 30,
      durationMs: 15_000,
      rawText: "a ".repeat(30).trim(),
    }),
  );
  const ins = hub.insights();
  assert.equal(ins.words, 30);
  assert.equal(ins.wpm, history.stats().wpm);
  assert.deepEqual(ins.fixes, { dictionary: 0, snippets: 0, tidied: 1 });
});

test("generateVoiceProfile: locked under 2,000 words, needs an AI service, sends recent text, stores the result", async () => {
  const { history, hub, stored } = setup();
  history.insert(record({ wordCount: 1999 }));
  await assert.rejects(hub.generateVoiceProfile(), /Dictate 1 more words/);

  history.insert(
    record({ wordCount: 1, startedAt: NOW + 1000, finalText: "Newest words." }),
  );
  const calls: { system: string; user: string; maxTokens?: number }[] = [];
  let ready: string | null = "No API key";
  (hub as unknown as { cleanupProvider: () => unknown }).cleanupProvider =
    () => ({
      id: "fake",
      readiness: async () => ready,
      generate: async (
        system: string,
        user: string,
        o: { maxTokens?: number },
      ) => {
        calls.push({ system, user, maxTokens: o.maxTokens });
        return { text: "  You speak plainly and get to the point.  " };
      },
    });
  await assert.rejects(hub.generateVoiceProfile(), /Set up an AI service/);
  assert.equal(calls.length, 0);

  ready = null;
  const profile = await hub.generateVoiceProfile();
  assert.equal(profile.text, "You speak plainly and get to the point.");
  assert.equal(profile.words, 2000);
  assert.equal(profile.provider, "fake", "the service that wrote it is kept");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].maxTokens, 300);
  assert.match(calls[0].system, /Never repeat names/);
  assert.ok(calls[0].user.startsWith("Newest words."));
  assert.deepEqual(stored(), profile);
  assert.deepEqual(hub.voiceProfile(), profile);
});

test("generateVoiceProfile: an empty answer is an error and nothing is stored", async () => {
  const { history, hub, writes } = setup();
  history.insert(record({ wordCount: 2500 }));
  (hub as unknown as { cleanupProvider: () => unknown }).cleanupProvider =
    () => ({
      id: "fake",
      readiness: async () => null,
      generate: async () => ({ text: "   " }),
    });
  await assert.rejects(hub.generateVoiceProfile(), /returned nothing/);
  assert.deepEqual(writes, []);
});
