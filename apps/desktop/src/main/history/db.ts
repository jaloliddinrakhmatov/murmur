// Local database in SQLite via node:sqlite (bundled with Electron's Node; no native rebuild).
// One file holds History, the Dictionary and Snippets; each has its own repository below.
import type { InsightRow } from "../../shared/insights.ts";
import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type {
  DictionaryRecord,
  DictationRecord,
  HistoryPort,
  SnippetRecord,
} from "../core/types.ts";
import { countWords } from "@murmur/text";
import {
  dayStreak,
  speakingWpm,
  WEEK_MS,
  type HistoryStats,
} from "../../shared/stats.ts";
import { searchKey } from "../../shared/search.ts";
import type { Note, SaveResult } from "../../shared/notes.ts";
import type {
  Meeting,
  MeetingSaveResult,
  MeetingSort,
  MeetingStatus,
} from "../../shared/meetings.ts";
import {
  DEFAULT_TRANSFORMS,
  nameKey,
  type PolishRules,
  type Transform,
} from "../../shared/transforms.ts";

export const MIGRATIONS: string[] = [
  `CREATE TABLE dictations (
     id TEXT PRIMARY KEY,
     started_at INTEGER NOT NULL,
     duration_ms INTEGER NOT NULL,
     status TEXT NOT NULL,
     strategy TEXT,
     raw_text TEXT,
     final_text TEXT,
     word_count INTEGER NOT NULL DEFAULT 0,
     app_name TEXT,
     app_bundle_id TEXT,
     error TEXT,
     provider TEXT,
     has_audio INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX dictations_started_at ON dictations(started_at DESC);`,
  // M2: cleanup provenance on history rows; dictionary and snippets.
  `ALTER TABLE dictations ADD COLUMN cleanup_used TEXT;
   ALTER TABLE dictations ADD COLUMN cleanup_note TEXT;
   ALTER TABLE dictations ADD COLUMN ai_rejected_text TEXT;
   CREATE TABLE dictionary_entries (
     id TEXT PRIMARY KEY,
     phrase TEXT NOT NULL,
     phrase_key TEXT NOT NULL UNIQUE,
     misheard_as TEXT,
     enabled INTEGER NOT NULL DEFAULT 1,
     usage_count INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE snippets (
     id TEXT PRIMARY KEY,
     trigger TEXT NOT NULL,
     trigger_key TEXT NOT NULL UNIQUE,
     replacement TEXT NOT NULL,
     enabled INTEGER NOT NULL DEFAULT 1,
     usage_count INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );`,
  // Stage 9B: Scratchpad notes. `revision` refuses saves based on an older copy.
  `CREATE TABLE notes (
     id TEXT PRIMARY KEY,
     title TEXT,
     body TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     opened_at INTEGER NOT NULL,
     revision INTEGER NOT NULL DEFAULT 1
   );
   CREATE INDEX notes_updated_at ON notes(updated_at DESC);`,
  // Stage 9C: Transforms. The two built-ins are seeded once, here; "Reset to defaults" restores
  // them, and deleting custom ones never brings anything back on its own.
  `CREATE TABLE transforms (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     name TEXT NOT NULL,
     name_key TEXT NOT NULL UNIQUE,
     description TEXT NOT NULL DEFAULT '',
     prompt TEXT NOT NULL DEFAULT '',
     rules TEXT,
     shortcut TEXT,
     position INTEGER NOT NULL,
     built_in INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   ${DEFAULT_TRANSFORMS.map(
     (t) =>
       `INSERT INTO transforms (id, kind, name, name_key, description, prompt, rules, shortcut, position, built_in, created_at, updated_at) VALUES (${[
         t.id,
         t.kind,
         t.name,
         nameKey(t.name),
         t.description,
         t.prompt,
         t.rules ? JSON.stringify(t.rules) : null,
         t.shortcut,
       ]
         .map(sqlLiteral)
         .join(", ")}, ${t.position}, 1, 0, 0);`,
   ).join("\n")}`,
  // Stage 9C fix: ⌥1 and ⌥2 can't be registered without Input Monitoring; the built-ins still on
  // those move to ⌃⌥1 and ⌃⌥2 (a shortcut you chose yourself is left alone).
  `UPDATE transforms SET shortcut = 'ctrl+opt+1' WHERE id = 'polish' AND shortcut = 'opt+1';
   UPDATE transforms SET shortcut = 'ctrl+opt+2' WHERE id = 'prompt-engineer' AND shortcut = 'opt+2';`,
  // Stage 9D-1: Notetaker meetings (your notes and times; transcript and summary come later).
  `CREATE TABLE meetings (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     notes TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'notes',
     started_at INTEGER,
     ended_at INTEGER,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     revision INTEGER NOT NULL DEFAULT 1,
     has_transcript INTEGER NOT NULL DEFAULT 0,
     has_summary INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX meetings_time ON meetings(coalesce(started_at, created_at) DESC);`,
  // Stage 9D-2: meeting recording, transcript and summary.
  `ALTER TABLE meetings ADD COLUMN transcript TEXT NOT NULL DEFAULT '';
   ALTER TABLE meetings ADD COLUMN summary TEXT NOT NULL DEFAULT '';
   ALTER TABLE meetings ADD COLUMN recorded_ms INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE meetings ADD COLUMN audio_parts INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE meetings ADD COLUMN system_audio INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE meetings ADD COLUMN error TEXT;`,
  // Stage 9D-3: a language per meeting, You / Others tracks, and resumable transcription.
  `ALTER TABLE meetings ADD COLUMN language TEXT;
   ALTER TABLE meetings ADD COLUMN audio_layout TEXT NOT NULL DEFAULT 'mixed';
   ALTER TABLE meetings ADD COLUMN batches TEXT NOT NULL DEFAULT '[]';`,
];

/** For the seed statements above only (constant, trusted values). */
function sqlLiteral(v: string | null): string {
  return v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`;
}

const COLUMNS: Record<keyof DictationRecord, string> = {
  id: "id",
  startedAt: "started_at",
  durationMs: "duration_ms",
  status: "status",
  strategy: "strategy",
  rawText: "raw_text",
  finalText: "final_text",
  wordCount: "word_count",
  appName: "app_name",
  appBundleId: "app_bundle_id",
  error: "error",
  provider: "provider",
  hasAudio: "has_audio",
  cleanupUsed: "cleanup_used",
  cleanupNote: "cleanup_note",
  aiRejectedText: "ai_rejected_text",
};

type Row = Record<string, string | number | null>;

function toRecord(r: Row): DictationRecord {
  return {
    id: r.id as string,
    startedAt: r.started_at as number,
    durationMs: r.duration_ms as number,
    status: r.status as DictationRecord["status"],
    strategy: (r.strategy as string) ?? null,
    rawText: (r.raw_text as string) ?? null,
    finalText: (r.final_text as string) ?? null,
    wordCount: r.word_count as number,
    appName: (r.app_name as string) ?? null,
    appBundleId: (r.app_bundle_id as string) ?? null,
    error: (r.error as string) ?? null,
    provider: (r.provider as string) ?? null,
    hasAudio: r.has_audio === 1,
    cleanupUsed: (r.cleanup_used as DictationRecord["cleanupUsed"]) ?? null,
    cleanupNote: (r.cleanup_note as string) ?? null,
    aiRejectedText: (r.ai_rejected_text as string) ?? null,
  };
}

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  // Unicode-aware search: SQLite's LIKE/NOCASE only fold ASCII. Same key as the renderer uses.
  db.function("murmur_fold", { deterministic: true }, (s) =>
    typeof s === "string" ? searchKey(s) : null,
  );
  // secure_delete: deleted dictations are overwritten, not left in free pages.
  db.exec(
    "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;",
  );
  if (path !== ":memory:") chmodSync(path, 0o600);
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)",
  );
  const row = db.prepare("SELECT version FROM schema_version").get() as
    { version: number } | undefined;
  let version = row?.version ?? 0;
  for (; version < MIGRATIONS.length; version++) {
    db.exec("BEGIN");
    db.exec(MIGRATIONS[version]);
    db.exec("DELETE FROM schema_version");
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(
      version + 1,
    );
    db.exec("COMMIT");
  }
  return db;
}

export interface HistoryQuery {
  /** Matches the refined text, the raw transcript or the app name; Unicode case-insensitive. */
  search?: string;
  limit?: number;
  status?: DictationRecord["status"];
  /** Any of these statuses (combined with `status` when both are given). */
  statuses?: DictationRecord["status"][];
  /** Newest first (default) or oldest first; ties break on id, so paging is stable. */
  order?: "newest" | "oldest";
}

export class HistoryDb implements HistoryPort {
  readonly db: DatabaseSync;

  constructor(pathOrDb: string | DatabaseSync) {
    this.db = typeof pathOrDb === "string" ? openDatabase(pathOrDb) : pathOrDb;
  }

  get schemaVersion(): number {
    return (
      this.db.prepare("SELECT version FROM schema_version").get() as {
        version: number;
      }
    ).version;
  }

  insert(row: DictationRecord): void {
    this.db
      .prepare(
        `INSERT INTO dictations (id, started_at, duration_ms, status, strategy, raw_text, final_text, word_count, app_name, app_bundle_id, error, provider, has_audio, cleanup_used, cleanup_note, ai_rejected_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.startedAt,
        row.durationMs,
        row.status,
        row.strategy,
        row.rawText,
        row.finalText,
        row.wordCount,
        row.appName,
        row.appBundleId,
        row.error,
        row.provider,
        row.hasAudio ? 1 : 0,
        row.cleanupUsed ?? null,
        row.cleanupNote ?? null,
        row.aiRejectedText ?? null,
      );
  }

  update(id: string, patch: Partial<DictationRecord>): void {
    const entries = Object.entries(patch).filter(
      ([k]) => k !== "id" && k in COLUMNS,
    );
    if (entries.length === 0) return;
    const sets = entries
      .map(([k]) => `${COLUMNS[k as keyof DictationRecord]} = ?`)
      .join(", ");
    const values = entries.map(([, v]) =>
      typeof v === "boolean" ? (v ? 1 : 0) : (v ?? null),
    );
    this.db
      .prepare(`UPDATE dictations SET ${sets} WHERE id = ?`)
      .run(...values, id);
  }

  get(id: string): DictationRecord | null {
    const row = this.db
      .prepare("SELECT * FROM dictations WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  private filter(q: HistoryQuery): { sql: string; params: string[] } {
    const where: string[] = [];
    const params: string[] = [];
    const key = q.search ? searchKey(q.search) : "";
    if (key) {
      // instr() takes the text literally, so % and _ in a query need no escaping.
      where.push(
        "(instr(murmur_fold(coalesce(final_text, '')), ?) > 0 OR instr(murmur_fold(coalesce(raw_text, '')), ?) > 0 OR instr(murmur_fold(coalesce(app_name, '')), ?) > 0)",
      );
      params.push(key, key, key);
    }
    if (q.status) {
      where.push("status = ?");
      params.push(q.status);
    }
    if (q.statuses?.length) {
      where.push(`status IN (${q.statuses.map(() => "?").join(", ")})`);
      params.push(...q.statuses);
    }
    return {
      sql: where.length ? `WHERE ${where.join(" AND ")}` : "",
      params,
    };
  }

  /** Newest first. See `HistoryQuery` for matching rules. */
  list(query: HistoryQuery | number = {}): DictationRecord[] {
    const q = typeof query === "number" ? { limit: query } : query;
    const { sql, params } = this.filter(q);
    return (
      this.db
        .prepare(
          q.order === "oldest"
            ? `SELECT * FROM dictations ${sql} ORDER BY started_at ASC, id ASC LIMIT ?`
            : `SELECT * FROM dictations ${sql} ORDER BY started_at DESC, id DESC LIMIT ?`,
        )
        .all(...params, q.limit ?? 500) as Row[]
    ).map(toRecord);
  }

  /** How many rows match, ignoring `limit` (for "Show more"). */
  count(query: HistoryQuery = {}): number {
    const { sql, params } = this.filter(query);
    return Number(
      (
        this.db
          .prepare(`SELECT COUNT(*) AS n FROM dictations ${sql}`)
          .get(...params) as { n: number }
      ).n,
    );
  }

  /** Words delivered in [from, to): the daily count the account reports (a number, never text). */
  wordsBetween(from: number, to: number): number {
    const r = this.db
      .prepare(
        `SELECT COALESCE(SUM(word_count), 0) AS words FROM dictations
         WHERE status IN ('inserted', 'copied') AND final_text IS NOT NULL AND word_count > 0
           AND started_at >= ? AND started_at < ?`,
      )
      .get(from, to) as { words: number };
    return Number(r.words);
  }

  /** Home screen totals over delivered dictations (inserted or copied, with text). */
  stats(now = Date.now()): HistoryStats {
    const weekStart = now - WEEK_MS;
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS dictations,
                COALESCE(SUM(word_count), 0) AS words,
                COALESCE(SUM(duration_ms), 0) AS speaking_ms,
                MIN(started_at) AS first_at,
                COALESCE(SUM(started_at >= ?), 0) AS week_dictations,
                COALESCE(SUM(CASE WHEN started_at >= ? THEN word_count ELSE 0 END), 0) AS week_words
         FROM dictations
         WHERE status IN ('inserted', 'copied') AND final_text IS NOT NULL AND word_count > 0`,
      )
      .get(weekStart, weekStart) as Record<string, number | null>;
    // Speed and streak are derived from the same delivered rows on every call, so deletions,
    // retention and time-zone changes are reflected without any stored counter.
    const delivered = this.db
      .prepare(
        `SELECT started_at, duration_ms, raw_text FROM dictations
         WHERE status IN ('inserted', 'copied') AND final_text IS NOT NULL AND word_count > 0`,
      )
      .all() as {
      started_at: number;
      duration_ms: number;
      raw_text: string | null;
    }[];
    return {
      dictations: Number(r.dictations),
      words: Number(r.words),
      speakingMs: Number(r.speaking_ms),
      firstAt: r.first_at === null ? null : Number(r.first_at),
      lastWeek: {
        dictations: Number(r.week_dictations),
        words: Number(r.week_words),
      },
      wpm: speakingWpm(
        delivered.map((d) => ({
          spokenWords: d.raw_text ? countWords(d.raw_text) : 0,
          durationMs: Number(d.duration_ms),
        })),
      ),
      streakDays: dayStreak(
        delivered.map((d) => Number(d.started_at)),
        now,
      ),
    };
  }

  /** Deletes a dictation, and flushes the write-ahead log so its text doesn't linger there. */
  delete(id: string): boolean {
    const deleted =
      this.db.prepare("DELETE FROM dictations WHERE id = ?").run(id).changes >
      0;
    if (deleted) this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return deleted;
  }

  /** Deletes several dictations in one transaction with one log flush (the retention purge). */
  deleteMany(ids: readonly string[]): number {
    if (ids.length === 0) return 0;
    const stmt = this.db.prepare("DELETE FROM dictations WHERE id = ?");
    let deleted = 0;
    this.db.exec("BEGIN");
    try {
      for (const id of ids) deleted += Number(stmt.run(id).changes);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    if (deleted) this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return deleted;
  }

  /** Deletes every dictation, and flushes the write-ahead log so nothing lingers there. */
  clear(): void {
    this.db.exec("DELETE FROM dictations");
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  /** Delivered dictations, oldest first, for Insights (Stage 9A). */
  insightRows(): InsightRow[] {
    const rows = this.db
      .prepare(
        `SELECT started_at, duration_ms, raw_text, final_text, word_count, app_name, app_bundle_id
         FROM dictations
         WHERE status IN ('inserted', 'copied') AND final_text IS NOT NULL AND word_count > 0
         ORDER BY started_at, id`,
      )
      .all() as Record<string, string | number | null>[];
    return rows.map((r) => ({
      startedAt: Number(r.started_at),
      durationMs: Number(r.duration_ms),
      rawText: (r.raw_text as string | null) ?? null,
      finalText: (r.final_text as string | null) ?? null,
      wordCount: Number(r.word_count),
      appName: (r.app_name as string | null) ?? null,
      appBundleId: (r.app_bundle_id as string | null) ?? null,
    }));
  }

  /** Ids whose audio is older than the retention window (so the vault can purge them). */
  audioOlderThan(ms: number, now = Date.now()): string[] {
    return (
      this.db
        .prepare(
          "SELECT id FROM dictations WHERE has_audio = 1 AND started_at < ? ORDER BY started_at",
        )
        .all(now - ms) as { id: string }[]
    ).map((r) => r.id);
  }

  /** Ids of rows older than the retention window (so rows and their audio can be deleted together). */
  olderThan(ms: number, now = Date.now()): string[] {
    return (
      this.db
        .prepare(
          "SELECT id FROM dictations WHERE started_at < ? ORDER BY started_at",
        )
        .all(now - ms) as { id: string }[]
    ).map((r) => r.id);
  }

  close(): void {
    this.db.close();
  }
}

export const keyOf = (s: string) =>
  s.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();

type DictRow = {
  id: string;
  phrase: string;
  misheard_as: string | null;
  enabled: number;
  usage_count: number;
  created_at: number;
  updated_at: number;
};

const toDictionary = (r: DictRow): DictionaryRecord => ({
  id: r.id,
  phrase: r.phrase,
  misheardAs: r.misheard_as,
  enabled: r.enabled === 1,
  usageCount: r.usage_count,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class DuplicateError extends Error {
  constructor(what: string) {
    super(`${what} already exists`);
    this.name = "DuplicateError";
  }
}

export class DictionaryRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  list(search = ""): DictionaryRecord[] {
    const rows = search.trim()
      ? (this.db
          .prepare(
            "SELECT * FROM dictionary_entries WHERE instr(murmur_fold(phrase), ?) > 0 OR instr(murmur_fold(misheard_as), ?) > 0 ORDER BY phrase COLLATE NOCASE",
          )
          .all(...Array(2).fill(searchKey(search))) as DictRow[])
      : (this.db
          .prepare(
            "SELECT * FROM dictionary_entries ORDER BY phrase COLLATE NOCASE",
          )
          .all() as DictRow[]);
    return rows.map(toDictionary);
  }

  get(id: string): DictionaryRecord | null {
    const row = this.db
      .prepare("SELECT * FROM dictionary_entries WHERE id = ?")
      .get(id) as DictRow | undefined;
    return row ? toDictionary(row) : null;
  }

  findByPhrase(phrase: string): DictionaryRecord | null {
    const row = this.db
      .prepare("SELECT * FROM dictionary_entries WHERE phrase_key = ?")
      .get(keyOf(phrase)) as DictRow | undefined;
    return row ? toDictionary(row) : null;
  }

  add(
    entry: {
      id: string;
      phrase: string;
      misheardAs?: string | null;
      enabled?: boolean;
    },
    now = Date.now(),
  ): DictionaryRecord {
    const phrase = entry.phrase.normalize("NFC").trim().replace(/\s+/g, " ");
    if (phrase.length < 2)
      throw new Error("phrase must be at least 2 characters");
    if (this.findByPhrase(phrase)) throw new DuplicateError(`"${phrase}"`);
    const misheard =
      entry.misheardAs?.normalize("NFC").trim().replace(/\s+/g, " ") || null;
    this.db
      .prepare(
        "INSERT INTO dictionary_entries (id, phrase, phrase_key, misheard_as, enabled, usage_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
      )
      .run(
        entry.id,
        phrase,
        keyOf(phrase),
        misheard,
        entry.enabled === false ? 0 : 1,
        now,
        now,
      );
    return this.get(entry.id)!;
  }

  update(
    id: string,
    patch: { phrase?: string; misheardAs?: string | null; enabled?: boolean },
    now = Date.now(),
  ): DictionaryRecord | null {
    const current = this.get(id);
    if (!current) return null;
    const phrase = (patch.phrase ?? current.phrase)
      .normalize("NFC")
      .trim()
      .replace(/\s+/g, " ");
    if (phrase.length < 2)
      throw new Error("phrase must be at least 2 characters");
    const clash = this.findByPhrase(phrase);
    if (clash && clash.id !== id) throw new DuplicateError(`"${phrase}"`);
    const misheard =
      patch.misheardAs === undefined
        ? current.misheardAs
        : patch.misheardAs?.normalize("NFC").trim().replace(/\s+/g, " ") ||
          null;
    this.db
      .prepare(
        "UPDATE dictionary_entries SET phrase = ?, phrase_key = ?, misheard_as = ?, enabled = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        phrase,
        keyOf(phrase),
        misheard,
        (patch.enabled ?? current.enabled) ? 1 : 0,
        now,
        id,
      );
    return this.get(id);
  }

  delete(id: string): boolean {
    return (
      this.db.prepare("DELETE FROM dictionary_entries WHERE id = ?").run(id)
        .changes > 0
    );
  }

  bumpUsage(hits: Record<string, number>): void {
    const stmt = this.db.prepare(
      "UPDATE dictionary_entries SET usage_count = usage_count + ? WHERE id = ?",
    );
    for (const [id, n] of Object.entries(hits)) stmt.run(n, id);
  }

  /** Adds entries that do not clash; returns counts. */
  importMany(
    entries: { phrase: string; misheardAs?: string | null }[],
    newId: () => string,
  ): { added: number; skipped: number } {
    let added = 0;
    let skipped = 0;
    for (const e of entries) {
      try {
        this.add({ id: newId(), phrase: e.phrase, misheardAs: e.misheardAs });
        added++;
      } catch {
        skipped++;
      }
    }
    return { added, skipped };
  }
}

type SnippetRow = {
  id: string;
  trigger: string;
  replacement: string;
  enabled: number;
  usage_count: number;
  created_at: number;
  updated_at: number;
};

const toSnippet = (r: SnippetRow): SnippetRecord => ({
  id: r.id,
  trigger: r.trigger,
  replacement: r.replacement,
  enabled: r.enabled === 1,
  usageCount: r.usage_count,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class SnippetRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  list(search = ""): SnippetRecord[] {
    const rows = search.trim()
      ? (this.db
          .prepare(
            "SELECT * FROM snippets WHERE instr(murmur_fold(trigger), ?) > 0 OR instr(murmur_fold(replacement), ?) > 0 ORDER BY trigger COLLATE NOCASE",
          )
          .all(...Array(2).fill(searchKey(search))) as SnippetRow[])
      : (this.db
          .prepare("SELECT * FROM snippets ORDER BY trigger COLLATE NOCASE")
          .all() as SnippetRow[]);
    return rows.map(toSnippet);
  }

  get(id: string): SnippetRecord | null {
    const row = this.db
      .prepare("SELECT * FROM snippets WHERE id = ?")
      .get(id) as SnippetRow | undefined;
    return row ? toSnippet(row) : null;
  }

  findByTrigger(trigger: string): SnippetRecord | null {
    const row = this.db
      .prepare("SELECT * FROM snippets WHERE trigger_key = ?")
      .get(keyOf(trigger)) as SnippetRow | undefined;
    return row ? toSnippet(row) : null;
  }

  add(
    snippet: {
      id: string;
      trigger: string;
      replacement: string;
      enabled?: boolean;
    },
    now = Date.now(),
  ): SnippetRecord {
    const trigger = snippet.trigger
      .normalize("NFC")
      .trim()
      .replace(/\s+/g, " ");
    if (!trigger) throw new Error("trigger is required");
    if (!snippet.replacement.trim()) throw new Error("replacement is required");
    if (this.findByTrigger(trigger))
      throw new DuplicateError(`trigger "${trigger}"`);
    this.db
      .prepare(
        "INSERT INTO snippets (id, trigger, trigger_key, replacement, enabled, usage_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
      )
      .run(
        snippet.id,
        trigger,
        keyOf(trigger),
        snippet.replacement,
        snippet.enabled === false ? 0 : 1,
        now,
        now,
      );
    return this.get(snippet.id)!;
  }

  update(
    id: string,
    patch: { trigger?: string; replacement?: string; enabled?: boolean },
    now = Date.now(),
  ): SnippetRecord | null {
    const current = this.get(id);
    if (!current) return null;
    const trigger = (patch.trigger ?? current.trigger)
      .normalize("NFC")
      .trim()
      .replace(/\s+/g, " ");
    if (!trigger) throw new Error("trigger is required");
    const replacement = patch.replacement ?? current.replacement;
    if (!replacement.trim()) throw new Error("replacement is required");
    const clash = this.findByTrigger(trigger);
    if (clash && clash.id !== id)
      throw new DuplicateError(`trigger "${trigger}"`);
    this.db
      .prepare(
        "UPDATE snippets SET trigger = ?, trigger_key = ?, replacement = ?, enabled = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        trigger,
        keyOf(trigger),
        replacement,
        (patch.enabled ?? current.enabled) ? 1 : 0,
        now,
        id,
      );
    return this.get(id);
  }

  delete(id: string): boolean {
    return (
      this.db.prepare("DELETE FROM snippets WHERE id = ?").run(id).changes > 0
    );
  }

  bumpUsage(hits: Record<string, number>): void {
    const stmt = this.db.prepare(
      "UPDATE snippets SET usage_count = usage_count + ? WHERE id = ?",
    );
    for (const [id, n] of Object.entries(hits)) stmt.run(n, id);
  }
}

type NoteDbRow = {
  id: string;
  title: string | null;
  body: string;
  created_at: number;
  updated_at: number;
  opened_at: number;
  revision: number;
};

const toNote = (r: NoteDbRow): Note => ({
  id: r.id,
  title: r.title,
  body: r.body,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
  openedAt: Number(r.opened_at),
  revision: Number(r.revision),
});

/** Scratchpad notes (Stage 9B). Plain text; secure_delete overwrites deleted notes. */
export class NoteRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Most recently edited first; `search` matches title or text, Unicode case-insensitive. */
  list(search = ""): Note[] {
    const key = searchKey(search);
    const rows = key
      ? this.db
          .prepare(
            "SELECT * FROM notes WHERE instr(murmur_fold(coalesce(title, '')), ?) > 0 OR instr(murmur_fold(body), ?) > 0 ORDER BY updated_at DESC, id",
          )
          .all(key, key)
      : this.db
          .prepare("SELECT * FROM notes ORDER BY updated_at DESC, id")
          .all();
    return (rows as NoteDbRow[]).map(toNote);
  }

  get(id: string): Note | null {
    const row = this.db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as
      NoteDbRow | undefined;
    return row ? toNote(row) : null;
  }

  /** The note opened most recently ("Resume last note"). */
  lastOpened(): Note | null {
    const row = this.db
      .prepare("SELECT * FROM notes ORDER BY opened_at DESC, id LIMIT 1")
      .get() as NoteDbRow | undefined;
    return row ? toNote(row) : null;
  }

  create(id: string, body: string, now = Date.now()): Note {
    this.db
      .prepare(
        "INSERT INTO notes (id, title, body, created_at, updated_at, opened_at, revision) VALUES (?, NULL, ?, ?, ?, ?, 1)",
      )
      .run(id, body, now, now, now);
    return this.get(id)!;
  }

  /** Saves only on top of the revision the editor last saw, so an older copy never wins. */
  save(
    id: string,
    body: string,
    revision: number,
    now = Date.now(),
  ): SaveResult {
    const r = this.db
      .prepare(
        "UPDATE notes SET body = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?",
      )
      .run(body, now, id, revision);
    const note = this.get(id);
    if (!note) return { ok: false, reason: "missing" };
    if (Number(r.changes) === 0) return { ok: false, reason: "conflict", note };
    return { ok: true, note };
  }

  rename(id: string, title: string, now = Date.now()): Note | null {
    const clean = title.normalize("NFC").replace(/\s+/g, " ").trim();
    this.db
      .prepare(
        // The title only: the editor's revision (its copy of the text) stays valid.
        "UPDATE notes SET title = ?, updated_at = ? WHERE id = ?",
      )
      .run(clean || null, now, id);
    return this.get(id);
  }

  markOpened(id: string, now = Date.now()): void {
    this.db.prepare("UPDATE notes SET opened_at = ? WHERE id = ?").run(now, id);
  }

  /**
   * Deleted text must not survive in the write-ahead log either: secure_delete clears the
   * database pages, the checkpoint clears the log copies of earlier versions.
   */
  delete(id: string): boolean {
    const n = Number(
      this.db.prepare("DELETE FROM notes WHERE id = ?").run(id).changes,
    );
    if (n) this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return n > 0;
  }

  deleteAll(): number {
    const n = Number(this.db.prepare("DELETE FROM notes").run().changes);
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return n;
  }

  /** For lists: like `list`, with only the first 2,000 characters of each note. */
  summaries(search = ""): Note[] {
    const key = searchKey(search);
    const cols =
      "id, title, substr(body, 1, 2000) AS body, created_at, updated_at, opened_at, revision";
    const rows = key
      ? this.db
          .prepare(
            `SELECT ${cols} FROM notes WHERE instr(murmur_fold(coalesce(title, '')), ?) > 0 OR instr(murmur_fold(body), ?) > 0 ORDER BY updated_at DESC, id`,
          )
          .all(key, key)
      : this.db
          .prepare(`SELECT ${cols} FROM notes ORDER BY updated_at DESC, id`)
          .all();
    return (rows as NoteDbRow[]).map(toNote);
  }
}

type TransformRow = {
  id: string;
  kind: Transform["kind"];
  name: string;
  description: string;
  prompt: string;
  rules: string | null;
  shortcut: string | null;
  position: number;
  built_in: number;
  created_at: number;
  updated_at: number;
};

const toTransform = (r: TransformRow): Transform => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  description: r.description,
  prompt: r.prompt,
  rules: r.rules ? (JSON.parse(r.rules) as PolishRules) : null,
  shortcut: r.shortcut,
  position: Number(r.position),
  builtIn: Number(r.built_in) === 1,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

const cleanName = (name: string) =>
  name.normalize("NFC").trim().replace(/\s+/g, " ");

/** Transforms (Stage 9C): names are unique ignoring case and spacing. */
export class TransformRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  list(search = ""): Transform[] {
    const key = searchKey(search);
    const rows = key
      ? this.db
          .prepare(
            "SELECT * FROM transforms WHERE instr(murmur_fold(name), ?) > 0 OR instr(murmur_fold(description), ?) > 0 OR instr(murmur_fold(prompt), ?) > 0 ORDER BY position, created_at, id",
          )
          .all(key, key, key)
      : this.db
          .prepare("SELECT * FROM transforms ORDER BY position, created_at, id")
          .all();
    return (rows as TransformRow[]).map(toTransform);
  }

  get(id: string): Transform | null {
    const row = this.db
      .prepare("SELECT * FROM transforms WHERE id = ?")
      .get(id) as TransformRow | undefined;
    return row ? toTransform(row) : null;
  }

  findByName(name: string): Transform | null {
    const row = this.db
      .prepare("SELECT * FROM transforms WHERE name_key = ?")
      .get(nameKey(name)) as TransformRow | undefined;
    return row ? toTransform(row) : null;
  }

  create(
    t: { id: string; name: string; description: string; prompt: string },
    now = Date.now(),
  ): Transform {
    const name = cleanName(t.name);
    if (this.findByName(name))
      throw new DuplicateError(`A transform named "${name}"`);
    const { p } = this.db
      .prepare("SELECT max(position) AS p FROM transforms")
      .get() as { p: number | null };
    this.db
      .prepare(
        "INSERT INTO transforms (id, kind, name, name_key, description, prompt, rules, shortcut, position, built_in, created_at, updated_at) VALUES (?, 'custom', ?, ?, ?, ?, NULL, NULL, ?, 0, ?, ?)",
      )
      .run(
        t.id,
        name,
        nameKey(name),
        t.description.trim(),
        t.prompt.trim(),
        Number(p ?? -1) + 1,
        now,
        now,
      );
    return this.get(t.id)!;
  }

  update(
    id: string,
    patch: {
      name?: string;
      description?: string;
      prompt?: string;
      rules?: PolishRules;
    },
    now = Date.now(),
  ): Transform {
    const cur = this.get(id);
    if (!cur) throw new Error("This transform no longer exists.");
    const name = patch.name !== undefined ? cleanName(patch.name) : cur.name;
    const other = this.findByName(name);
    if (other && other.id !== id)
      throw new DuplicateError(`A transform named "${name}"`);
    this.db
      .prepare(
        "UPDATE transforms SET name = ?, name_key = ?, description = ?, prompt = ?, rules = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        name,
        nameKey(name),
        (patch.description ?? cur.description).trim(),
        (patch.prompt ?? cur.prompt).trim(),
        cur.kind === "polish" ? JSON.stringify(patch.rules ?? cur.rules) : null,
        now,
        id,
      );
    return this.get(id)!;
  }

  setShortcut(id: string, shortcut: string | null, now = Date.now()): void {
    this.db
      .prepare(
        "UPDATE transforms SET shortcut = ?, updated_at = ? WHERE id = ?",
      )
      .run(shortcut, now, id);
  }

  /** Custom transforms only; the built-ins can be reset, not deleted. */
  delete(id: string): boolean {
    return (
      Number(
        this.db
          .prepare("DELETE FROM transforms WHERE id = ? AND built_in = 0")
          .run(id).changes,
      ) > 0
    );
  }

  /**
   * "Reset to defaults": Polish and Prompt Engineer get their default name, rules, prompt and
   * shortcut back. Custom transforms are kept.
   */
  resetDefaults(now = Date.now()): void {
    this.db.exec("BEGIN");
    try {
      for (const t of DEFAULT_TRANSFORMS) {
        this.db.prepare("DELETE FROM transforms WHERE id = ?").run(t.id);
        // A custom transform may have taken the default's name meanwhile.
        const name = this.findByName(t.name) ? `${t.name} (default)` : t.name;
        this.db
          .prepare(
            "INSERT INTO transforms (id, kind, name, name_key, description, prompt, rules, shortcut, position, built_in, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
          )
          .run(
            t.id,
            t.kind,
            name,
            nameKey(name),
            t.description,
            t.prompt,
            t.rules ? JSON.stringify(t.rules) : null,
            t.shortcut,
            t.position,
            now,
            now,
          );
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}

type MeetingRow = {
  id: string;
  title: string;
  notes: string;
  status: MeetingStatus;
  started_at: number | null;
  ended_at: number | null;
  created_at: number;
  updated_at: number;
  revision: number;
  has_transcript: number;
  has_summary: number;
  transcript: string;
  summary: string;
  recorded_ms: number;
  audio_parts: number;
  system_audio: number;
  error: string | null;
  language: string | null;
  audio_layout: string;
  batches: string;
};

const toMeeting = (r: MeetingRow): Meeting => ({
  id: r.id,
  title: r.title,
  notes: r.notes,
  status: r.status,
  startedAt: r.started_at === null ? null : Number(r.started_at),
  endedAt: r.ended_at === null ? null : Number(r.ended_at),
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
  revision: Number(r.revision),
  hasTranscript: Number(r.has_transcript) === 1,
  hasSummary: Number(r.has_summary) === 1,
  transcript: r.transcript,
  summary: r.summary,
  recordedMs: Number(r.recorded_ms),
  audioParts: Number(r.audio_parts),
  systemAudio: Number(r.system_audio) === 1,
  error: r.error,
  language: r.language,
  audioLayout: r.audio_layout === "split" ? "split" : "mixed",
  doneBatches: batchTexts(r.batches).length,
});

/** Finished batch transcripts kept while a meeting is transcribed (in order). */
function batchTexts(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

const MEETING_ORDER: Record<MeetingSort, string> = {
  newest: "coalesce(started_at, created_at) DESC, id",
  oldest: "coalesce(started_at, created_at) ASC, id",
  title: "title COLLATE NOCASE, id",
};

/** Notetaker meetings (Stage 9D-1). Notes save on top of the revision the editor last saw. */
export class MeetingRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  list(search = "", sort: MeetingSort = "newest"): Meeting[] {
    const key = searchKey(search);
    const order = MEETING_ORDER[sort];
    const rows = key
      ? this.db
          .prepare(
            `SELECT * FROM meetings WHERE instr(murmur_fold(title), ?) > 0 OR instr(murmur_fold(notes), ?) > 0 ORDER BY ${order}`,
          )
          .all(key, key)
      : this.db.prepare(`SELECT * FROM meetings ORDER BY ${order}`).all();
    return (rows as MeetingRow[]).map(toMeeting);
  }

  /**
   * A page of meetings, newest first, for the local MCP server: optional text (folded like the
   * app's search, over title, notes, transcript and summary) and a date range on the meeting's
   * time. `total` counts every match, not just the page.
   */
  find(q: {
    search?: string;
    from?: number;
    to?: number;
    limit: number;
    offset: number;
  }): { rows: Meeting[]; total: number } {
    const where: string[] = [];
    const args: (string | number)[] = [];
    const key = q.search ? searchKey(q.search) : "";
    if (key) {
      where.push(
        "(instr(murmur_fold(title), ?) > 0 OR instr(murmur_fold(notes), ?) > 0 OR instr(murmur_fold(transcript), ?) > 0 OR instr(murmur_fold(summary), ?) > 0)",
      );
      args.push(key, key, key, key);
    }
    if (q.from !== undefined) {
      where.push("coalesce(started_at, created_at) >= ?");
      args.push(q.from);
    }
    if (q.to !== undefined) {
      where.push("coalesce(started_at, created_at) <= ?");
      args.push(q.to);
    }
    const clause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const total = Number(
      (
        this.db
          .prepare(`SELECT count(*) AS n FROM meetings${clause}`)
          .get(...args) as { n: number | bigint }
      ).n,
    );
    const rows = this.db
      .prepare(
        `SELECT * FROM meetings${clause} ORDER BY ${MEETING_ORDER.newest} LIMIT ? OFFSET ?`,
      )
      .all(...args, q.limit, q.offset) as MeetingRow[];
    return { rows: rows.map(toMeeting), total };
  }

  get(id: string): Meeting | null {
    const row = this.db
      .prepare("SELECT * FROM meetings WHERE id = ?")
      .get(id) as MeetingRow | undefined;
    return row ? toMeeting(row) : null;
  }

  create(
    m: { id: string; title: string; startedAt: number | null; notes?: string },
    now = Date.now(),
  ): Meeting {
    this.db
      .prepare(
        "INSERT INTO meetings (id, title, notes, status, started_at, ended_at, created_at, updated_at, revision, has_transcript, has_summary) VALUES (?, ?, ?, 'notes', ?, NULL, ?, ?, 1, 0, 0)",
      )
      .run(m.id, m.title, m.notes ?? "", m.startedAt, now, now);
    return this.get(m.id)!;
  }

  /** Title and times; the notes revision is left alone, so an open editor keeps saving. */
  update(
    id: string,
    patch: {
      title?: string;
      startedAt?: number | null;
      endedAt?: number | null;
      language?: string | null;
    },
    now = Date.now(),
  ): Meeting | null {
    const cur = this.get(id);
    if (!cur) return null;
    const startedAt =
      patch.startedAt !== undefined ? patch.startedAt : cur.startedAt;
    const endedAt = patch.endedAt !== undefined ? patch.endedAt : cur.endedAt;
    if (endedAt !== null && startedAt === null)
      throw new Error("Set when it started first.");
    if (startedAt !== null && endedAt !== null && endedAt <= startedAt)
      throw new Error("The end has to be after the start.");
    this.db
      .prepare(
        "UPDATE meetings SET title = ?, started_at = ?, ended_at = ?, language = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        patch.title ?? cur.title,
        startedAt,
        endedAt,
        patch.language !== undefined ? patch.language : cur.language,
        now,
        id,
      );
    // Another language: batches already transcribed in the old one are done again.
    if (patch.language !== undefined && patch.language !== cur.language)
      this.resetBatches(id);
    return this.get(id);
  }

  saveNotes(
    id: string,
    notes: string,
    revision: number,
    now = Date.now(),
  ): MeetingSaveResult {
    const r = this.db
      .prepare(
        "UPDATE meetings SET notes = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?",
      )
      .run(notes, now, id, revision);
    const meeting = this.get(id);
    if (!meeting) return { ok: false, reason: "missing" };
    if (Number(r.changes) === 0)
      return { ok: false, reason: "conflict", meeting };
    return { ok: true, meeting };
  }

  /** Deleted meetings don't survive in the write-ahead log either (as for notes). */
  delete(id: string): boolean {
    const n = Number(
      this.db.prepare("DELETE FROM meetings WHERE id = ?").run(id).changes,
    );
    if (n) this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return n > 0;
  }

  deleteAll(): number {
    const n = Number(this.db.prepare("DELETE FROM meetings").run().changes);
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return n;
  }

  /** Retention: meetings whose time is older than `before`. */
  // ---- Recording (Stage 9D-2) ----

  /** Marks a meeting that has never been recorded as recording; false otherwise. */
  beginRecording(
    id: string,
    startedAt: number,
    systemAudio: boolean,
    now = Date.now(),
    layout: "mixed" | "split" = "mixed",
  ): boolean {
    return (
      Number(
        this.db
          .prepare(
            "UPDATE meetings SET status = 'recording', started_at = ?, ended_at = NULL, recorded_ms = 0, audio_parts = 0, system_audio = ?, audio_layout = ?, batches = '[]', error = NULL, updated_at = ? WHERE id = ? AND status = 'notes'",
          )
          .run(startedAt, systemAudio ? 1 : 0, layout, now, id).changes,
      ) === 1
    );
  }

  /** The batch transcripts finished so far (in order). */
  batches(id: string): string[] {
    const r = this.db
      .prepare("SELECT batches FROM meetings WHERE id = ?")
      .get(id) as { batches: string } | undefined;
    return r ? batchTexts(r.batches) : [];
  }

  /** Forgets finished batches: the next attempt sends everything again. */
  resetBatches(id: string): void {
    this.db.prepare("UPDATE meetings SET batches = '[]' WHERE id = ?").run(id);
  }

  /** Keeps one more finished batch, so a retry continues after it. */
  saveBatch(id: string, index: number, text: string): void {
    const done = this.batches(id);
    if (index !== done.length) return;
    this.db
      .prepare("UPDATE meetings SET batches = ? WHERE id = ?")
      .run(JSON.stringify([...done, text]), id);
  }

  /** Recorded time and saved parts so far (kept current, so a crash loses at most one part). */
  recordingProgress(
    id: string,
    recordedMs: number,
    audioParts: number,
    now = Date.now(),
  ): void {
    this.db
      .prepare(
        "UPDATE meetings SET recorded_ms = ?, audio_parts = ?, updated_at = ? WHERE id = ?",
      )
      .run(Math.round(recordedMs), audioParts, now, id);
  }

  /** Ends a recording: its end time, and processing (or failed, with why). */
  finishRecording(
    id: string,
    r: {
      endedAt: number;
      recordedMs: number;
      audioParts: number;
      status: "processing" | "failed";
      error: string | null;
    },
    now = Date.now(),
  ): void {
    this.db
      .prepare(
        "UPDATE meetings SET status = ?, ended_at = ?, recorded_ms = ?, audio_parts = ?, error = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        r.status,
        r.endedAt,
        Math.round(r.recordedMs),
        r.audioParts,
        r.error,
        now,
        id,
      );
  }

  setStatus(
    id: string,
    status: MeetingStatus,
    error: string | null,
    now = Date.now(),
  ): void {
    this.db
      .prepare(
        "UPDATE meetings SET status = ?, error = ?, updated_at = ? WHERE id = ?",
      )
      .run(status, error, now, id);
  }

  /** The transcript is saved and the audio it came from is no longer kept. */
  saveTranscript(id: string, transcript: string, now = Date.now()): void {
    this.db
      .prepare(
        "UPDATE meetings SET transcript = ?, has_transcript = 1, status = 'ready', audio_parts = 0, batches = '[]', error = NULL, updated_at = ? WHERE id = ?",
      )
      .run(transcript, now, id);
  }

  saveSummary(id: string, summary: string, now = Date.now()): void {
    this.db
      .prepare(
        "UPDATE meetings SET summary = ?, has_summary = 1, updated_at = ? WHERE id = ?",
      )
      .run(summary, now, id);
  }

  withStatus(status: MeetingStatus): Meeting[] {
    return (
      this.db
        .prepare("SELECT * FROM meetings WHERE status = ? ORDER BY id")
        .all(status) as MeetingRow[]
    ).map(toMeeting);
  }

  /** Meetings older than `before`, with how many audio parts each still has. */
  olderThan(before: number): { id: string; audioParts: number }[] {
    return (
      this.db
        .prepare(
          "SELECT id, audio_parts FROM meetings WHERE coalesce(started_at, created_at) < ? AND status != 'recording'",
        )
        .all(before) as { id: string; audio_parts: number }[]
    ).map((r) => ({ id: r.id, audioParts: Number(r.audio_parts) }));
  }

  deleteOlderThan(before: number): number {
    const n = Number(
      this.db
        .prepare(
          "DELETE FROM meetings WHERE coalesce(started_at, created_at) < ? AND status != 'recording'",
        )
        .run(before).changes,
    );
    if (n) this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return n;
  }

  count(): number {
    return Number(
      (
        this.db.prepare("SELECT count(*) AS n FROM meetings").get() as {
          n: number;
        }
      ).n,
    );
  }
}
