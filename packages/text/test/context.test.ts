import { test } from "node:test";
import assert from "node:assert/strict";
import { applyStyle, contextTerms, correctedWords } from "../src/context.ts";

const formal =
  "Hey Joey, are we still on for coffee? I think we should leave earlier. There might be traffic.";

test("styles: formal unchanged, casual drops the final full stop, very casual lowercases starts", () => {
  assert.equal(applyStyle(formal, "formal"), formal);
  assert.equal(
    applyStyle(formal, "casual"),
    "Hey Joey, are we still on for coffee? I think we should leave earlier. There might be traffic",
  );
  assert.equal(
    applyStyle(formal, "veryCasual"),
    "hey Joey, are we still on for coffee? I think we should leave earlier. there might be traffic",
  );
  assert.equal(
    applyStyle("Ready?", "casual"),
    "Ready?",
    "questions keep their mark",
  );
});

test("very casual keeps I, I'm, acronyms and dictionary words", () => {
  assert.equal(
    applyStyle("I'm in. NASA called. Jaloliddin agrees.", "veryCasual", [
      "Jaloliddin",
    ]),
    "I'm in. NASA called. Jaloliddin agrees",
  );
  assert.equal(applyStyle("", "veryCasual"), "");
});

test("context terms: names mid-sentence, inner capitals and acronyms; not sentence starts or common words", () => {
  const text =
    "Thanks for the notes. I spoke with Dilnoza and Mr. Karimov about the iPhone launch at NVIDIA. The plan is fine. Dilnoza agrees.";
  assert.deepEqual(contextTerms(text), [
    "Dilnoza",
    "Karimov",
    "iPhone",
    "NVIDIA",
  ]);
  assert.deepEqual(contextTerms("hello there"), []);
  assert.equal(contextTerms("A Bbb Ccc Ddd Eee", 2).length, 2);
});

test("corrected words: a close re-spelling of one word, with its neighbours unchanged", () => {
  assert.deepEqual(
    correctedWords(
      "I met Jalolidin at the office.",
      "I met Jaloliddin at the office.",
    ),
    [{ heard: "Jalolidin", corrected: "Jaloliddin" }],
  );
  assert.deepEqual(
    correctedWords(
      "Send it to Kubernetes team",
      "Send it to the platform team",
    ),
    [],
    "a rewrite is not a correction",
  );
  assert.deepEqual(
    correctedWords("ship on friday", "ship on Friday"),
    [],
    "changing only capitals is not a correction",
  );
  assert.deepEqual(
    correctedWords("hello world", "hello world and more"),
    [],
    "additions aren't corrections",
  );
  assert.deepEqual(correctedWords("we use postgress", "we use Postgres"), [
    { heard: "postgress", corrected: "Postgres" },
  ]);
});
