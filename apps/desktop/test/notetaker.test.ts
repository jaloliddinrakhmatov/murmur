// Stage 9D-1: Notetaker meetings — the v6 migration on existing data, MeetingRepo, the service
// (create, edit, notes with revisions, delete, export, import, retention, readiness), privacy of
// the log, the settings, and the page logic in renderer/hub/model/notetaker.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  HistoryDb,
  MeetingRepo,
  MIGRATIONS,
  NoteRepo,
  TransformRepo,
} from "../src/main/history/db.ts";
import { NotetakerService } from "../src/main/notetaker/service.ts";
import {
  defaultMeetingTitle,
  formatMeetingDuration,
  meetingDurationMs,
  meetingFileName,
  meetingMarkdown,
  meetingPreview,
  MeetingUpdateSchema,
  type Meeting,
} from "../src/shared/meetings.ts";
import {
  DEFAULT_SETTINGS,
  parseSettingsPatch,
  SettingsSchema,
} from "../src/shared/settings.ts";
import { ResetSchema } from "../src/shared/ipc.ts";
import {
  fromLocalInput,
  meetingAsNote,
  meetingNotesStore,
  meetingsPastRetention,
  meetingTimesIssue,
  meetingWhen,
  notetakerChecklist,
  SETUP_STEPS,
  todaysMeetings,
  toLocalInput,
} from "../src/renderer/hub/model/notetaker.ts";
import { Autosaver } from "../src/renderer/hub/model/scratchpad.ts";
import { SETTINGS_SECTION_IDS } from "../src/renderer/hub/model/settings-sections.ts";

const tmp = () => join(mkdtempSync(join(tmpdir(), "murmur-9d1-")), "h.sqlite");
const DAY = 86_400_000;

function setup(
  overrides: Partial<ConstructorParameters<typeof NotetakerService>[0]> = {},
) {
  const db = new HistoryDb(tmp());
  const meetings = new MeetingRepo(db.db);
  const logs: { event: string; data?: Record<string, unknown> }[] = [];
  const written: { path: string; text: string }[] = [];
  const changes = { n: 0 };
  let n = 0;
  let clock = Date.UTC(2026, 9, 19, 10, 30);
  const files = new Map<
    string,
    { name: string; text: string; size: number; modifiedAt: number }
  >();
  let importPaths: string[] = [];
  let exportPath: string | null = "/tmp/out.md";
  let retention = 0;
  const service = new NotetakerService({
    meetings,
    newId: () => `m${++n}`,
    retentionDays: () => retention,
    readiness: async () => ({
      microphone: "granted",
      transcription: { service: "Groq", ready: null },
      summary: { service: "Groq", ready: "Add an API key" },
      systemAudio: "available",
    }),
    chooseExportPath: async () => exportPath,
    writeFile: async (path, text) => {
      written.push({ path, text });
    },
    chooseImportFiles: async () => importPaths,
    readFile: async (path) => {
      const f = files.get(path);
      if (!f) throw new Error("ENOENT");
      return f;
    },
    onChange: () => changes.n++,
    log: (event, data) => logs.push({ event, data }),
    now: () => clock,
    ...overrides,
  });
  return {
    db,
    meetings,
    service,
    logs,
    written,
    changes,
    files,
    setImport: (p: string[]) => (importPaths = p),
    setExportPath: (p: string | null) => (exportPath = p),
    setRetention: (d: number) => (retention = d),
    tick: (ms: number) => (clock += ms),
    now: () => clock,
  };
}

// ---- Migration ---------------------------------------------------------------------------------

test("v6–v8 migrations add meetings to a v5 database and keep every existing row", () => {
  const path = tmp();
  const v5 = new DatabaseSync(path);
  v5.exec(
    "CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (5);",
  );
  for (const m of MIGRATIONS.slice(0, 5)) v5.exec(m);
  v5.prepare(
    "INSERT INTO dictations (id, started_at, duration_ms, status, word_count, has_audio) VALUES ('d1', 1, 2, 'inserted', 3, 0)",
  ).run();
  v5.close();
  const db = new HistoryDb(path);
  const notes = new NoteRepo(db.db);
  notes.create("n1", "A note");
  assert.equal(db.schemaVersion, 8);
  assert.equal(db.get("d1")?.wordCount, 3, "dictations are kept");
  assert.equal(notes.list().length, 1);
  assert.equal(new TransformRepo(db.db).list().length, 2);
  const meetings = new MeetingRepo(db.db);
  assert.deepEqual(meetings.list(), []);
  db.close();
  // Opening again doesn't re-run the migration (it would fail on CREATE TABLE).
  const again = new HistoryDb(path);
  assert.equal(again.schemaVersion, 8);
  again.close();
});

// ---- Repository ---------------------------------------------------------------------------------

test("MeetingRepo creates, reads, lists, searches, sorts and counts", () => {
  const db = new HistoryDb(tmp());
  const r = new MeetingRepo(db.db);
  r.create({ id: "a", title: "Budget review", startedAt: 3000 }, 10);
  r.create(
    {
      id: "b",
      title: "café standup",
      startedAt: 1000,
      notes: "Ship the Résumé feature",
    },
    11,
  );
  r.create({ id: "c", title: "Zebra planning", startedAt: null }, 2000);
  const a = r.get("a")!;
  assert.equal(a.status, "notes");
  assert.equal(a.revision, 1);
  assert.equal(a.hasTranscript, false);
  assert.equal(a.hasSummary, false);
  assert.deepEqual(
    r.list().map((m) => m.id),
    ["a", "c", "b"],
    "newest by meeting time",
  );
  assert.deepEqual(
    r.list("", "oldest").map((m) => m.id),
    ["b", "c", "a"],
  );
  assert.deepEqual(
    r.list("", "title").map((m) => m.id),
    ["a", "b", "c"],
    "case-insensitive",
  );
  assert.deepEqual(
    r.list("CAFÉ").map((m) => m.id),
    ["b"],
    "case-folded title (Unicode, like every Murmur search)",
  );
  assert.deepEqual(
    r.list("RÉSUMÉ").map((m) => m.id),
    ["b"],
    "notes are searched too",
  );
  assert.deepEqual(
    r.list("100%").map((m) => m.id),
    [],
    "LIKE wildcards are literal",
  );
  assert.equal(r.count(), 3);
  assert.equal(r.get("missing"), null);
  db.close();
});

test("MeetingRepo saves notes only on the current revision", () => {
  const db = new HistoryDb(tmp());
  const r = new MeetingRepo(db.db);
  r.create({ id: "a", title: "Sync", startedAt: 1 }, 1);
  const first = r.saveNotes("a", "one", 1, 5);
  assert.equal(first.ok, true);
  assert.equal(first.ok && first.meeting.revision, 2);
  const stale = r.saveNotes("a", "older copy", 1, 6);
  assert.equal(stale.ok, false);
  assert.equal(!stale.ok && stale.reason, "conflict");
  assert.equal(r.get("a")?.notes, "one", "the newer text is kept");
  const gone = r.saveNotes("zzz", "x", 1);
  assert.deepEqual(gone, { ok: false, reason: "missing" });
  db.close();
});

test("MeetingRepo update keeps the notes revision and refuses an end before the start", () => {
  const db = new HistoryDb(tmp());
  const r = new MeetingRepo(db.db);
  r.create({ id: "a", title: "Sync", startedAt: 1000 }, 1);
  const m = r.update("a", { title: "Renamed", endedAt: 4000 }, 9)!;
  assert.equal(m.title, "Renamed");
  assert.equal(m.endedAt, 4000);
  assert.equal(m.revision, 1, "editing details never conflicts with typing");
  assert.throws(() => r.update("a", { endedAt: 500 }), /after the start/);
  assert.throws(
    () => r.update("a", { startedAt: null }),
    /started first/,
    "an end needs a start",
  );
  assert.equal(r.update("missing", { title: "x" }), null);
  db.close();
});

test("MeetingRepo deletes one, all, and those older than a time", () => {
  const db = new HistoryDb(tmp());
  const r = new MeetingRepo(db.db);
  r.create({ id: "old", title: "Old", startedAt: 100 }, 1);
  r.create({ id: "undated", title: "Undated", startedAt: null }, 150);
  r.create({ id: "new", title: "New", startedAt: 1000 }, 1);
  assert.equal(r.deleteOlderThan(200), 2, "start time, else creation time");
  assert.deepEqual(
    r.list().map((m) => m.id),
    ["new"],
  );
  assert.equal(r.delete("new"), true);
  assert.equal(r.delete("new"), false);
  r.create({ id: "x", title: "X", startedAt: 1 }, 1);
  assert.equal(r.deleteAll(), 1);
  assert.equal(r.count(), 0);
  db.close();
});

// ---- Service ------------------------------------------------------------------------------------

test("create: a default title and now as its time; nothing is recorded", () => {
  const s = setup();
  const m = s.service.create();
  assert.equal(m.title, defaultMeetingTitle(s.now()));
  assert.equal(m.startedAt, s.now());
  assert.equal(m.status, "notes");
  assert.equal(m.notes, "");
  assert.equal(s.changes.n, 1);
  const named = s.service.create({ title: "  Board  ", startedAt: null });
  assert.equal(named.title, "Board");
  assert.equal(named.startedAt, null);
  assert.throws(() => s.service.create({ title: "x".repeat(121) }));
});

test("update: rename and times are validated; a missing meeting is reported", () => {
  const s = setup();
  const m = s.service.create({ title: "Sync" });
  const u = s.service.update({
    id: m.id,
    title: "Weekly",
    endedAt: m.startedAt! + 45 * 60_000,
  });
  assert.equal(u.title, "Weekly");
  assert.equal(formatMeetingDuration(meetingDurationMs(u)), "45 min");
  assert.throws(() => s.service.update({ id: m.id, title: "   " }), /title/);
  assert.throws(
    () => s.service.update({ id: m.id, startedAt: 10, endedAt: 5 }),
    /after the start/,
  );
  assert.throws(
    () => s.service.update({ id: "nope", title: "x" }),
    /no longer exists/,
  );
});

test("notes: saved with revisions; a stale save is refused and logged without the text", () => {
  const s = setup();
  const m = s.service.create({ title: "Private title" });
  const ok = s.service.saveNotes({
    id: m.id,
    notes: "secret plan",
    revision: 1,
  });
  assert.equal(ok.ok, true);
  const stale = s.service.saveNotes({ id: m.id, notes: "other", revision: 1 });
  assert.equal(stale.ok, false);
  assert.ok(s.logs.some((l) => l.event === "meeting.save.refused"));
  assert.throws(() =>
    s.service.saveNotes({ id: m.id, notes: "x", revision: 0 }),
  );
});

test("delete needs an explicit confirmation", () => {
  const s = setup();
  const m = s.service.create();
  assert.throws(() => s.service.delete({ id: m.id }));
  assert.throws(() => s.service.delete({ id: m.id, confirm: false }));
  assert.equal(s.service.delete({ id: m.id, confirm: true }), true);
  assert.equal(s.service.get({ id: m.id }), null);
  assert.equal(s.service.delete({ id: m.id, confirm: true }), false);
});

test("list returns summaries with a preview, honouring search and sort", () => {
  const s = setup();
  const a = s.service.create({ title: "Alpha", startedAt: 1000 });
  s.service.saveNotes({
    id: a.id,
    notes: "Line one\n\n  Line two  ",
    revision: 1,
  });
  s.service.create({ title: "Beta", startedAt: 2000 });
  const list = s.service.list({ sort: "oldest" });
  assert.deepEqual(
    list.map((m) => m.title),
    ["Alpha", "Beta"],
  );
  assert.equal(list[0].preview, "Line one Line two");
  assert.equal("notes" in list[0], false, "the list never carries full notes");
  assert.deepEqual(
    s.service.list({ search: "beta" }).map((m) => m.title),
    ["Beta"],
  );
  assert.throws(() => s.service.list({ sort: "random" }));
});

test("export writes Markdown where you choose; cancelling writes nothing", async () => {
  const s = setup();
  const m = s.service.create({
    title: "Q4: plan/review",
    startedAt: Date.UTC(2026, 9, 19, 9),
  });
  s.service.saveNotes({ id: m.id, notes: "- decide budget", revision: 1 });
  const r = await s.service.export({ id: m.id });
  assert.deepEqual(r, { saved: true, path: "/tmp/out.md" });
  assert.match(s.written[0].text, /^# Q4: plan\/review\n/);
  assert.match(s.written[0].text, /## Notes\n\n- decide budget/);
  assert.doesNotMatch(
    s.written[0].text,
    /Transcript|Summary/,
    "nothing invented",
  );
  s.setExportPath(null);
  assert.deepEqual(await s.service.export({ id: m.id }), { saved: false });
  assert.equal(s.written.length, 1);
  await assert.rejects(s.service.export({ id: "nope" }), /no longer exists/);
});

test("import: .txt and .md become meetings; others and large files are skipped", async () => {
  const s = setup();
  s.files.set("/a.md", {
    name: "a.md",
    text: "# Design review\n\nNotes here",
    size: 30,
    modifiedAt: 5000.4,
  });
  s.files.set("/b.txt", {
    name: "b.txt",
    text: "plain notes",
    size: 11,
    modifiedAt: 6000,
  });
  s.files.set("/c.pdf", { name: "c.pdf", text: "", size: 10, modifiedAt: 1 });
  s.files.set("/d.md", {
    name: "d.md",
    text: "",
    size: 600_000,
    modifiedAt: 1,
  });
  s.setImport(["/a.md", "/b.txt", "/c.pdf", "/d.md", "/missing.md"]);
  const r = await s.service.import();
  assert.equal(r.imported, 2);
  assert.deepEqual(r.skipped, ["c.pdf", "d.md", "missing.md"]);
  const list = s.service.list({ sort: "oldest" });
  assert.deepEqual(
    list.map((m) => [m.title, m.startedAt]),
    [
      ["Design review", 5000],
      ["b", 6000],
    ],
  );
  assert.equal(s.changes.n, 1, "one change notice for the batch");
  const log = s.logs.find((l) => l.event === "meeting.imported");
  assert.deepEqual(log?.data, { imported: 2, skipped: 3 });
});

test("import: cancelling the dialog imports nothing", async () => {
  const s = setup();
  s.setImport([]);
  assert.deepEqual(await s.service.import(), { imported: 0, skipped: [] });
  assert.equal(s.changes.n, 0);
});

test("retention: 0 keeps everything; otherwise older meetings are purged", () => {
  const s = setup();
  s.service.create({ title: "Old", startedAt: s.now() - 40 * DAY });
  s.service.create({ title: "Recent", startedAt: s.now() - 2 * DAY });
  s.setRetention(0);
  assert.equal(s.service.purgeExpired(), 0);
  s.setRetention(30);
  assert.equal(s.service.purgeExpired(), 1);
  assert.deepEqual(
    s.service.list().map((m) => m.title),
    ["Recent"],
  );
  assert.deepEqual(s.logs.find((l) => l.event === "meeting.purged")?.data, {
    count: 1,
  });
});

test("readiness is passed through unchanged (no permission is requested)", async () => {
  const s = setup();
  const r = await s.service.readiness();
  assert.equal(r.microphone, "granted");
  assert.equal(r.summary.ready, "Add an API key");
});

test("privacy: meeting titles and notes never reach the log", async () => {
  const s = setup();
  const m = s.service.create({ title: "Acquisition of Contoso" });
  s.service.saveNotes({ id: m.id, notes: "price is 4.2M", revision: 1 });
  s.service.saveNotes({ id: m.id, notes: "stale", revision: 1 });
  s.service.update({ id: m.id, title: "Project Falcon" });
  await s.service.export({ id: m.id });
  s.files.set("/x.md", {
    name: "x.md",
    text: "# Layoffs\nconfidential",
    size: 20,
    modifiedAt: 1,
  });
  s.setImport(["/x.md"]);
  await s.service.import();
  s.service.delete({ id: m.id, confirm: true });
  const text = JSON.stringify(s.logs);
  for (const secret of [
    "Contoso",
    "4.2M",
    "Falcon",
    "Layoffs",
    "confidential",
    "stale",
  ])
    assert.ok(!text.includes(secret), `log mentions ${secret}`);
});

// ---- Shared helpers ------------------------------------------------------------------------------

test("meeting helpers: preview, file name, Markdown, duration, update schema", () => {
  assert.equal(meetingPreview("a\n\n b "), "a b");
  assert.equal(meetingPreview("x".repeat(200)).length, 140);
  assert.equal(meetingFileName({ title: 'a/b:c*?"<>|' }), "a b c.md");
  assert.equal(meetingFileName({ title: "   " }), "Meeting.md");
  assert.equal(formatMeetingDuration(80 * 60_000), "1 h 20 min");
  assert.equal(formatMeetingDuration(120 * 60_000), "2 h");
  assert.equal(formatMeetingDuration(null), "");
  assert.equal(meetingDurationMs({ startedAt: 5, endedAt: 5 }), null);
  const md = meetingMarkdown({
    id: "a",
    title: "T",
    notes: "",
    status: "notes",
    startedAt: null,
    endedAt: null,
    createdAt: 0,
    updatedAt: 0,
    revision: 1,
    hasTranscript: false,
    hasSummary: false,
    transcript: "",
    summary: "",
    recordedMs: 0,
    audioParts: 0,
    systemAudio: false,
    error: null,
    language: null,
    audioLayout: "mixed",
    doneBatches: 0,
  });
  assert.match(md, /_No notes._/);
  assert.equal(
    MeetingUpdateSchema.safeParse({ id: "a", startedAt: 5, endedAt: 4 })
      .success,
    false,
  );
  assert.equal(
    MeetingUpdateSchema.safeParse({ id: "a", startedAt: null, endedAt: 4 })
      .success,
    true,
  );
});

// ---- Settings and reset ------------------------------------------------------------------------

test("settings: Notetaker defaults are off, and a patch changes only what it names", () => {
  assert.deepEqual(DEFAULT_SETTINGS.notetaker, {
    setupCompleted: false,
    setupCardDismissed: false,
    consentAcknowledged: false,
    retentionDays: 0,
    systemAudio: true,
    maxRecordingMinutes: 120,
    speakerLabels: true,
    summaryConsent: [],
    systemAudioAccess: "unknown",
  });
  const patch = parseSettingsPatch({ notetaker: { retentionDays: 30 } });
  assert.deepEqual(patch.notetaker, { retentionDays: 30 });
  assert.equal(
    SettingsSchema.safeParse({
      ...DEFAULT_SETTINGS,
      notetaker: { retentionDays: 7 },
    }).success,
    false,
    "only the offered retention choices",
  );
  const old = SettingsSchema.parse({
    ...DEFAULT_SETTINGS,
    notetaker: undefined,
  });
  assert.equal(
    old.notetaker.setupCompleted,
    false,
    "settings from before 9D-1 load",
  );
});

test("reset: meetings are kept unless that box is ticked", () => {
  assert.equal(ResetSchema.parse({ library: false }).meetings, false);
  assert.equal(
    ResetSchema.parse({ library: false, meetings: true }).meetings,
    true,
  );
});

test("Settings: Notetaker comes right after System", () => {
  const i = SETTINGS_SECTION_IDS.indexOf("notetaker");
  assert.equal(SETTINGS_SECTION_IDS[i - 1], "system");
});

// ---- Page logic ---------------------------------------------------------------------------------

const summary = (id: string, startedAt: number | null, createdAt = 0) => ({
  id,
  title: id,
  status: "notes" as const,
  startedAt,
  endedAt: null,
  createdAt,
  updatedAt: createdAt,
  preview: "",
  hasTranscript: false,
  hasSummary: false,
  recordedMs: 0,
});

test("Today: only today's meetings, in agenda order", () => {
  const now = new Date(2026, 9, 19, 15, 0);
  const at = (h: number, d = 19) => new Date(2026, 9, d, h).getTime();
  const list = [
    summary("late", at(14)),
    summary("yesterday", at(9, 18)),
    summary("early", at(9)),
  ];
  assert.deepEqual(
    todaysMeetings(list, now).map((m) => m.id),
    ["early", "late"],
  );
});

test("meetingWhen: time today, Yesterday, a date otherwise; no time when it isn't set", () => {
  const now = new Date(2026, 9, 19, 15, 0);
  assert.match(
    meetingWhen(summary("a", new Date(2026, 9, 19, 9, 5).getTime()), now),
    /9:05/,
  );
  assert.match(
    meetingWhen(summary("a", new Date(2026, 9, 18, 9, 5).getTime()), now),
    /^Yesterday, /,
  );
  assert.equal(
    meetingWhen(summary("a", null, new Date(2026, 9, 19).getTime()), now),
    "Today",
  );
  assert.match(
    meetingWhen(summary("a", null, new Date(2025, 0, 2).getTime()), now),
    /2025/,
  );
});

test("datetime-local values round-trip in local time", () => {
  const ts = new Date(2026, 9, 19, 9, 5).getTime();
  assert.equal(toLocalInput(ts), "2026-10-19T09:05");
  assert.equal(fromLocalInput("2026-10-19T09:05"), ts);
  assert.equal(toLocalInput(null), "");
  assert.equal(fromLocalInput(""), null);
  assert.equal(fromLocalInput("garbage"), null);
});

test("meetingTimesIssue: an end needs a start and has to be after it", () => {
  assert.equal(meetingTimesIssue(null, null), null);
  assert.equal(meetingTimesIssue(1, null), null);
  assert.equal(meetingTimesIssue(1, 2), null);
  assert.match(meetingTimesIssue(null, 2)!, /started/);
  assert.match(meetingTimesIssue(2, 2)!, /after the start/);
});

test("retention preview counts what a shorter choice would delete", () => {
  const now = 100 * DAY;
  const list = [
    summary("a", now - 40 * DAY),
    summary("b", now - DAY),
    summary("c", null, now - 400 * DAY),
  ];
  assert.equal(meetingsPastRetention(list, 0, now), 0);
  assert.equal(meetingsPastRetention(list, 30, now), 2);
  assert.equal(meetingsPastRetention(list, 365, now), 1);
});

test("sidebar card: setup then a first note; hidden when done or skipped", () => {
  const base = { setupCompleted: false, setupCardDismissed: false };
  assert.equal(notetakerChecklist(base, 0).visible, true);
  assert.equal(notetakerChecklist(base, 0).done, 0);
  assert.equal(
    notetakerChecklist({ ...base, setupCompleted: true }, 0).done,
    1,
  );
  assert.equal(
    notetakerChecklist({ ...base, setupCompleted: true }, 2).visible,
    false,
  );
  assert.equal(
    notetakerChecklist({ ...base, setupCardDismissed: true }, 0).visible,
    false,
  );
});

test("setup steps: microphone is explained, system audio is never its own permission step", () => {
  const ids = SETUP_STEPS.map((s) => s.id);
  assert.deepEqual(ids, [
    "about",
    "audio",
    "microphone",
    "storage",
    "services",
    "privacy",
  ]);
  assert.equal(
    ids.at(-1),
    "privacy",
    "consent is the last step before finishing",
  );
});

test("notes autosave: the Scratchpad Autosaver saves meeting notes and reports conflicts", async () => {
  const s = setup();
  const m = s.service.create({ title: "Sync" });
  const timers: (() => void)[] = [];
  const saved: Meeting[] = [];
  const saver = new Autosaver(
    meetingNotesStore(
      async (id, notes, revision) =>
        s.service.saveNotes({ id, notes, revision }),
      (x) => saved.push(x),
    ),
    meetingAsNote(m),
    { schedule: (fn) => timers.push(fn), cancel: () => {} },
  );
  saver.change("first draft");
  await saver.flush();
  assert.equal(s.service.get({ id: m.id })?.notes, "first draft");
  assert.equal(saved.at(-1)?.revision, 2);
  // Someone else saves (another window): ours is now stale.
  s.service.saveNotes({ id: m.id, notes: "elsewhere", revision: 2 });
  saver.change("mine");
  await saver.flush();
  assert.equal(saver.status, "conflict");
  assert.equal(
    s.service.get({ id: m.id })?.notes,
    "elsewhere",
    "never overwritten silently",
  );
  await saver.keepMine();
  assert.equal(s.service.get({ id: m.id })?.notes, "mine");
  s.service.delete({ id: m.id, confirm: true });
  saver.change("after delete");
  await saver.flush();
  assert.equal(saver.status, "error");
  saver.dispose();
});

test("settings: a patch naming one field keeps its siblings in every nested group", async () => {
  const { applyPatch } = await import("../src/shared/settings.ts");
  const start = SettingsSchema.parse({
    ...DEFAULT_SETTINGS,
    notetaker: {
      setupCompleted: true,
      setupCardDismissed: true,
      consentAcknowledged: true,
      retentionDays: 90,
      systemAudio: true,
      maxRecordingMinutes: 60,
    },
    scratchpad: {
      ...DEFAULT_SETTINGS.scratchpad,
      openBehavior: "new",
      font: "serif",
      aiConsent: ["groq"],
    },
  });
  const a = applyPatch(
    start,
    parseSettingsPatch({ notetaker: { systemAudio: false } }),
  );
  assert.deepEqual(a.notetaker, { ...start.notetaker, systemAudio: false });
  const b = applyPatch(
    start,
    parseSettingsPatch({ notetaker: { setupCardDismissed: false } }),
  );
  assert.equal(
    b.notetaker.setupCompleted,
    true,
    "skipping the card never undoes setup",
  );
  assert.equal(b.notetaker.consentAcknowledged, true);
  const c = applyPatch(
    start,
    parseSettingsPatch({ scratchpad: { font: "mono" } }),
  );
  assert.deepEqual(c.scratchpad, { ...start.scratchpad, font: "mono" });
  assert.deepEqual(c.notetaker, start.notetaker, "other groups untouched");
});

test("meeting language menu: dictation's, automatic, the service's languages, and a stored code kept", async () => {
  const {
    meetingLanguageOptions,
    languageToOption,
    optionToLanguage,
    speakerLines,
  } = await import("../src/renderer/hub/model/notetaker.ts");
  const opts = meetingLanguageOptions("deepgram", "ru", null);
  assert.equal(opts[0].label, "Same as dictation (Russian)");
  assert.equal(opts[1].label, "Detect automatically");
  assert.ok(opts.some((o) => o.value === "en"));
  const kept = meetingLanguageOptions("deepgram", "ru", "xx");
  assert.equal(
    kept.at(-1)?.value,
    "xx",
    "a code the service no longer offers stays visible",
  );
  for (const lang of [null, "", "uz"])
    assert.equal(optionToLanguage(languageToOption(lang)), lang);
  assert.deepEqual(speakerLines("You: Hi.\nOthers: Hello.\n"), [
    { speaker: "You", text: "Hi." },
    { speaker: "Others", text: "Hello." },
  ]);
  assert.equal(speakerLines("Just one plain transcript."), null);
});
