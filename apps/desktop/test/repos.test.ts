import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DictionaryRepo,
  NoteRepo,
  MeetingRepo,
  TransformRepo,
  DuplicateError,
  HistoryDb,
  MIGRATIONS,
  SnippetRepo,
  openDatabase,
} from "../src/main/history/db.ts";
import type { DictationRecord } from "../src/main/core/types.ts";

const tmp = () =>
  join(mkdtempSync(join(tmpdir(), "murmur-repo-")), "db.sqlite");
const row = (
  id: string,
  extra: Partial<DictationRecord> = {},
): DictationRecord => ({
  id,
  startedAt: 1000,
  durationMs: 1500,
  status: "inserted",
  strategy: "clipboard-paste",
  rawText: "um hello",
  finalText: "Hello.",
  wordCount: 1,
  appName: "TextEdit",
  appBundleId: "com.apple.TextEdit",
  error: null,
  provider: "fake",
  hasAudio: false,
  ...extra,
});

test("v1 database migrates to v2 keeping rows; new columns default to null", () => {
  const path = tmp();
  // Build a genuine M1 file: only the first migration applied.
  const v1 = new DatabaseSync(path);
  v1.exec(
    "CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (1);",
  );
  v1.exec(MIGRATIONS[0]);
  v1.prepare(
    "INSERT INTO dictations (id, started_at, duration_ms, status, word_count, has_audio) VALUES ('a', 1, 2, 'inserted', 1, 0)",
  ).run();
  v1.close();
  const v2 = new HistoryDb(path);
  // Every later migration runs too (v3: Scratchpad notes, Stage 9B; v4–v5: Transforms, 9C;
  // v6–v8: Notetaker meetings, recording and its polish, 9D-1 to 9D-3).
  assert.equal(v2.schemaVersion, 8);
  assert.equal(v2.get("a")?.status, "inserted");
  assert.equal(v2.get("a")?.cleanupUsed, null);
  assert.deepEqual(new DictionaryRepo(v2.db).list(), []);
  assert.deepEqual(new NoteRepo(v2.db).list(), []);
  assert.deepEqual(new MeetingRepo(v2.db).list("", "newest"), []);
  assert.deepEqual(
    new TransformRepo(v2.db).list().map((t) => [t.id, t.shortcut, t.builtIn]),
    [
      ["polish", "ctrl+opt+1", true],
      ["prompt-engineer", "ctrl+opt+2", true],
    ],
  );
  v2.close();
});

test("history search is case-insensitive, matches raw or final text, escapes LIKE wildcards", () => {
  const db = new HistoryDb(tmp());
  db.insert(
    row("a", {
      startedAt: 1,
      finalText: "Deploy NestJS tonight.",
      rawText: "deploy nest js tonight",
    }),
  );
  db.insert(
    row("b", {
      startedAt: 2,
      finalText: "100% done.",
      rawText: "hundred percent done",
    }),
  );
  db.insert(
    row("c", {
      startedAt: 3,
      finalText: "Salom O‘zbekiston.",
      rawText: "salom o'zbekiston",
    }),
  );
  assert.deepEqual(
    db.list({ search: "nestjs" }).map((r) => r.id),
    ["a"],
  );
  assert.deepEqual(
    db.list({ search: "nest js" }).map((r) => r.id),
    ["a"],
    "raw text is searched too",
  );
  assert.deepEqual(
    db.list({ search: "100%" }).map((r) => r.id),
    ["b"],
  );
  assert.deepEqual(
    db.list({ search: "%" }).map((r) => r.id),
    ["b"],
    "wildcard is literal",
  );
  assert.deepEqual(
    db.list({ search: "o‘zbek" }).map((r) => r.id),
    ["c"],
  );
  assert.deepEqual(
    db.list({ status: "inserted", limit: 2 }).map((r) => r.id),
    ["c", "b"],
  );
  assert.deepEqual(db.olderThan(0, 3), ["a", "b"]);
  db.close();
});

test("deleteMany removes all rows in one transaction with one WAL checkpoint", () => {
  const db = new HistoryDb(tmp());
  for (const id of ["a", "b", "c", "d"]) db.insert(row(id));
  const statements: string[] = [];
  const exec = db.db.exec.bind(db.db);
  db.db.exec = (sql: string) => (statements.push(sql), exec(sql));
  assert.equal(db.deleteMany(["a", "b", "c", "zzz"]), 3);
  assert.equal(statements.filter((q) => /wal_checkpoint/.test(q)).length, 1);
  assert.equal(statements.filter((q) => q === "BEGIN").length, 1);
  assert.deepEqual(
    db.list({}).map((r) => r.id),
    ["d"],
  );
  assert.equal(db.deleteMany([]), 0);
  db.close();
});

test("dictionary repo: add, duplicate detection (case/space-insensitive), update, search, delete, import", () => {
  const dict = new DictionaryRepo(openDatabase(tmp()));
  const a = dict.add({ id: "1", phrase: "  Bill   of Lading " });
  assert.equal(a.phrase, "Bill of Lading");
  assert.throws(
    () => dict.add({ id: "2", phrase: "bill of lading" }),
    DuplicateError,
  );
  assert.throws(() => dict.add({ id: "2", phrase: "x" }), /at least 2/);
  dict.add({ id: "2", phrase: "ELD", misheardAs: "yield" });
  dict.add({ id: "3", phrase: "O‘zbekiston" });
  assert.deepEqual(
    dict.list().map((e) => e.phrase),
    ["Bill of Lading", "ELD", "O‘zbekiston"],
  );
  assert.deepEqual(
    dict.list("yie").map((e) => e.id),
    ["2"],
    "search covers misheard spellings",
  );
  assert.deepEqual(
    dict.list("o‘zbek").map((e) => e.id),
    ["3"],
  );
  assert.equal(
    dict.update("2", { misheardAs: "yields", enabled: false })?.enabled,
    false,
  );
  assert.throws(
    () => dict.update("2", { phrase: "bill of lading" }),
    DuplicateError,
  );
  assert.equal(dict.update("missing", { phrase: "x y" }), null);
  dict.bumpUsage({ "1": 2 });
  assert.equal(dict.get("1")?.usageCount, 2);
  let n = 10;
  assert.deepEqual(
    dict.importMany(
      [
        { phrase: "Samsara" },
        { phrase: "ELD" },
        { phrase: "Macropoint", misheardAs: "macro point" },
      ],
      () => String(n++),
    ),
    { added: 2, skipped: 1 },
  );
  assert.equal(dict.delete("1"), true);
  assert.equal(dict.delete("1"), false);
});

test("snippet repo: add, duplicate trigger, enable/disable, update, search, delete", () => {
  const snips = new SnippetRepo(openDatabase(tmp()));
  snips.add({ id: "1", trigger: "my email", replacement: "r@example.com" });
  assert.throws(
    () => snips.add({ id: "2", trigger: "My  Email", replacement: "x" }),
    DuplicateError,
  );
  assert.throws(
    () => snips.add({ id: "2", trigger: "sig", replacement: "  " }),
    /replacement/,
  );
  snips.add({
    id: "2",
    trigger: "my signature",
    replacement: "Best,\nR",
    enabled: false,
  });
  assert.deepEqual(
    snips.list().map((s) => [s.trigger, s.enabled]),
    [
      ["my email", true],
      ["my signature", false],
    ],
  );
  assert.deepEqual(
    snips.list("best").map((s) => s.id),
    ["2"],
  );
  assert.equal(snips.update("2", { enabled: true })?.enabled, true);
  assert.throws(
    () => snips.update("2", { trigger: "my email" }),
    DuplicateError,
  );
  assert.equal(snips.findByTrigger("MY EMAIL")?.id, "1");
  assert.equal(snips.delete("1"), true);
  assert.equal(snips.list().length, 1);
});

test("deleting a dictation leaves none of its text in the write-ahead log", () => {
  const path = tmp();
  const h = new HistoryDb(path);
  h.insert(
    row("a", { rawText: "secret-wal-words", finalText: "secret-wal-words" }),
  );
  assert.equal(h.delete("a"), true);
  const wal = `${path}-wal`;
  assert.equal(existsSync(wal) ? statSync(wal).size : 0, 0);
});

test("dictionary and snippet search fold case beyond ASCII", () => {
  const db = openDatabase(tmp());
  const dict = new DictionaryRepo(db);
  dict.add({ id: "1", phrase: "Österreich", misheardAs: "ÉCOLE" });
  assert.deepEqual(
    dict.list("österreich").map((e) => e.id),
    ["1"],
  );
  assert.deepEqual(
    dict.list("école").map((e) => e.id),
    ["1"],
  );
  const snips = new SnippetRepo(db);
  snips.add({ id: "s", trigger: "Привет", replacement: "ПОКА" });
  assert.deepEqual(
    snips.list("привет").map((e) => e.id),
    ["s"],
  );
  assert.deepEqual(
    snips.list("пока").map((e) => e.id),
    ["s"],
  );
  assert.deepEqual(
    snips.list("100%").map((e) => e.id),
    [],
  );
});
