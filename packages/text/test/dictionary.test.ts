import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDictionary, type DictionaryEntry } from "../src/dictionary.ts";
import { checkSnippet, expandSnippets, type Snippet } from "../src/snippets.ts";

const dict: DictionaryEntry[] = [
  { id: "samsara", phrase: "Samsara" },
  { id: "macropoint", phrase: "Macropoint", misheardAs: "macro point" },
  { id: "eld", phrase: "ELD", misheardAs: "yield" },
  { id: "bol", phrase: "Bill of Lading" },
  { id: "nest", phrase: "NestJS", misheardAs: "nest js" },
  { id: "pg", phrase: "PostgreSQL", misheardAs: "postgres sequel" },
  { id: "dilnoza", phrase: "Dilnoza", misheardAs: "dill nose a" },
];

test("enforces casing and replaces misheard spellings, whole words, case-insensitively", () => {
  const r = applyDictionary(
    "we track samsara and Macro Point data with yield logs in postgres sequel and nest js",
    dict,
  );
  assert.equal(
    r.text,
    "we track Samsara and Macropoint data with ELD logs in PostgreSQL and NestJS",
  );
  assert.deepEqual(r.hits, {
    samsara: 1,
    macropoint: 1,
    eld: 1,
    pg: 1,
    nest: 1,
  });
});

test("longest phrase wins and multi-word phrases keep their casing", () => {
  const r = applyDictionary("send the bill of lading and the lading note", [
    ...dict,
    { id: "lading", phrase: "Lading" },
  ]);
  assert.equal(r.text, "send the Bill of Lading and the Lading note");
});

test("never touches partial words, URLs, emails or paths", () => {
  const r = applyDictionary(
    "yields are fine; see https://yield.example.com/eld and bob@yield.io or ~/eld/notes",
    dict,
  );
  assert.equal(
    r.text,
    "yields are fine; see https://yield.example.com/eld and bob@yield.io or ~/eld/notes",
  );
  assert.deepEqual(r.hits, {});
});

test("one pass: a replacement is never re-matched by another rule", () => {
  const chain: DictionaryEntry[] = [
    { id: "a", phrase: "beta", misheardAs: "alpha" },
    { id: "b", phrase: "gamma", misheardAs: "beta" },
  ];
  assert.equal(applyDictionary("alpha beta", chain).text, "beta gamma");
});

test("Unicode: Cyrillic, Uzbek apostrophes and accents", () => {
  const entries: DictionaryEntry[] = [
    { id: "t", phrase: "Toshkent", misheardAs: "tosh kent" },
    { id: "o", phrase: "O‘zbekiston" },
    { id: "m", phrase: "Москва", misheardAs: "масква" },
    { id: "z", phrase: "Zoë" },
  ];
  const r = applyDictionary("tosh kent, o‘zbekiston, масква and zoë", entries);
  assert.equal(r.text, "Toshkent, O‘zbekiston, Москва and Zoë");
  assert.equal(applyDictionary("dill nose a", dict).text, "Dilnoza");
});

test("disabled entries and tiny phrases are ignored", () => {
  assert.equal(
    applyDictionary("a eld", [
      { id: "x", phrase: "ELD", enabled: false },
      { id: "y", phrase: "A" },
    ]).text,
    "a eld",
  );
});

const snippets: Snippet[] = [
  { id: "email", trigger: "my email", replacement: "ravshan@example.com" },
  { id: "sig", trigger: "my signature", replacement: "Best regards,\nRavshan" },
  {
    id: "addr",
    trigger: "office address",
    replacement: "12 Amir Temur Avenue, Tashkent",
  },
];

test("snippet spoken alone yields the replacement verbatim", () => {
  assert.equal(
    expandSnippets("My email.", snippets).text,
    "ravshan@example.com",
  );
  assert.equal(
    expandSnippets("my signature", snippets).text,
    "Best regards,\nRavshan",
  );
});

test("snippet inside a sentence is replaced in place; capitalization and adjacent punctuation ignored", () => {
  const r = expandSnippets("Please send it to My email, thanks.", snippets);
  assert.equal(r.text, "Please send it to ravshan@example.com, thanks.");
  assert.deepEqual(r.hits, { email: 1 });
  assert.equal(
    expandSnippets("my emails are full", snippets).text,
    "my emails are full",
    "no partial-word match",
  );
});

test("expansion is single-pass: replacements containing triggers are not re-expanded", () => {
  const loop: Snippet[] = [
    { id: "l", trigger: "ping", replacement: "ping pong" },
  ];
  assert.equal(expandSnippets("say ping", loop).text, "say ping pong");
  assert.equal(expandSnippets("ping", loop).text, "ping pong");
});

test("longest trigger wins when triggers overlap", () => {
  const both: Snippet[] = [
    { id: "a", trigger: "my email", replacement: "A" },
    { id: "b", trigger: "my email address", replacement: "B" },
  ];
  assert.equal(
    expandSnippets("use my email address now", both).text,
    "use B now",
  );
  assert.equal(expandSnippets("use my email now", both).text, "use A now");
});

test("conflict detection: duplicates, overlaps, dictionary clash, common words, self-reference", () => {
  const others: Snippet[] = [
    { id: "a", trigger: "my email", replacement: "x" },
  ];
  const codes = (s: Snippet, dict: string[] = []) =>
    checkSnippet(s, others, dict).map((i) => `${i.level}:${i.code}`);
  assert.deepEqual(codes({ id: "n", trigger: "My Email!", replacement: "y" }), [
    "error:duplicate-trigger",
  ]);
  assert.deepEqual(
    codes({ id: "n", trigger: "my email address", replacement: "y" }),
    ["warning:trigger-overlaps"],
  );
  assert.deepEqual(codes({ id: "n", trigger: "thanks", replacement: "y" }), [
    "warning:trigger-common-word",
  ]);
  assert.deepEqual(
    codes({ id: "n", trigger: "samsara", replacement: "y" }, ["Samsara"]),
    ["error:trigger-is-dictionary-phrase"],
  );
  assert.deepEqual(
    codes({ id: "n", trigger: "ping", replacement: "ping pong" }),
    ["warning:replacement-contains-trigger"],
  );
  assert.deepEqual(codes({ id: "n", trigger: "  ", replacement: "" }), [
    "error:empty-trigger",
    "error:empty-replacement",
  ]);
  assert.deepEqual(
    codes({ id: "a", trigger: "my email", replacement: "edited" }),
    [],
    "editing itself is not a duplicate",
  );
});
