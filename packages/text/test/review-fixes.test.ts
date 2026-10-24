import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanup } from "../src/cleanup.ts";
import { applyDictionary } from "../src/dictionary.ts";
import { expandSnippets } from "../src/snippets.ts";
import { countWords } from "../src/words.ts";
import { applyStyle, contextTerms, correctedWords } from "../src/context.ts";

const clean = (s: string) => cleanup(s).text;

test("fillers: real words survive, asides and hesitations go", () => {
  assert.equal(clean("do you know where it is"), "Do you know where it is.");
  assert.equal(clean("I mean it"), "I mean it.");
  assert.equal(clean("what I mean is simple"), "What I mean is simple.");
  assert.equal(clean("the bolt is 5 mm wide"), "The bolt is 5 mm wide.");
  assert.equal(clean("take him to the ER now"), "Take him to the ER now.");
  assert.equal(clean("er bilan xotin".replace("er", "Er")), "Er bilan xotin.");
  // Asides set off by commas or at the edges of a sentence.
  assert.equal(
    clean("we should, you know, move the standup"),
    "We should, move the standup.",
  );
  assert.equal(clean("it was good, you know."), "It was good.");
  assert.equal(clean("I mean, it works"), "It works.");
  assert.equal(
    clean("you know, it works. I mean, mostly"),
    "It works. Mostly.",
  );
  assert.equal(clean("it works, I mean, mostly"), "It works, mostly.");
  // Hesitation sounds: lowercase only for the ambiguous ones.
  assert.equal(clean("we uh ship, um, today"), "We ship, today.");
  assert.equal(clean("Um, we ship today"), "We ship today.");
});

test("spoken punctuation: period and question mark only where they are commands", () => {
  assert.equal(
    clean("the trial period ends friday"),
    "The trial period ends friday.",
  );
  assert.equal(clean("the meeting is over period"), "The meeting is over.");
  assert.equal(
    clean("the meeting is over period new paragraph next topic"),
    "The meeting is over.\n\nNext topic.",
  );
  assert.equal(clean("what is the period"), "What is the period.");
  assert.equal(clean("is it done question mark"), "Is it done?");
});

test("tidy-up keeps dots before letters, ellipses and ?!", () => {
  assert.equal(clean("I use .NET daily"), "I use .NET daily.");
  assert.equal(clean("wait... what?!"), "Wait... What?!");
  assert.equal(clean("hello period."), "Hello.");
  assert.equal(clean("well…"), "Well…");
});

test("terminal punctuation in other scripts is not followed by a full stop", () => {
  for (const s of [
    "你好吗？",
    "我很好。",
    "यह किताब है।",
    "كيف حالك؟",
    "Wait…",
    "He said “yes”",
    "«Bonjour»",
  ])
    assert.equal(clean(s), s);
  assert.equal(clean("hello"), "Hello.");
});

test("dictionary and snippets respect combining marks", () => {
  const dict = [{ id: "d", phrase: "Cafe", misheardAs: "cafe" }];
  const nfd = "I like café here";
  assert.equal(applyDictionary(nfd, dict).text, nfd.normalize("NFC"));
  assert.deepEqual(applyDictionary(nfd, dict).hits, {});
  assert.equal(
    applyDictionary("a cafe b", dict).text,
    "a Cafe b",
    "a whole word still fires",
  );
  const snip = [{ id: "s", trigger: "क", replacement: "KA" }];
  assert.equal(expandSnippets("कि और क", snip).text, "कि और KA");
  const s2 = [{ id: "s", trigger: "cafe", replacement: "X" }];
  assert.deepEqual(expandSnippets("café now", s2).hits, {});
});

test("countWords keeps Uzbek apostrophes and combining marks inside words", () => {
  assert.equal(countWords("O‘zbekiston bog‘ida"), 2);
  assert.equal(countWords("oʻzbek gʼoya"), 2);
  assert.equal(countWords("किताब"), 1);
  assert.equal(countWords("café au lait"), 3);
});

test("applyStyle stays fast on pathological newlines", () => {
  const t0 = performance.now();
  applyStyle("\n".repeat(10000) + "x", "veryCasual");
  applyStyle("a" + "\n".repeat(10000), "veryCasual");
  assert.ok(performance.now() - t0 < 100, `took ${performance.now() - t0} ms`);
  assert.equal(
    applyStyle("Done.\n\n  Next one.\nAnd more.", "veryCasual"),
    "done.\n\n  next one.\nand more",
  );
});

test("context terms: a capitalised word after a newline starts a sentence", () => {
  assert.deepEqual(contextTerms("Hi Sarah\nWelcome everyone"), ["Sarah"]);
});

test("corrected words: only name or term corrections, never ordinary edits", () => {
  for (const [a, b] of [
    ["see you Monday", "see you Sunday"],
    ["meet at 5pm", "meet at 6pm"],
    ["a letter form Bob", "a letter from Bob"],
    ["put it their", "put it there"],
    ["in june we ship", "in June we ship"],
    ["we ship in march", "we ship in May"],
    ["ship it fast", "ship it Fast"],
    ["oh wich one", "oh Which one"],
  ])
    assert.deepEqual(correctedWords(a, b), [], `${a} -> ${b}`);
  assert.deepEqual(
    correctedWords("met Jalolidin today", "met Jaloliddin today"),
    [{ heard: "Jalolidin", corrected: "Jaloliddin" }],
  );
  assert.deepEqual(correctedWords("we use postgress", "we use Postgres"), [
    { heard: "postgress", corrected: "Postgres" },
  ]);
  assert.deepEqual(correctedWords("an ayfone case", "an iPhone case"), []);
});

test("fillers: English hesitations and asides go only for English or automatic language", () => {
  const uz = (s: string) => cleanup(s, "light", { language: "uz" }).text;
  assert.equal(uz("bu er kishi"), "Bu er kishi.", "Uzbek er means man");
  assert.equal(uz("men um uh ah ketdim"), "Men um uh ah ketdim.");
  assert.equal(
    cleanup("you know, men keldim", "light", { language: "ru" }).text,
    "You know, men keldim.",
  );
  for (const language of [undefined, "", "en", "en-US", "EN_gb"]) {
    assert.equal(
      cleanup("it was, you know, um good", "light", { language }).text,
      "It was, good.",
      `language ${JSON.stringify(language)}`,
    );
  }
  // Only fillers depend on the language: spoken punctuation and casing are unchanged.
  assert.equal(uz("salom new paragraph dunyo"), "Salom\n\nDunyo.");
  // "enter" is not English; nor is a language that merely starts with "en".
  assert.equal(cleanup("a um b", "light", { language: "enx" }).text, "A um b.");
});
