import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotePrefsPatchSchema } from "../src/shared/note-prefs.ts";
import { NoteRepo, openDatabase } from "../src/main/history/db.ts";
import {
  ScratchpadService,
  type ScratchpadDeps,
} from "../src/main/scratchpad/service.ts";
import {
  TransformService,
  type TextService,
} from "../src/main/transforms/service.ts";
import { TransformRepo } from "../src/main/history/db.ts";
import { ScratchpadAwareInserter } from "../src/main/scratchpad/inserter.ts";
import type {
  Inserter,
  InsertOutcome,
  TargetSnapshot,
} from "../src/main/core/types.ts";
import {
  countNoteWords,
  exportFileName,
  notePreview,
  noteTitle,
  type Note,
  type SaveResult,
} from "../src/shared/notes.ts";
import {
  Autosaver,
  nextActiveTab,
  noteWhen,
  parseNoteRoute,
  replaceRange,
  saveErrorText,
  saveStateLabel,
  spacedInsertion,
  type SaveState,
} from "../src/renderer/hub/model/scratchpad.ts";
import {
  parseSettingsPatch,
  DEFAULT_SETTINGS,
} from "../src/shared/settings.ts";

const dbPath = () =>
  join(mkdtempSync(join(tmpdir(), "murmur-notes-")), "db.sqlite");

// ---- Shared helpers ----------------------------------------------------------------------------

test("noteTitle and preview: explicit title, first line, Untitled; no repeated first line", () => {
  assert.equal(noteTitle({ title: null, body: "" }), "Untitled");
  assert.equal(
    noteTitle({ title: "  ", body: "\n\n  Groceries \nmilk" }),
    "Groceries",
  );
  assert.equal(noteTitle({ title: "Plan", body: "first" }), "Plan");
  assert.equal(noteTitle({ title: null, body: "x".repeat(80) }).length, 60);
  assert.equal(
    notePreview({ title: null, body: "Groceries\nmilk\n\neggs" }),
    "milk eggs",
  );
  assert.equal(notePreview({ title: "List", body: "milk\neggs" }), "milk eggs");
});

test("countNoteWords: Unicode, apostrophes, emoji not counted as words", () => {
  assert.equal(countNoteWords(""), 0);
  assert.equal(countNoteWords("Don't stop — Café Müller 2026 🚀"), 5);
  assert.equal(countNoteWords("Привет мир"), 2);
});

test("exportFileName: safe characters, .txt", () => {
  assert.equal(exportFileName({ title: "a/b:c?", body: "" }), "a b c.txt");
  assert.equal(exportFileName({ title: null, body: "" }), "Untitled.txt");
});

test("settings: scratchpad defaults and patches touch only what was sent", () => {
  assert.deepEqual(DEFAULT_SETTINGS.scratchpad, {
    openBehavior: "resume",
    font: "sans",
    size: "medium",
    aiConsent: [],
  });
  assert.equal(DEFAULT_SETTINGS.shortcuts.openScratchpad, null);
  assert.deepEqual(parseSettingsPatch({ scratchpad: { font: "mono" } }), {
    scratchpad: { font: "mono" },
  });
  assert.throws(() => parseSettingsPatch({ scratchpad: { font: "comic" } }));
  // The global shortcut can't be set through a settings patch.
  assert.deepEqual(
    parseSettingsPatch({ shortcuts: { openScratchpad: "cmd+k" } }),
    {},
  );
});

// ---- NoteRepo ----------------------------------------------------------------------------------

test("NoteRepo: create, save on the current revision, refuse an older one, rename keeps it", () => {
  const notes = new NoteRepo(openDatabase(dbPath()));
  const n = notes.create("a", "hello", 1000);
  assert.equal(n.revision, 1);
  const s1 = notes.save("a", "hello world", 1, 2000);
  assert.ok(s1.ok);
  assert.equal(s1.ok && s1.note.revision, 2);
  // An editor still holding revision 1 must not overwrite revision 2.
  const stale = notes.save("a", "old copy", 1, 3000);
  assert.equal(stale.ok, false);
  assert.equal(!stale.ok && stale.reason, "conflict");
  assert.equal(notes.get("a")!.body, "hello world");
  // Renaming changes the title only; the editor's revision still saves.
  assert.equal(notes.rename("a", "  My   note ")!.title, "My note");
  assert.ok(notes.save("a", "hello again", 2, 4000).ok);
  assert.equal(notes.rename("a", "")!.title, null);
  assert.deepEqual(notes.save("missing", "x", 1), {
    ok: false,
    reason: "missing",
  });
});

test("NoteRepo: newest first, Unicode search in title and text, last opened, delete", () => {
  const notes = new NoteRepo(openDatabase(dbPath()));
  notes.create("a", "Café MÜLLER at noon", 1000);
  notes.create("b", "groceries", 2000);
  notes.create("c", "😀 emoji note", 3000);
  notes.rename("b", "Shopping", 2500);
  assert.deepEqual(
    notes.list().map((n) => n.id),
    ["c", "a", "b"].sort(
      (x, y) =>
        notes.get(y)!.updatedAt - notes.get(x)!.updatedAt || x.localeCompare(y),
    ),
  );
  assert.deepEqual(
    notes.list("müller").map((n) => n.id),
    ["a"],
  );
  assert.deepEqual(
    notes.list("shopping").map((n) => n.id),
    ["b"],
  );
  assert.deepEqual(
    notes.list("😀").map((n) => n.id),
    ["c"],
  );
  notes.markOpened("a", 9000);
  assert.equal(notes.lastOpened()!.id, "a");
  assert.equal(notes.delete("a"), true);
  assert.equal(notes.delete("a"), false);
  assert.equal(notes.deleteAll(), 2);
  assert.equal(notes.lastOpened(), null);
});

test("NoteRepo: notes survive reopening the database (restart)", () => {
  const path = dbPath();
  const db1 = openDatabase(path);
  new NoteRepo(db1).create("keep", "Line one\n🙂 two", 1);
  db1.close();
  const again = new NoteRepo(openDatabase(path));
  assert.equal(again.get("keep")!.body, "Line one\n🙂 two");
});

test("NoteRepo: a one-million-character note saves and loads intact", () => {
  const notes = new NoteRepo(openDatabase(dbPath()));
  const big = "word ".repeat(200_000);
  notes.create("big", big);
  assert.ok(notes.save("big", `${big}end`, 1).ok);
  assert.equal(notes.get("big")!.body.length, 1_000_003);
});

// ---- ScratchpadService -------------------------------------------------------------------------

/** The shared Transforms service on the same database, with a fake AI. */
function transformsFor(
  db: ReturnType<typeof openDatabase>,
  ai: TextService,
  log?: (event: string, data?: Record<string, unknown>) => void,
) {
  return new TransformService({
    transforms: new TransformRepo(db),
    hotkeys: {
      check: () => ({ normalized: null, errors: [], warnings: [] }),
      bindTransforms: () => new Map(),
    },
    newId: () => crypto.randomUUID(),
    optedIn: () => false,
    ai: () => ai,
    aiName: () => "Groq",
    aiProvider: () => "groq",
    aiConsented: () => true,
    summaryConsented: () => false,
    onChange: () => {},
    log,
  });
}

function service(
  over: Partial<ScratchpadDeps> = {},
  ai: TextService = fakeAi(),
) {
  const db = openDatabase(dbPath());
  const notes = new NoteRepo(db);
  const logs: { event: string; data?: Record<string, unknown> }[] = [];
  const copied: string[] = [];
  const written: { path: string; text: string }[] = [];
  let changes = 0;
  let n = 0;
  const svc = new ScratchpadService({
    notes,
    newId: () => `n${++n}`,
    openBehavior: () => "resume",
    copy: async (t) => {
      copied.push(t);
      return true;
    },
    transforms: transformsFor(db, ai, (event, data) =>
      logs.push({ event, data }),
    ),
    chooseExportPath: async (name) => `/tmp/${name}`,
    writeFile: async (path, text) => {
      written.push({ path, text });
    },
    onChange: () => changes++,
    log: (event, data) => logs.push({ event, data }),
    ...over,
  });
  return { svc, notes, logs, copied, written, changes: () => changes };
}

function fakeAi(
  opts: {
    ready?: string | null;
    reply?: (
      system: string,
      user: string,
      signal: AbortSignal,
    ) => Promise<string>;
  } = {},
): TextService & { calls: { system: string; user: string }[] } {
  const calls: { system: string; user: string }[] = [];
  return {
    id: "fake",
    calls,
    readiness: async () => opts.ready ?? null,
    generate: async (system, user, { signal }) => {
      calls.push({ system, user });
      return {
        text: await (opts.reply ?? (async (_s, u) => `EDITED: ${u}`))(
          system,
          user,
          signal,
        ),
      };
    },
  };
}

test("service: validates input; creates, saves, renames, deletes with confirmation", () => {
  const { svc, changes } = service();
  assert.throws(() => svc.create({ body: 5 }));
  assert.throws(() => svc.create({ body: "x".repeat(1_000_001) }));
  const note = svc.create({ body: "Hello" });
  const r = svc.save({ id: note.id, body: "Hello there", revision: 1 });
  assert.ok(r.ok);
  assert.equal(
    svc.rename({ id: note.id, title: "Greeting" }).title,
    "Greeting",
  );
  assert.deepEqual(
    svc.list().map((x) => x.title),
    ["Greeting"],
  );
  assert.throws(() => svc.delete({ id: note.id }), /confirm|expected/i);
  assert.equal(svc.delete({ id: note.id, confirm: true }), true);
  assert.equal(changes(), 4);
});

test("service: initial note follows the open behaviour", () => {
  let behaviour: "resume" | "new" = "resume";
  const { svc } = service({ openBehavior: () => behaviour });
  assert.equal(svc.initial(), null);
  const a = svc.create({ body: "A" });
  svc.create({ body: "B" });
  svc.open({ id: a.id });
  assert.equal(svc.initial()!.id, a.id);
  behaviour = "new";
  assert.equal(svc.initial(), null);
});

test("service: logs never contain note text", async () => {
  const secret = "my bank PIN is 4321";
  const ai = fakeAi();
  const { svc, logs } = service({}, ai);
  const n = svc.create({ body: secret });
  svc.save({ id: n.id, body: `${secret}!`, revision: 1 });
  svc.save({ id: n.id, body: "stale", revision: 1 });
  await svc.export({ id: n.id });
  await svc.ai({ requestId: "r1", transformId: "polish", text: secret });
  svc.delete({ id: n.id, confirm: true });
  const dump = JSON.stringify(logs);
  assert.ok(logs.length >= 5);
  assert.doesNotMatch(dump, /PIN|4321|bank/);
});

test("service: copy and export report honestly", async () => {
  let clipboardWorks = true;
  const { svc, copied, written } = service({
    copy: async (t) => {
      copied.push(t);
      return clipboardWorks;
    },
  });
  assert.equal(await svc.copy({ text: "" }), false);
  assert.equal(await svc.copy({ text: "abc 🙂" }), true);
  clipboardWorks = false;
  assert.equal(await svc.copy({ text: "abc" }), false);
  const n = svc.create({ body: "Plan\nstep 1" });
  assert.deepEqual(await svc.export({ id: n.id }), {
    saved: true,
    path: "/tmp/Plan.txt",
  });
  assert.deepEqual(written, [{ path: "/tmp/Plan.txt", text: "Plan\nstep 1" }]);
  const cancelled = service({ chooseExportPath: async () => null });
  const m = cancelled.svc.create({ body: "x" });
  assert.deepEqual(await cancelled.svc.export({ id: m.id }), { saved: false });
  assert.equal(cancelled.written.length, 0);
  const failing = service({
    writeFile: async () => {
      throw new Error("disk full");
    },
  });
  const f = failing.svc.create({ body: "x" });
  await assert.rejects(failing.svc.export({ id: f.id }), /disk full/);
});

// ---- Dictation into the note window ------------------------------------------------------------

class FakeInner implements Inserter {
  calls: string[] = [];
  async insert(text: string): Promise<InsertOutcome> {
    this.calls.push(text);
    return { strategy: "clipboard-only", reason: "self-target" };
  }
}
const target = (over: Partial<TargetSnapshot> = {}): TargetSnapshot => ({
  appBundleId: "app.murmur.desktop",
  appName: "Murmur",
  pid: 42,
  secure: false,
  takenAt: 1000,
  ...over,
});

test("inserter: the focused note window gets the text directly, once", async () => {
  const inner = new FakeInner();
  const inserted: string[] = [];
  const ins = new ScratchpadAwareInserter(
    inner,
    {
      acceptsDictation: (t) => t >= 900,
      insert: async (text) => {
        inserted.push(text);
        return true;
      },
    },
    () => {},
    () => false,
    42,
  );
  assert.deepEqual(await ins.insert("Hello 👋", target()), {
    strategy: "direct",
  });
  assert.deepEqual(inserted, ["Hello 👋"]);
  assert.equal(inner.calls.length, 0);
});

test("inserter: other apps, focus changes, secure fields and failures use the normal path", async () => {
  const cases: [string, Partial<TargetSnapshot>, boolean, boolean][] = [
    ["another app", { pid: 7, appBundleId: "com.apple.Notes" }, true, true],
    ["focus moved during transcription", {}, false, true],
    ["secure field", { secure: true }, true, true],
    ["window didn't take it", {}, true, false],
  ];
  for (const [name, over, accepts, works] of cases) {
    const inner = new FakeInner();
    let direct = 0;
    const ins = new ScratchpadAwareInserter(
      inner,
      {
        acceptsDictation: () => accepts,
        insert: async () => {
          direct++;
          return works;
        },
      },
      () => {},
      () => false,
      42,
    );
    const out = await ins.insert("text", target(over));
    assert.equal(out.strategy, "clipboard-only", name);
    assert.equal(inner.calls.length, 1, name);
    assert.ok(direct <= 1, name);
  }
});

// ---- Autosave ----------------------------------------------------------------------------------

class FakeStore {
  notes = new Map<string, Note>();
  creates = 0;
  saves = 0;
  fail = false;
  gate: Promise<void> | null = null;
  async create(body: string): Promise<Note> {
    await this.gate;
    if (this.fail) throw new Error("database is locked");
    this.creates++;
    const n: Note = {
      id: `id${this.creates}`,
      title: null,
      body,
      createdAt: 0,
      updatedAt: 0,
      openedAt: 0,
      revision: 1,
    };
    this.notes.set(n.id, n);
    return n;
  }
  async save(id: string, body: string, revision: number): Promise<SaveResult> {
    await this.gate;
    if (this.fail) throw new Error("database is locked");
    this.saves++;
    const n = this.notes.get(id);
    if (!n) return { ok: false, reason: "missing" };
    if (n.revision !== revision)
      return { ok: false, reason: "conflict", note: n };
    const next = { ...n, body, revision: n.revision + 1 };
    this.notes.set(id, next);
    return { ok: true, note: next };
  }
}

function timers() {
  const pending = new Map<number, () => void>();
  let id = 0;
  return {
    schedule: (fn: () => void) => {
      pending.set(++id, fn);
      return id;
    },
    cancel: (h: unknown) => void pending.delete(h as number),
    async fire() {
      const fns = [...pending.values()];
      pending.clear();
      for (const f of fns) f();
      await new Promise((r) => setTimeout(r, 0));
    },
    get size() {
      return pending.size;
    },
  };
}

test("autosave: debounced; one record created on the first text; later edits save over it", async () => {
  const store = new FakeStore();
  const t = timers();
  const states: SaveState[] = [];
  const saver = new Autosaver(store, null, {
    schedule: t.schedule,
    cancel: t.cancel,
    onState: (s) => states.push(s),
  });
  saver.change("   ");
  assert.equal(t.size, 0, "whitespace alone creates nothing");
  saver.change("H");
  saver.change("He");
  saver.change("Hello");
  assert.equal(t.size, 1);
  await t.fire();
  assert.equal(store.creates, 1);
  assert.equal(saver.id, "id1");
  saver.change("Hello world");
  await t.fire();
  assert.equal(store.creates, 1);
  assert.equal(store.notes.get("id1")!.body, "Hello world");
  assert.equal(saver.status, "saved");
  assert.ok(states.includes("unsaved") && states.includes("saving"));
});

test("autosave: typing during a save never creates a duplicate and the last text wins", async () => {
  const store = new FakeStore();
  const t = timers();
  let release!: () => void;
  store.gate = new Promise((r) => (release = r));
  const saver = new Autosaver(store, null, {
    schedule: t.schedule,
    cancel: t.cancel,
  });
  saver.change("first");
  await t.fire(); // create in flight
  saver.change("first second");
  const flushed = saver.flush();
  release();
  store.gate = null;
  await flushed;
  assert.equal(store.creates, 1);
  assert.equal(store.notes.get("id1")!.body, "first second");
  assert.equal(saver.dirty, false);
});

test("autosave: a timer armed while flush() waits does not save the same text again", async () => {
  const store = new FakeStore();
  const t = timers();
  let release!: () => void;
  store.gate = new Promise((r) => (release = r));
  const saver = new Autosaver(store, null, {
    schedule: t.schedule,
    cancel: t.cancel,
  });
  saver.change("a");
  await t.fire(); // create in flight
  const flushed = saver.flush();
  saver.change("ab"); // arms a timer during the wait
  release();
  store.gate = null;
  await flushed;
  assert.equal(saver.dirty, false);
  const saves = store.saves;
  await t.fire();
  assert.equal(store.saves, saves, "no redundant save");
  assert.equal(store.notes.get("id1")!.body, "ab");
});

test("save error text: a deleted note is not promised a retry; other failures are", () => {
  assert.doesNotMatch(
    saveErrorText("This note was deleted"),
    /try again|Retrying|\.\./,
  );
  assert.match(saveErrorText("This note was deleted"), /deleted/);
  assert.equal(
    saveErrorText("database is locked."),
    "Not saved: database is locked. Murmur will try again.",
  );
  assert.equal(
    saveErrorText(undefined),
    "Not saved: unknown error. Murmur will try again.",
  );
});

test("autosave: a failed save keeps the text, says so, and retries", async () => {
  const store = new FakeStore();
  const t = timers();
  const errors: string[] = [];
  const saver = new Autosaver(store, null, {
    schedule: t.schedule,
    cancel: t.cancel,
    onState: (s, d) => s === "error" && errors.push(d.error ?? ""),
  });
  store.fail = true;
  saver.change("important");
  await t.fire();
  assert.equal(saver.status, "error");
  assert.match(errors[0], /locked/);
  assert.equal(saver.dirty, true);
  assert.equal(saveStateLabel("error"), "Not saved");
  store.fail = false;
  await t.fire(); // the retry
  assert.equal(saver.status, "saved");
  assert.equal(store.notes.get("id1")!.body, "important");
});

test("autosave: a newer saved copy is never overwritten without a choice", async () => {
  const store = new FakeStore();
  const n = await store.create("v1");
  const t = timers();
  const saver = new Autosaver(store, n, {
    schedule: t.schedule,
    cancel: t.cancel,
  });
  await store.save(n.id, "edited elsewhere", 1);
  saver.change("my edit");
  await t.fire();
  assert.equal(saver.status, "conflict");
  assert.equal(store.notes.get(n.id)!.body, "edited elsewhere");
  saver.change("my edit, more");
  assert.equal(t.size, 0, "no automatic save while in conflict");
  await saver.keepMine();
  assert.equal(store.notes.get(n.id)!.body, "my edit, more");
  assert.equal(saver.status, "saved");
});

test("autosave: use the saved copy instead", async () => {
  const store = new FakeStore();
  const n = await store.create("v1");
  const t = timers();
  const saver = new Autosaver(store, n, {
    schedule: t.schedule,
    cancel: t.cancel,
  });
  await store.save(n.id, "theirs", 1);
  saver.change("mine");
  await t.fire();
  assert.equal(saver.useSaved(), "theirs");
  assert.equal(saver.dirty, false);
});

// ---- Editor helpers ----------------------------------------------------------------------------

test("spacedInsertion: spaces only where words would run together", () => {
  assert.equal(spacedInsertion("", 0, 0, "Hello"), "Hello");
  assert.equal(spacedInsertion("Hi", 2, 2, "there"), " there");
  assert.equal(spacedInsertion("Hi ", 3, 3, "there"), "there");
  assert.equal(spacedInsertion("Hi", 2, 2, ", there"), ", there");
  assert.equal(spacedInsertion("(", 1, 1, "aside"), "aside");
  assert.equal(spacedInsertion("worldend", 0, 0, "Hello"), "Hello ");
  assert.equal(spacedInsertion("a XX b", 2, 4, "new"), "new");
  assert.equal(spacedInsertion("line\n", 5, 5, "next"), "next");
  assert.equal(spacedInsertion("emoji 🙂", 8, 8, "ok"), " ok");
});

test("replaceRange: replaces exactly the range and reports the cursor", () => {
  assert.deepEqual(replaceRange("abc def", 4, 7, "XYZ!"), {
    value: "abc XYZ!",
    cursor: 8,
  });
  assert.deepEqual(replaceRange("👋 hi", 0, 2, "Hey"), {
    value: "Hey hi",
    cursor: 3,
  });
});

test("tabs and routes", () => {
  const tabs = [{ key: "a" }, { key: "b" }, { key: "c" }];
  assert.equal(nextActiveTab(tabs, "b", "b"), "c");
  assert.equal(nextActiveTab(tabs, "c", "c"), "b");
  assert.equal(nextActiveTab(tabs, "a", "c"), "c");
  assert.equal(nextActiveTab([{ key: "a" }], "a", "a"), null);
  assert.deepEqual(parseNoteRoute("#note/abc-1"), { id: "abc-1" });
  assert.deepEqual(parseNoteRoute("#new"), { new: true });
  assert.deepEqual(parseNoteRoute(""), { resume: true });
  assert.deepEqual(parseNoteRoute("#note/../../x"), { resume: true });
});

test("noteWhen: relative labels", () => {
  const now = new Date(2026, 9, 19, 15, 0);
  assert.equal(noteWhen(now.getTime() - 10_000, now), "Just now");
  assert.equal(noteWhen(now.getTime() - 5 * 60_000, now), "5 min ago");
  assert.equal(noteWhen(new Date(2026, 9, 18, 9).getTime(), now), "Yesterday");
  assert.match(noteWhen(new Date(2025, 0, 2).getTime(), now), /2025/);
});

test("inserter: Secure Event Input at insert time keeps text out of the note window", async () => {
  const inner = new FakeInner();
  let direct = 0;
  const ins = new ScratchpadAwareInserter(
    inner,
    { acceptsDictation: () => true, insert: async () => (direct++, true) },
    () => {},
    () => true,
    42,
  );
  await ins.insert("secret", target());
  assert.equal(direct, 0);
  assert.equal(inner.calls.length, 1);
});

test("NoteRepo: deleting notes empties the write-ahead log; lists read only the start of each note", () => {
  const path = dbPath();
  const notes = new NoteRepo(openDatabase(path));
  const body = "sensitive ".repeat(10_000);
  notes.create("a", body);
  notes.save("a", `${body} more`, 1);
  assert.equal(notes.summaries()[0].body.length, 2000);
  assert.equal(notes.summaries("sensitive")[0].id, "a");
  notes.deleteAll();
  assert.equal(statSync(`${path}-wal`).size, 0);
});

test("Scratchpad AI edits go through Transforms: the selected text with the transform's prompt, nothing changed", async () => {
  const ai = fakeAi();
  const { svc, notes, logs } = service({}, ai);
  const n = svc.create({ body: "teh selected part and the rest" });
  const r = await svc.ai({
    requestId: "r1",
    transformId: "polish",
    text: "teh selected part",
  });
  assert.deepEqual(r, { text: "EDITED: teh selected part", name: "Polish" });
  assert.equal(ai.calls[0].user, "teh selected part");
  assert.match(ai.calls[0].system, /polish a person's writing/);
  assert.equal(notes.get(n.id)!.body, "teh selected part and the rest");
  assert.deepEqual(
    svc.transformsForMenu().map((t) => t.name),
    ["Polish", "Prompt Engineer"],
  );
  assert.doesNotMatch(JSON.stringify(logs), /teh selected/);
});

test("note window prefs: only openBehavior, font and size may change; AI consent never", () => {
  assert.deepEqual(
    NotePrefsPatchSchema.parse({ font: "mono", size: "large" }),
    {
      font: "mono",
      size: "large",
    },
  );
  assert.deepEqual(NotePrefsPatchSchema.parse({}), {});
  assert.throws(() => NotePrefsPatchSchema.parse({ aiConsent: ["groq"] }));
  assert.throws(() =>
    NotePrefsPatchSchema.parse({ font: "mono", aiConsent: ["groq"] }),
  );
  assert.throws(() => NotePrefsPatchSchema.parse({ font: "comic" }));
  assert.throws(() => NotePrefsPatchSchema.parse(null));
});
