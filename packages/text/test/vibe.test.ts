import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyIdentifiers,
  identifierHints,
  identifiersIn,
  tagFileMentions,
} from "../src/index.ts";

const tag = (t: string, files: string[] = []) => tagFileMentions(t, files);

test("file mentions: spoken names with a known extension", () => {
  assert.equal(tag("Look at index dot tsx"), "Look @index.tsx");
  assert.equal(tag("at index dot tsx"), "@index.tsx");
  assert.equal(tag("Fix at index dot tsx."), "Fix @index.tsx.");
  assert.equal(
    tag("check at src slash app dot ts please"),
    "check @src/app.ts please",
  );
  assert.equal(tag("open the index dot tsx file"), "open the @index.tsx");
  assert.equal(tag("Index dot tsx file is broken."), "@index.tsx is broken.");
  assert.equal(tag("see at my underscore file dot py"), "see @my_file.py");
  assert.equal(tag("at a dot b dot ts, then c"), "@a.b.ts, then c");
  assert.equal(
    tag("compare at app dot ts and at lib slash util dot js now"),
    "compare @app.ts and @lib/util.js now",
  );
});

test("file mentions: already written names after 'at' or before 'file'", () => {
  assert.equal(
    tag("look at index.tsx and fix it"),
    "look @index.tsx and fix it",
  );
  assert.equal(tag("look at src/app.ts."), "look @src/app.ts.");
  assert.equal(tag("the app.ts file is broken"), "the @app.ts is broken");
  assert.equal(tag("see package.json"), "see package.json");
});

test("file mentions: negatives leave the words alone", () => {
  for (const t of [
    "meet at six dot com tomorrow",
    "at home dot",
    "send it to john dot smith at example dot org",
    "the dot product of two vectors",
    "look at the index dot tsx",
    "visit example.com at noon",
    "a file named index dot tsx",
    "index dot tsx",
    "at index dot banana",
    "Is it at 5 dot 30?",
    "",
  ])
    assert.equal(tag(t), t, t);
});

test("file mentions: real files give the exact spelling and multi-word names", () => {
  const files = [
    "src/hooks/useAuth.ts",
    "src/App.tsx",
    "README.md",
    "a/index.tsx",
    "b/index.tsx",
  ];
  assert.equal(tag("at use auth dot ts", files), "@useAuth.ts");
  assert.equal(tag("look at app dot tsx", files), "look @App.tsx");
  assert.equal(
    tag("at hooks slash use auth dot ts", files),
    "@hooks/useAuth.ts",
  );
  assert.equal(tag("the read me dot md file", files), "the @README.md");
  assert.equal(tag("at index dot tsx", files), "@index.tsx");
  // Without a real file a multi-word name is not guessed.
  assert.equal(tag("at use auth dot ts", []), "at use auth dot ts");
  assert.equal(tag("at use auth dot ts", ["other.ts"]), "at use auth dot ts");
  // At most four plain words.
  assert.equal(
    tag("at one two three four five dot ts", ["onetwothreefourfive.ts"]),
    "at one two three four five dot ts",
  );
});

test("file mentions: more than one in a sentence, trailing punctuation kept", () => {
  assert.equal(
    tag("Compare at a dot ts with b dot ts file, please."),
    "Compare @a.ts with @b.ts, please.",
  );
});

const ids = (t: string) => identifiersIn(t);

test("identifiers: every common case is recognised and split", () => {
  const found = ids(
    "const userName = getUserById(user_id); const MAX_RETRY_COUNT = 3; <my-component /> class HttpClient {}; parseURLPath()",
  );
  const byName = Object.fromEntries(found.map((i) => [i.name, i.words]));
  assert.deepEqual(byName.userName, ["user", "name"]);
  assert.deepEqual(byName.getUserById, ["get", "user", "by", "id"]);
  assert.deepEqual(byName.user_id, ["user", "id"]);
  assert.deepEqual(byName.MAX_RETRY_COUNT, ["max", "retry", "count"]);
  assert.deepEqual(byName["my-component"], ["my", "component"]);
  assert.deepEqual(byName.HttpClient, ["http", "client"]);
  assert.deepEqual(byName.parseURLPath, ["parse", "url", "path"]);
});

test("identifiers: ordinary words are not identifiers", () => {
  assert.deepEqual(
    ids("The quick brown Fox jumped over Paris. Hello World"),
    [],
  );
  assert.deepEqual(ids("x = 1 + y"), []);
  assert.deepEqual(identifierHints("foo bar baz"), []);
  // Capitalised words and long runs are not names.
  assert.deepEqual(ids("Monday Tuesday"), []);
});

test("identifiers: hints are capped, deduplicated and ordered by use", () => {
  const text =
    "aB cD aB eF aB cD " +
    Array.from(
      { length: 50 },
      (_, i) => `fooBar${String.fromCharCode(97 + (i % 26))}Baz${i}`,
    ).join(" ");
  const hints = identifierHints(text, 10);
  assert.equal(hints.length, 10);
  assert.equal(new Set(hints).size, 10);
  assert.deepEqual(hints.slice(0, 2), ["aB", "cD"]);
});

test("spoken identifiers are written as in the code nearby", () => {
  const code = identifiersIn(
    "const userName = getUserById(id); const MAX_RETRY_COUNT = 3; <my-component/> HttpClient",
  );
  assert.equal(
    applyIdentifiers("set user name to null", code),
    "set userName to null",
  );
  assert.equal(
    applyIdentifiers("call get user by id now", code),
    "call getUserById now",
  );
  assert.equal(
    applyIdentifiers("User name is empty.", code),
    "userName is empty.",
  );
  assert.equal(
    applyIdentifiers("use max retry count here", code),
    "use MAX_RETRY_COUNT here",
  );
  assert.equal(
    applyIdentifiers("render my component", code),
    "render my-component",
  );
  assert.equal(applyIdentifiers("a Http client", code), "a HttpClient");
  assert.equal(
    applyIdentifiers("the user name, then get user by id.", code),
    "the userName, then getUserById.",
  );
});

test("spoken identifiers: the most used spelling wins, snake_case when that is nearby", () => {
  const snake = identifiersIn("user_name = x; print(user_name)");
  assert.equal(applyIdentifiers("the user name", snake), "the user_name");
  const both = identifiersIn("userName userName user_name");
  assert.equal(applyIdentifiers("the user name", both), "the userName");
});

test("spoken identifiers: negatives never rewrite ordinary prose", () => {
  const code = identifiersIn("const userName = getUserById(id)");
  for (const t of [
    "the user is named bob",
    "user, name",
    "user  name",
    "my username",
    "get user",
    "the user\nname",
    "by id get user",
    "",
  ])
    assert.equal(applyIdentifiers(t, code), t, JSON.stringify(t));
  assert.equal(applyIdentifiers("set user name", []), "set user name");
  // Part of something already written in code is left as is.
  assert.equal(applyIdentifiers("a.user name", code), "a.user name");
  assert.equal(applyIdentifiers("user name_x", code), "user name_x");
});

test("spoken identifiers: the longest identifier wins over a shorter one inside it", () => {
  const code = identifiersIn("userName getUserName getUserName");
  assert.equal(applyIdentifiers("get user name", code), "getUserName");
  assert.equal(applyIdentifiers("user name", code), "userName");
});
