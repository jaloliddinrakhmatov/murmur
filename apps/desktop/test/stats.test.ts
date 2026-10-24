// Words per minute and day streaks, derived from History (Stage 6A).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryDb } from "../src/main/history/db.ts";
import type { DictationRecord } from "../src/main/core/types.ts";
import { dayStreak, localDayKey, speakingWpm } from "../src/shared/stats.ts";

test("wpm: spoken words over recording minutes, weighted by time", () => {
  assert.equal(speakingWpm([]), null, "no data, no number");
  assert.equal(speakingWpm([{ spokenWords: 30, durationMs: 15_000 }]), 120);
  // 10 words in 5 s and 50 in 55 s: 60 words in 60 s, not the mean of 120 and 54.5.
  assert.equal(
    speakingWpm([
      { spokenWords: 10, durationMs: 5_000 },
      { spokenWords: 50, durationMs: 55_000 },
    ]),
    60,
  );
});

test("wpm: taps, zero-length recordings and rows without a transcript are left out", () => {
  assert.equal(speakingWpm([{ spokenWords: 3, durationMs: 400 }]), null);
  assert.equal(speakingWpm([{ spokenWords: 5, durationMs: 0 }]), null);
  assert.equal(speakingWpm([{ spokenWords: 0, durationMs: 9_000 }]), null);
  assert.equal(
    speakingWpm([
      { spokenWords: 3, durationMs: 400 },
      { spokenWords: 20, durationMs: 10_000 },
    ]),
    120,
  );
});

const tz = "Asia/Tashkent"; // UTC+5, no DST
const at = (iso: string) => Date.parse(iso);

test("streak: consecutive local days ending today, or yesterday when today is still empty", () => {
  const now = at("2026-10-16T12:00:00+05:00");
  const days = ["2026-10-14T09:00:00+05:00", "2026-10-15T23:30:00+05:00"];
  assert.equal(dayStreak([], now, tz), 0);
  assert.equal(
    dayStreak(days.map(at), now, tz),
    2,
    "not broken until today ends",
  );
  assert.equal(
    dayStreak([...days, "2026-10-16T08:00:00+05:00"].map(at), now, tz),
    3,
  );
  assert.equal(
    dayStreak(
      ["2026-10-13T09:00:00+05:00", "2026-10-14T09:00:00+05:00"].map(at),
      now,
      tz,
    ),
    0,
    "a whole missed day ends it",
  );
  assert.equal(
    dayStreak(
      [
        "2026-10-12T09:00:00+05:00",
        "2026-10-14T09:00:00+05:00",
        "2026-10-15T09:00:00+05:00",
      ].map(at),
      now,
      tz,
    ),
    2,
    "a gap stops the count",
  );
});

test("streak: midnight and time zones use the calendar of the zone in use", () => {
  // 23:59 and 00:01 local are two days.
  const late = at("2026-10-15T23:59:00+05:00");
  const early = at("2026-10-16T00:01:00+05:00");
  assert.notEqual(localDayKey(late, tz), localDayKey(early, tz));
  assert.equal(dayStreak([late, early], early, tz), 2);
  // The same two instants are one day in New York (both on Oct 15 there).
  assert.equal(localDayKey(late, "America/New_York"), "2026-10-15");
  assert.equal(localDayKey(early, "America/New_York"), "2026-10-15");
  assert.equal(dayStreak([late, early], early, "America/New_York"), 1);
  // A DST change (US, 2026-11-01) doesn't skip or double a day.
  const ny = "America/New_York";
  const around = [
    "2026-10-31T12:00:00-04:00",
    "2026-11-01T12:00:00-05:00",
    "2026-11-02T12:00:00-05:00",
  ].map(at);
  assert.equal(dayStreak(around, around[2], ny), 3);
});

function row(id: string, extra: Partial<DictationRecord>): DictationRecord {
  return {
    id,
    startedAt: Date.now(),
    durationMs: 6_000,
    status: "inserted",
    strategy: "clipboard-paste",
    rawText: "um send the report to my email",
    finalText: "Send the report to you@example.com.",
    wordCount: 5,
    appName: null,
    appBundleId: null,
    error: null,
    provider: "openai",
    hasAudio: false,
    ...extra,
  };
}

test("History stats: wpm from the original transcript (snippet text not counted); streak follows deletions", () => {
  const db = new HistoryDb(
    join(mkdtempSync(join(tmpdir(), "murmur-stats-")), "h.sqlite"),
  );
  const now = Date.now();
  // 7 spoken words in 6 s = 70 wpm, although the inserted text (with a snippet) differs.
  db.insert(row("a", { startedAt: now }));
  db.insert(row("b", { startedAt: now - 86_400_000 }));
  // Not counted: failed, too short, no original transcript (older rows).
  db.insert(
    row("c", {
      status: "failed",
      finalText: null,
      wordCount: 0,
      startedAt: now - 2 * 86_400_000,
    }),
  );
  db.insert(row("d", { durationMs: 300 }));
  db.insert(row("e", { rawText: null }));
  const s = db.stats(now);
  assert.equal(s.wpm, 70);
  assert.equal(s.streakDays, 2, "failed dictations don't keep a streak going");
  db.delete("b");
  assert.equal(db.stats(now).streakDays, 1, "recalculated from what is left");
  db.clear();
  assert.deepEqual([db.stats(now).wpm, db.stats(now).streakDays], [null, 0]);
  db.close();
});

test("History order: oldest-first works with search, status filter and paging, with stable ties", () => {
  const db = new HistoryDb(
    join(mkdtempSync(join(tmpdir(), "murmur-order-")), "h.sqlite"),
  );
  const t = 1_800_000_000_000;
  db.insert(row("r1", { startedAt: t, finalText: "Report one." }));
  db.insert(row("r2", { startedAt: t + 1000, finalText: "Report two." }));
  db.insert(row("r3", { startedAt: t + 1000, finalText: "Report three." }));
  db.insert(
    row("x", {
      startedAt: t + 2000,
      rawText: "something else",
      finalText: "Other.",
    }),
  );
  db.insert(
    row("f", {
      startedAt: t + 3000,
      status: "failed",
      finalText: "Report failed.",
    }),
  );
  const ids = (q: Parameters<HistoryDb["list"]>[0]) =>
    db.list(q).map((r) => r.id);
  assert.deepEqual(ids({ order: "oldest" }), ["r1", "r2", "r3", "x", "f"]);
  assert.deepEqual(
    ids({}),
    ["f", "x", "r3", "r2", "r1"],
    "newest is the default",
  );
  const q = {
    search: "report",
    statuses: ["inserted" as const],
    order: "oldest" as const,
  };
  assert.deepEqual(ids({ ...q, limit: 2 }), ["r1", "r2"], "first page");
  assert.deepEqual(
    ids({ ...q, limit: 4 }),
    ["r1", "r2", "r3"],
    "next page extends it",
  );
  assert.equal(db.count(q), 3);
  db.close();
});
