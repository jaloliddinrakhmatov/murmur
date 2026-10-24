import { test } from "node:test";
import assert from "node:assert/strict";
import { guardrail, numberTokens, refine, sanitize } from "../src/refine.ts";
import { processTranscript } from "../src/pipeline.ts";
import { AnthropicCleanupProvider } from "../src/providers/anthropic.ts";
import { OpenAICompatibleCleanupProvider } from "../src/providers/openai-compatible.ts";
import {
  CleanupProviderError,
  type CleanupProvider,
  type FetchLike,
} from "../src/types.ts";

test("numbers: decimals stay distinct from thousands separators", () => {
  assert.deepEqual(numberTokens("1.5 and 15 and 1,250.40 and 1.500"), [
    "1.5",
    "15",
    "1250.40",
    "1500",
  ]);
  assert.equal(
    guardrail("take 1.5 mg twice", "Take 15 mg twice."),
    "numbers-changed",
  );
  assert.equal(guardrail("take 1.5 mg twice", "Take 1.5 mg twice."), null);
});

test("numbers: a backtrack exempts only the number it replaces", () => {
  assert.equal(
    guardrail(
      "sorry, the total is 4,250 dollars",
      "Sorry, the total is 4,520 dollars.",
    ),
    "numbers-changed",
  );
  assert.equal(
    guardrail("let's meet at 2 actually 3", "Let's meet at 3."),
    null,
  );
  assert.equal(
    guardrail("meet at 2, actually 3, and pay 40", "Meet at 3 and pay 41."),
    "numbers-changed",
  );
});

test("numbers: numbers that were never said are rejected, spelled-out ones allowed", () => {
  assert.equal(
    guardrail("what is 2 plus 2", "What is 2 plus 2? 4"),
    "numbers-changed",
  );
  assert.equal(guardrail("move it to ten thirty", "Move it to 10:30."), null);
  assert.equal(
    guardrail(
      "the budget is fifty thousand scratch that sixty thousand dollars",
      "The budget is $60,000.",
    ),
    null,
  );
  assert.equal(
    guardrail("in twenty twenty five we grew", "In 2025 we grew."),
    null,
  );
  assert.equal(
    guardrail("we have three open tickets", "We have 7 open tickets."),
    "numbers-changed",
  );
});

test("negations: Russian and Uzbek words count", () => {
  assert.equal(
    guardrail(
      "я не хочу идти домой сегодня вечером",
      "Я хочу идти домой сегодня вечером.",
    ),
    "negation-changed",
  );
  assert.equal(
    guardrail("bu to'g'ri emas deb o'ylayman", "Bu to'g'ri deb o'ylayman."),
    "negation-changed",
  );
  assert.equal(
    guardrail("u yoqdi yo‘q kelmaydi bugun", "U yoqdi kelmaydi bugun."),
    "negation-changed",
  );
  assert.equal(
    guardrail("я не хочу идти домой", "Я не хочу идти домой."),
    null,
  );
});

test("pipeline: the casing pass never chains dictionary rules", async () => {
  const dictionary = [
    { id: "a", phrase: "Kubernetes", misheardAs: "cube netes" },
    { id: "b", phrase: "KubeCon", misheardAs: "Kubernetes" },
  ];
  const ai: CleanupProvider = {
    id: "f",
    kind: "cloud",
    readiness: async () => null,
    cleanup: async () => ({ text: "Deploy Kubernetes today." }),
  };
  const det = await processTranscript("deploy cube netes today", {
    mode: "deterministic",
    dictionary,
  });
  assert.equal(det.text, "Deploy Kubernetes today.");
  const viaAi = await processTranscript("deploy cube netes today", {
    mode: "ai",
    dictionary,
    ai: { provider: ai, timeoutMs: 1000 },
  });
  assert.equal(viaAi.text, "Deploy Kubernetes today.");
  // An explicit misheard rule beats another entry's casing rule for the same source.
  const direct = await processTranscript("deploy kubernetes today", {
    mode: "deterministic",
    dictionary,
  });
  assert.equal(direct.text, "Deploy KubeCon today.");
});

test("a timeout is a timeout even when the provider wraps the abort", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((_url: string, init?: RequestInit) =>
    new Promise((_res, rej) => {
      init?.signal?.addEventListener("abort", () =>
        rej(new DOMException("aborted", "AbortError")),
      );
    })) as typeof fetch;
  try {
    const p = new AnthropicCleanupProvider({ apiKey: "k" });
    const r = await refine("hello there friend", p, { timeoutMs: 30 });
    assert.equal(r.reason, "timeout");
    await assert.rejects(
      p.cleanup("x", { signal: AbortSignal.timeout(30) }),
      (e: Error) => e.name === "TimeoutError",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a timeout is a timeout when the provider throws something generic", async () => {
  const p: CleanupProvider = {
    id: "g",
    kind: "cloud",
    readiness: async () => null,
    cleanup: (_raw, { signal }) =>
      new Promise((_res, rej) =>
        signal.addEventListener("abort", () => rej(new Error("request ended"))),
      ),
  };
  assert.equal((await refine("a b c", p, { timeoutMs: 20 })).reason, "timeout");
});

test("sanitize keeps quotes the person dictated", () => {
  const quoted = '"Hello," she said, "how are you?"';
  assert.equal(sanitize(quoted, quoted), quoted);
  assert.equal(sanitize(quoted, "hello she said how are you"), quoted);
  assert.equal(sanitize('"Hi there."', "hi there"), "Hi there.");
  assert.equal(sanitize("“Hi there.”", "hi there"), "Hi there.");
  assert.equal(sanitize('"Hi there."', '"hi there"'), '"Hi there."');
});

test("pipeline: the dictation language reaches deterministic cleanup", async () => {
  const uz = await processTranscript("bu er kishi", {
    mode: "deterministic",
    language: "uz",
  });
  assert.equal(uz.text, "Bu er kishi.");
  const auto = await processTranscript("so um it works", {
    mode: "deterministic",
  });
  assert.equal(auto.text, "So it works.");
  const ru = await processTranscript("so um it works", {
    mode: "deterministic",
    language: "ru",
  });
  assert.equal(ru.text, "So um it works.");
});

test("numbers: correct cleanups of spoken numbers pass", () => {
  const ok: [string, string][] = [
    ["I have twenty five apples", "I have 25 apples."],
    ["about one hundred twenty people", "About 120 people."],
    ["one point five percent", "1.5%"],
    ["it was nineteen ninety nine", "It was 1999."],
    ["three thousand five hundred dollars", "$3,500."],
    ["zero point two five", "0.25"],
    ["fifty fifty chance", "50/50 chance."],
    ["fifty fifty chance", "5050 chance."],
  ];
  for (const [raw, out] of ok) assert.equal(guardrail(raw, out), null, raw);
  assert.equal(
    guardrail("it grew one point five percent", "It grew 15%."),
    "numbers-changed",
  );
  assert.equal(
    guardrail("we have twenty five apples today", "We have 26 apples today."),
    "numbers-changed",
  );
  assert.equal(
    guardrail("it grew one point five percent", "It grew 1.6%."),
    "numbers-changed",
  );
});

test("refine provider: Gemini's 400 invalid-key answer is an auth error, and keys are scrubbed", async () => {
  const key = "AIza" + "x".repeat(30);
  const make = (id: string, status: number, body: string) =>
    new OpenAICompatibleCleanupProvider({
      id,
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      model: "m",
      fetch: (async () => new Response(body, { status })) as FetchLike,
    });
  const signal = new AbortController().signal;
  const body = `{"error":{"message":"API key not valid. Please pass a valid API key ${key}","status":"INVALID_ARGUMENT"}}`;
  await assert.rejects(
    make("gemini:m", 400, body).cleanup("x", { signal }),
    (e: CleanupProviderError) =>
      e.status === 401 &&
      e.message.includes("HTTP 401") &&
      !e.message.includes(key),
  );
  await assert.rejects(
    make("groq:m", 400, body).cleanup("x", { signal }),
    (e: CleanupProviderError) => e.status === 400,
  );
  await assert.rejects(
    make("gemini:m", 400, "bad request Bearer abcdef123456789").cleanup("x", {
      signal,
    }),
    (e: CleanupProviderError) =>
      e.status === 400 && !e.message.includes("abcdef123456789"),
  );
});
