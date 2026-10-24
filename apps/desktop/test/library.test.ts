import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DictionaryRepo,
  DuplicateError,
  SnippetRepo,
  openDatabase,
} from "../src/main/history/db.ts";
import { HubService, type HubServiceDeps } from "../src/main/hub/service.ts";
import type {
  DictionaryRow,
  SnippetIssue,
  SnippetRow,
} from "../src/shared/ipc.ts";
import {
  countLabel,
  filterDictionary,
  filterSnippets,
  oneLine,
  REPLACEMENT_MAX,
  searchKey,
  sortLibrary,
  type SortOrder,
  validateDictionary,
  validateSnippet,
} from "../src/renderer/hub/model/library.ts";

const tmp = () =>
  join(mkdtempSync(join(tmpdir(), "murmur-library-")), "db.sqlite");
let n = 0;
const newId = () => `id-${++n}`;

function service(path = tmp()) {
  const db = openDatabase(path);
  const dictionary = new DictionaryRepo(db);
  const snippets = new SnippetRepo(db);
  // Only the library parts of the service are exercised here.
  const hub = new HubService({
    dictionary,
    snippets,
    newId,
  } as unknown as HubServiceDeps);
  return { db, dictionary, snippets, hub };
}

// ---- Persistence ---------------------------------------------------------------------------

test("dictionary: create, edit, delete persist across a reopen, Unicode intact", () => {
  const path = tmp();
  const a = service(path);
  const cafe = a.hub.addDictionaryEntry({
    phrase: "Café Müller",
    misheardAs: "cafe muller",
  });
  const tash = a.hub.addDictionaryEntry({ phrase: "Toshkent" });
  a.hub.addDictionaryEntry({ phrase: "Oʻzbekiston" });
  a.hub.updateDictionaryEntry(
    { id: tash.id },
    { phrase: "Тошкент", misheardAs: "tashkent" },
  );
  a.hub.updateDictionaryEntry({ id: cafe.id }, { enabled: false });
  a.hub.deleteDictionaryEntry({
    id: a.dictionary.findByPhrase("Oʻzbekiston")!.id,
  });
  a.db.close();

  const b = service(path);
  const rows = b.hub.listDictionary();
  assert.deepEqual(
    rows.map((r) => [r.phrase, r.misheardAs, r.enabled]),
    [
      ["Café Müller", "cafe muller", false],
      ["Тошкент", "tashkent", true],
    ],
  );
  b.db.close();
});

test("dictionary: duplicates are rejected whatever the case, spacing or Unicode form", () => {
  const { hub, db } = service();
  hub.addDictionaryEntry({ phrase: "Café" });
  for (const phrase of ["café", "  CAFÉ ", "Café"]) {
    assert.throws(() => hub.addDictionaryEntry({ phrase }), DuplicateError);
  }
  const other = hub.addDictionaryEntry({ phrase: "NestJS" });
  assert.throws(
    () => hub.updateDictionaryEntry({ id: other.id }, { phrase: "café" }),
    DuplicateError,
  );
  assert.equal(hub.findDictionaryPhrase("CAFÉ")?.phrase, "Café");
  db.close();
});

test("snippets: create, edit, enable/disable, delete persist; long text round-trips", () => {
  const path = tmp();
  const a = service(path);
  const long = `${"Best regards,\nJaloliddin\n".repeat(160)}`.slice(
    0,
    REPLACEMENT_MAX,
  );
  assert.equal(long.length, REPLACEMENT_MAX);
  const sig = a.hub.addSnippet({ trigger: "my signature", replacement: long });
  const email = a.hub.addSnippet({
    trigger: "my email",
    replacement: "you@example.com",
  });
  a.hub.addSnippet({ trigger: "office address", replacement: "12 Example St" });
  a.hub.updateSnippet({ id: email.id }, { replacement: "me@example.com" });
  a.hub.updateSnippet({ id: sig.id }, { enabled: false });
  a.hub.deleteSnippet({ id: a.snippets.findByTrigger("office address")!.id });
  a.db.close();

  const b = service(path);
  const rows = b.hub.listSnippets();
  assert.deepEqual(
    rows.map((r) => [r.trigger, r.enabled]),
    [
      ["my email", true],
      ["my signature", false],
    ],
  );
  assert.equal(rows[0].replacement, "me@example.com");
  assert.equal(rows[1].replacement, long, "4000 characters, line breaks kept");
  assert.throws(() =>
    b.hub.addSnippet({ trigger: "too long", replacement: `${long}x` }),
  );
  b.db.close();
});

test("snippets: trigger conflicts block saving; warnings do not", () => {
  const { hub, db } = service();
  hub.addDictionaryEntry({ phrase: "NestJS" });
  hub.addSnippet({ trigger: "my email", replacement: "you@example.com" });
  const codes = (
    trigger: string,
    replacement = "x",
    exclude: string | null = null,
  ) => hub.checkSnippet({ trigger, replacement }, exclude).map((i) => i.code);

  assert.ok(codes("MY  EMAIL").includes("duplicate-trigger"));
  assert.ok(codes("nestjs").includes("trigger-is-dictionary-phrase"));
  assert.ok(codes("my email address").includes("trigger-overlaps"));
  assert.throws(() =>
    hub.addSnippet({ trigger: "My Email", replacement: "x" }),
  );
  assert.throws(() => hub.addSnippet({ trigger: "nestjs", replacement: "x" }));
  // A warning alone saves fine.
  assert.ok(hub.addSnippet({ trigger: "my email address", replacement: "x" }));
  // Editing a snippet does not conflict with itself.
  const own = hub.listSnippets().find((s) => s.trigger === "my email")!;
  assert.ok(!codes("my email", "y", own.id).includes("duplicate-trigger"));
  db.close();
});

test("snippet preview uses the unsaved draft and the same expansion as dictation", () => {
  const { hub, db } = service();
  const saved = hub.addSnippet({
    trigger: "my email",
    replacement: "you@example.com",
  });
  hub.addSnippet({ trigger: "sign off", replacement: "Thanks!" });
  hub.updateSnippet({ id: hub.listSnippets()[1].id }, { enabled: false });

  assert.equal(
    hub.previewSnippets("send it to my email"),
    "send it to you@example.com",
  );
  // A new draft joins the saved, enabled snippets.
  assert.equal(
    hub.previewSnippets("my email and my phone", {
      trigger: "my phone",
      replacement: "+998 90 000 00 00",
    }),
    "you@example.com and +998 90 000 00 00",
  );
  // Editing replaces the saved version; disabled snippets stay out.
  assert.equal(
    hub.previewSnippets("my email, sign off", {
      id: saved.id,
      trigger: "my email",
      replacement: "me@example.com",
    }),
    "me@example.com, sign off",
  );
  // An incomplete draft is ignored rather than failing.
  assert.equal(
    hub.previewSnippets("my email", { trigger: "", replacement: "" }),
    "you@example.com",
  );
  // Preview never writes.
  assert.equal(hub.listSnippets().length, 2);
  db.close();
});

// ---- Search ---------------------------------------------------------------------------------

const dict = (
  phrase: string,
  misheardAs: string | null = null,
): DictionaryRow => ({
  id: phrase,
  phrase,
  misheardAs,
  enabled: true,
  usageCount: 0,
  createdAt: 0,
  updatedAt: 0,
});
const snip = (trigger: string, replacement: string): SnippetRow => ({
  id: trigger,
  trigger,
  replacement,
  enabled: true,
  usageCount: 0,
  createdAt: 0,
  updatedAt: 0,
});

test("search is case-insensitive beyond ASCII and Unicode-normalized", () => {
  const rows = [
    dict("Café Müller"),
    dict("Тошкент", "tashkent"),
    dict("NestJS", "nest js"),
    dict("Oʻzbekiston"),
  ];
  const find = (q: string) => filterDictionary(rows, q).map((r) => r.phrase);
  assert.deepEqual(find("CAFÉ"), ["Café Müller"]);
  assert.deepEqual(find("café"), ["Café Müller"], "decomposed é");
  assert.deepEqual(find("тош"), ["Тошкент"]);
  assert.deepEqual(find("TASHKENT"), ["Тошкент"], "matches 'often heard as'");
  assert.deepEqual(find("nest   js"), ["NestJS"], "whitespace collapsed");
  assert.deepEqual(find("oʻz"), ["Oʻzbekiston"]);
  assert.deepEqual(find("zzz"), []);
  assert.equal(find("").length, 4, "empty query shows everything");
  assert.equal(find("   ").length, 4);
  assert.equal(searchKey("  ÀB  C "), "àb c");
  // Filtering never mutates the source.
  const before = JSON.stringify(rows);
  filterDictionary(rows, "café");
  assert.equal(JSON.stringify(rows), before);
});

test("snippet search covers trigger and replacement text", () => {
  const rows = [
    snip("my email", "you@example.com"),
    snip("sign off", "Ko‘rishguncha!\nJaloliddin"),
  ];
  const find = (q: string) => filterSnippets(rows, q).map((r) => r.trigger);
  assert.deepEqual(find("EXAMPLE"), ["my email"]);
  assert.deepEqual(find("ko‘rish"), ["sign off"]);
  assert.deepEqual(find("SIGN"), ["sign off"]);
});

test("list labels: counts and one-line previews", () => {
  assert.equal(countLabel(6, 6, ["word", "words"]), "6 words");
  assert.equal(countLabel(1, 1, ["word", "words"]), "1 word");
  assert.equal(countLabel(2, 6, ["word", "words"]), "2 of 6 words");
  assert.equal(
    oneLine("Best,\n\n  Alex\nExample Co."),
    "Best, / Alex / Example Co.",
  );
  assert.equal(oneLine("  one   line  "), "one line");
  const long = oneLine("a".repeat(500));
  assert.equal(long.length, 160);
  assert.ok(long.endsWith("…"));
});

// ---- Validation -----------------------------------------------------------------------------

test("dictionary validation: required errors wait for the field, duplicates show at once", () => {
  const opts = { editingId: null, duplicate: null, showRequired: false };
  assert.deepEqual(validateDictionary({ phrase: "", misheardAs: "" }, opts), {
    phrase: null,
    canSave: false,
  });
  assert.equal(
    validateDictionary(
      { phrase: "", misheardAs: "" },
      { ...opts, showRequired: true },
    ).phrase,
    "Enter the word or phrase.",
  );
  assert.equal(
    validateDictionary(
      { phrase: "a", misheardAs: "" },
      { ...opts, showRequired: true },
    ).phrase,
    "Use at least 2 characters.",
  );
  const existing = dict("Café");
  const dup = validateDictionary(
    { phrase: "café", misheardAs: "" },
    { ...opts, duplicate: existing },
  );
  assert.equal(dup.phrase, "“Café” is already in your dictionary.");
  assert.equal(dup.canSave, false);
  // Editing the same entry is not a duplicate of itself.
  assert.deepEqual(
    validateDictionary(
      { phrase: "CAFÉ", misheardAs: "" },
      { ...opts, editingId: existing.id, duplicate: existing },
    ),
    { phrase: null, canSave: true },
  );
});

test("snippet validation: errors by field, warnings never block", () => {
  const issues: SnippetIssue[] = [
    { level: "error", code: "empty-replacement" },
    { level: "warning", code: "trigger-common-word" },
  ];
  const hidden = validateSnippet({ trigger: "hi", replacement: "" }, issues, {
    showTriggerRequired: false,
    showReplacementRequired: false,
  });
  assert.equal(hidden.replacement, null, "untouched: no error shown yet");
  assert.equal(hidden.canSave, false, "but saving stays blocked");
  assert.equal(hidden.warnings.length, 1);

  const shown = validateSnippet({ trigger: "hi", replacement: "" }, issues, {
    showTriggerRequired: true,
    showReplacementRequired: true,
  });
  assert.equal(shown.replacement, "Enter the text to insert.");
  assert.equal(shown.trigger, null);

  const conflict = validateSnippet(
    { trigger: "my email", replacement: "x" },
    [{ level: "error", code: "duplicate-trigger" }],
    { showTriggerRequired: false, showReplacementRequired: false },
  );
  assert.equal(conflict.trigger, "Another snippet already uses this trigger.");
  assert.equal(conflict.canSave, false);

  const ok = validateSnippet(
    { trigger: "my email address", replacement: "x" },
    [{ level: "warning", code: "trigger-overlaps", detail: "my email" }],
    { showTriggerRequired: true, showReplacementRequired: true },
  );
  assert.equal(ok.canSave, true);
  assert.deepEqual(ok.warnings, [
    "Overlaps another trigger; when both match, the longer one wins. (“my email”)",
  ]);
});

test("sorting: every order is deterministic, works on search results, never changes the input", () => {
  const rows = [
    { id: "b", phrase: "Zeta", createdAt: 2, usageCount: 5 },
    { id: "a", phrase: "alpha", createdAt: 2, usageCount: 5 },
    { id: "c", phrase: "Émile", createdAt: 1, usageCount: 9 },
    { id: "d", phrase: "beta", createdAt: 3, usageCount: 0 },
  ];
  const copy = structuredClone(rows);
  const ids = (o: SortOrder, list = rows) =>
    sortLibrary(list, o, (r) => r.phrase).map((r) => r.id);
  assert.deepEqual(ids("newest"), ["d", "a", "b", "c"], "ties broken by id");
  assert.deepEqual(ids("oldest"), ["c", "a", "b", "d"]);
  assert.deepEqual(
    ids("az"),
    ["a", "d", "c", "b"],
    "case- and accent-insensitive",
  );
  assert.deepEqual(ids("used"), ["c", "a", "b", "d"], "then A to Z");
  assert.deepEqual(rows, copy, "input untouched");
  const searched = rows.filter((r) => r.phrase.toLowerCase().includes("e"));
  assert.deepEqual(ids("az", searched), ["d", "c", "b"]);
  assert.deepEqual(ids("used", []), []);
});
