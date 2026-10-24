import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryDb } from "../src/main/history/db.ts";
import { HubService, type HubServiceDeps } from "../src/main/hub/service.ts";
import type { DictationRecord } from "../src/main/core/types.ts";
import type { DictationRow } from "../src/shared/ipc.ts";
import {
  dayLabel,
  filterStatuses,
  friendlyError,
  groupByDay,
  previewText,
  redactSecrets,
  retryInfo,
  formatSeconds,
  rowMeta,
  statusInfo,
  transcriptVersions,
} from "../src/renderer/hub/model/history.ts";
import { FakeVault } from "./helpers.ts";

const NOW = new Date(2026, 9, 16, 14, 30).getTime();
const HOUR = 3_600_000;
const tmp = () =>
  join(mkdtempSync(join(tmpdir(), "murmur-history-")), "db.sqlite");
const row = (
  id: string,
  extra: Partial<DictationRecord> = {},
): DictationRecord => ({
  id,
  startedAt: NOW - HOUR,
  durationMs: 4200,
  status: "inserted",
  strategy: "clipboard-paste",
  rawText: "um hello there",
  finalText: "Hello there.",
  wordCount: 2,
  appName: "TextEdit",
  appBundleId: "com.apple.TextEdit",
  error: null,
  provider: "fake",
  hasAudio: false,
  ...extra,
});

function seeded(path = tmp()) {
  const db = new HistoryDb(path);
  db.insert(
    row("cafe", {
      startedAt: NOW - 1 * HOUR,
      finalText: "Meet at Café Müller at noon.",
      rawText: "meet at cafe muller at noon",
      appName: "Slack",
    }),
  );
  db.insert(
    row("tash", {
      startedAt: NOW - 2 * HOUR,
      status: "copied",
      strategy: "clipboard-only",
      error: "target-changed",
      finalText: "Тошкентдаги офис",
      rawText: "тошкентдаги офис",
      appName: "Mail",
    }),
  );
  db.insert(
    row("fail", {
      startedAt: NOW - 26 * HOUR,
      status: "failed",
      rawText: null,
      finalText: null,
      wordCount: 0,
      error: "HTTP 503 upstream unavailable",
      hasAudio: true,
    }),
  );
  db.insert(
    row("secure", {
      startedAt: NOW - 27 * HOUR,
      status: "rejected",
      strategy: "rejected",
      error: "secure-field",
      appName: "1Password",
    }),
  );
  return db;
}

// ---- SQLite search, filters, paging --------------------------------------------------------

test("history search is Unicode case-insensitive and covers raw text and app name", () => {
  const db = seeded();
  const ids = (search: string) => db.list({ search }).map((r) => r.id);
  assert.deepEqual(ids("CAFÉ MÜLLER"), ["cafe"]);
  assert.deepEqual(ids("café"), ["cafe"], "decomposed é");
  assert.deepEqual(ids("muller"), ["cafe"], "raw transcript");
  assert.deepEqual(ids("ТОШКЕНТ"), ["tash"], "Cyrillic case folding");
  assert.deepEqual(ids("slack"), ["cafe"], "application name");
  assert.deepEqual(ids("1password"), ["secure"]);
  assert.deepEqual(ids("100%"), [], "wildcards are literal");
  assert.deepEqual(ids("zzz"), []);
  assert.equal(db.list({ search: "   " }).length, 4, "blank query = all");
  db.close();
});

test("status filters, counts and paging", () => {
  const db = seeded();
  const issues = filterStatuses("issues");
  assert.deepEqual(
    db.list({ statuses: issues }).map((r) => r.id),
    ["fail", "secure"],
  );
  assert.deepEqual(
    db.list({ statuses: filterStatuses("copied") }).map((r) => r.id),
    ["tash"],
  );
  assert.equal(filterStatuses("all"), undefined);
  assert.equal(db.count({ statuses: issues }), 2);
  assert.equal(db.count({ search: "о", statuses: ["copied"] }), 1);
  assert.equal(db.count(), 4);
  assert.deepEqual(
    db.list({ limit: 2 }).map((r) => r.id),
    ["cafe", "tash"],
    "newest first, limited",
  );
  db.close();
});

test("history persists across a database restart; search still works", () => {
  const path = tmp();
  seeded(path).close();
  const reopened = new HistoryDb(path);
  assert.equal(reopened.count(), 4);
  assert.deepEqual(
    reopened.list({ search: "café" }).map((r) => r.id),
    ["cafe"],
  );
  assert.equal(reopened.get("fail")?.hasAudio, true);
  reopened.close();
});

// ---- Service: records, deletion, stats ----------------------------------------------------

function service(db: HistoryDb) {
  const vault = new FakeVault();
  const copied: string[] = [];
  const hub = new HubService({
    history: db,
    vault,
    inserter: { copy: (t: string) => void copied.push(t) },
  } as unknown as HubServiceDeps);
  return { hub, vault, copied };
}

test("query returns a page and the total; a record can be fetched alone", () => {
  const db = seeded();
  const { hub } = service(db);
  const page = hub.queryHistory({ limit: 1, statuses: ["failed", "rejected"] });
  assert.equal(page.rows.length, 1);
  assert.equal(page.total, 2);
  assert.equal(hub.getDictation({ id: "tash" })?.finalText, "Тошкентдаги офис");
  assert.equal(hub.getDictation({ id: "missing" }), null);
  db.close();
});

test("copy uses the guarded clipboard path for the refined or original text", () => {
  const db = seeded();
  const { hub, copied } = service(db);
  assert.equal(hub.copyDictation({ id: "cafe" }, "final"), true);
  assert.equal(hub.copyDictation({ id: "cafe" }, "raw"), true);
  assert.equal(hub.copyDictation({ id: "fail" }, "final"), false, "no text");
  assert.deepEqual(copied, [
    "Meet at Café Müller at noon.",
    "meet at cafe muller at noon",
  ]);
  db.close();
});

test("deleting a dictation removes its encrypted audio, keeps others, updates Home stats", async () => {
  const db = seeded();
  const { hub, vault } = service(db);
  await vault.save("fail", new Uint8Array([1, 2, 3]));
  await vault.save("other", new Uint8Array([4]));
  let notified = 0;
  hub.onHistoryChanged(() => notified++);
  const before = hub.historyStats(NOW);

  assert.equal(await hub.deleteDictation({ id: "fail" }), true);
  assert.equal(vault.files.has("fail"), false, "recording deleted with it");
  assert.equal(vault.files.has("other"), true, "unrelated audio kept");
  assert.equal(db.count(), 3);

  assert.equal(await hub.deleteDictation({ id: "cafe" }), true);
  const after = hub.historyStats(NOW);
  assert.equal(after.dictations, before.dictations - 1);
  assert.equal(after.words, before.words - 2);
  assert.ok(notified >= 2, "Home and History are told to refresh");
  assert.equal(await hub.deleteDictation({ id: "cafe" }), false);
  db.close();
});

// ---- View model -----------------------------------------------------------------------------

const r = (extra: Partial<DictationRow>): DictationRow =>
  ({ ...row("x"), ...extra }) as DictationRow;

test("date grouping keeps newest-first order and labels days", () => {
  const now = new Date(NOW);
  const rows = [
    r({ id: "a", startedAt: NOW - HOUR }),
    r({ id: "b", startedAt: NOW - 2 * HOUR }),
    r({ id: "c", startedAt: new Date(2026, 9, 15, 23).getTime() }),
    r({ id: "d", startedAt: new Date(2026, 9, 1, 9).getTime() }),
    r({ id: "e", startedAt: new Date(2025, 11, 31, 9).getTime() }),
  ];
  const groups = groupByDay(rows, now);
  assert.deepEqual(
    groups.map((g) => [g.label.split(",")[0], g.rows.map((x) => x.id).join()]),
    [
      ["Today", "a,b"],
      ["Yesterday", "c"],
      [dayLabel(rows[3].startedAt, now).split(",")[0], "d"],
      [dayLabel(rows[4].startedAt, now).split(",")[0], "e"],
    ],
  );
  assert.doesNotMatch(dayLabel(rows[3].startedAt, now), /2026/);
  assert.match(dayLabel(rows[4].startedAt, now), /2025/);
});

test("each row has one status; explanations never repeat the label", () => {
  for (const status of [
    "inserted",
    "copied",
    "rejected",
    "failed",
    "empty",
    "cancelled",
    "transcribing",
  ] as const) {
    const s = statusInfo(r({ status, error: null }));
    assert.ok(s.label);
    assert.notEqual(s.explanation, s.label, status);
    assert.ok(
      !rowMeta(r({ status })).some((m) => m === s.label),
      "meta line doesn't repeat the status",
    );
  }
  assert.equal(statusInfo(r({ status: "inserted" })).explanation, null);
  assert.match(
    statusInfo(r({ status: "rejected", error: "secure-field" })).explanation ??
      "",
    /password field/,
  );
  assert.match(
    statusInfo(r({ status: "copied", error: "target-changed" })).explanation ??
      "",
    /switched apps/,
  );
  assert.deepEqual(rowMeta(r({ appName: "Mail", wordCount: 1 })), [
    "Mail",
    "1 word",
    "4.2 s",
  ]);
});

test("errors are explained in plain words; secrets are redacted from details", () => {
  const failed = (error: string) =>
    friendlyError(r({ status: "failed", error }));
  assert.equal(
    failed("timeout")?.summary,
    "The transcription service didn't answer in time.",
  );
  assert.match(
    failed("HTTP 429 quota")?.summary ?? "",
    /rate limit or credits/,
  );
  assert.match(failed("HTTP 503 x")?.summary ?? "", /problem on its side/);
  assert.match(failed("HTTP 401 bad")?.summary ?? "", /API key/);
  assert.match(
    failed("not-configured: OpenAI API key is not set.")?.summary ?? "",
    /isn't set up/,
  );
  assert.match(failed("fetch failed")?.summary ?? "", /couldn't reach/);
  assert.match(
    failed("audio no longer available")?.summary ?? "",
    /no longer stored/,
  );
  const leaked = failed(
    'HTTP 401 {"error":"Incorrect API key provided: sk-proj-****************abcd"}',
  );
  assert.ok(!leaked?.details?.includes("sk-proj"), leaked?.details ?? "");
  assert.match(redactSecrets("key gsk_abcdef123456 used"), /\[redacted\]/);
  for (const key of [
    "AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q",
    "AQ.FakeTestKq1w2e3r4t5y6u7i8o9p0a_s-d",
  ])
    assert.equal(
      redactSecrets(`API key ${key} is invalid`),
      "API key [redacted] is invalid",
    );
  assert.equal(
    friendlyError(r({ status: "rejected", error: "secure-field" })),
    null,
    "only failures get an error block",
  );
});

test("retry eligibility follows the stored recording", () => {
  const failedWithAudio = retryInfo(r({ status: "failed", hasAudio: true }));
  assert.deepEqual(
    [failedWithAudio.canRetry, failedWithAudio.label],
    [true, "Retry transcription"],
  );
  const expired = retryInfo(r({ status: "failed", hasAudio: false }));
  assert.equal(expired.canRetry, false);
  assert.match(expired.unavailable ?? "", /can't be recovered/);
  const copiedWithAudio = retryInfo(r({ status: "copied", hasAudio: true }));
  assert.deepEqual(
    [copiedWithAudio.canRetry, copiedWithAudio.label],
    [true, "Transcribe again"],
  );
  assert.equal(
    retryInfo(r({ status: "inserted", hasAudio: false })).canRetry,
    false,
  );
  assert.equal(
    retryInfo(r({ status: "inserted", hasAudio: false })).unavailable,
    null,
  );
  assert.equal(
    retryInfo(r({ status: "transcribing", hasAudio: true })).canRetry,
    false,
  );
});

test("too long for the service: friendly error, no retry on the same service until it is switched", () => {
  const long = r({
    status: "failed",
    hasAudio: true,
    provider: "gemini",
    error: "too-long: gemini: this recording is too long",
  });
  assert.match(friendlyError(long)?.summary ?? "", /too long/);
  const same = retryInfo(long, "gemini");
  assert.equal(same.canRetry, false);
  assert.match(same.unavailable ?? "", /Switch the service/);
  assert.equal(retryInfo(long, "openai").canRetry, true);
});

test("previews and transcript versions", () => {
  assert.deepEqual(previewText(r({ finalText: "A\n\nB" })), {
    text: "A B",
    muted: false,
  });
  assert.equal(
    previewText(
      r({ status: "failed", finalText: null, rawText: null, hasAudio: true }),
    ).muted,
    true,
  );
  assert.deepEqual(
    transcriptVersions(r({ rawText: "um hi", finalText: "Hi." })),
    {
      refined: "Hi.",
      raw: "um hi",
      differs: true,
    },
  );
  assert.equal(
    transcriptVersions(r({ rawText: "Hi.", finalText: "Hi." })).differs,
    false,
  );
  const long = "word ".repeat(3000).trim();
  assert.equal(
    transcriptVersions(r({ finalText: long })).refined,
    long,
    "detail view gets the whole transcript",
  );
});

test("formatSeconds never shows 60 of anything", () => {
  assert.equal(formatSeconds(3200), "3.2 s");
  assert.equal(formatSeconds(59940), "59.9 s");
  assert.equal(formatSeconds(59960), "1 min 00 s");
  assert.equal(formatSeconds(60000), "1 min 00 s");
  assert.equal(formatSeconds(119600), "2 min 00 s");
  assert.equal(formatSeconds(125400), "2 min 05 s");
});
