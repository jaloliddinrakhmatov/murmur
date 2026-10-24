// M2 pipeline through the real DictationController: dictionary, snippets, AI cleanup with
// fallback, vocabulary hints, provenance in History, and retry.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CleanupProvider } from "@murmur/refine";
import {
  DictationController,
  type ProcessingConfig,
} from "../src/main/core/controller.ts";
import {
  FakeAudio,
  FakeCancelHotkey,
  FakeCapsule,
  FakeClock,
  FakeHistory,
  FakeInserter,
  FakeProvider,
  FakeVault,
  fakeTarget,
  flush,
  realHold,
} from "./helpers.ts";

function aiProvider(
  behavior: (raw: string, signal: AbortSignal) => Promise<string>,
): CleanupProvider {
  return {
    id: "fake-ai",
    kind: "cloud",
    readiness: async () => null,
    cleanup: async (raw, { signal }) => ({ text: await behavior(raw, signal) }),
  };
}

function setup(processing: ProcessingConfig) {
  const clock = new FakeClock();
  const s = {
    clock,
    audio: new FakeAudio(),
    capsule: new FakeCapsule(),
    inserter: new FakeInserter(),
    history: new FakeHistory(),
    vault: new FakeVault(),
    provider: new FakeProvider(),
    hits: [] as {
      dictionary: Record<string, number>;
      snippets: Record<string, number>;
    }[],
    vocab: [] as (string[] | undefined)[],
  };
  const original = s.provider.transcribe.bind(s.provider);
  s.provider.transcribe = async (
    audio: unknown,
    options: { signal?: AbortSignal; vocabulary?: string[] },
  ) => {
    s.vocab.push(options.vocabulary);
    return original(audio, options);
  };
  let n = 0;
  const controller = new DictationController(
    {
      hold: realHold(),
      audio: s.audio,
      target: fakeTarget(),
      inserter: s.inserter,
      capsule: s.capsule,
      cancelHotkey: new FakeCancelHotkey(),
      history: s.history,
      vault: s.vault,
      provider: () => s.provider,
      processing: () => processing,
      onHits: (h) => s.hits.push(h),
      clock,
      newId: () => `d${++n}`,
      log: () => {},
    },
    { resultDisplayMs: 100 },
  );
  return { ...s, controller };
}

async function dictate(s: ReturnType<typeof setup>, settleMs = 0) {
  s.controller.hotkey("down");
  await flush();
  await s.clock.advance(1500);
  s.controller.hotkey("up");
  await flush();
  await flush();
  if (settleMs) await new Promise((r) => setTimeout(r, settleMs));
}

const dictionary = [
  { id: "nest", phrase: "NestJS", misheardAs: "nest js" },
  { id: "eld", phrase: "ELD", misheardAs: "yield" },
  { id: "bol", phrase: "Bill of Lading" },
];
const snippets = [
  { id: "email", trigger: "my email", replacement: "ravshan@example.com" },
];

test("deterministic mode: dictionary and snippets are applied before insertion; hits recorded; provenance stored", async () => {
  const s = setup({
    mode: "deterministic",
    dictionary,
    snippets,
    vocabulary: ["NestJS", "ELD", "Bill of Lading"],
  });
  s.provider.text = "um the yield report and the bill of lading go to my email";
  await dictate(s);
  assert.equal(
    s.inserter.calls[0].text,
    "The ELD report and the Bill of Lading go to ravshan@example.com.",
  );
  const row = s.history.only;
  assert.equal(
    row.rawText,
    "um the yield report and the bill of lading go to my email",
  );
  assert.equal(row.cleanupUsed, "deterministic");
  assert.equal(row.cleanupNote, null);
  assert.deepEqual(
    s.vocab[0],
    ["NestJS", "ELD", "Bill of Lading"],
    "dictionary sent as vocabulary hints",
  );
  assert.deepEqual(s.hits[0], {
    dictionary: { eld: 1, bol: 1 },
    snippets: { email: 1 },
  });
});

test("AI mode: a good result is used and its latency recorded", async () => {
  const s = setup({
    mode: "ai",
    dictionary,
    snippets: [],
    vocabulary: [],
    ai: {
      provider: aiProvider(async () => "Deploy nestjs tonight, not tomorrow."),
      timeoutMs: 1000,
    },
  });
  s.provider.text = "um deploy deploy nest js tonight not tomorrow";
  await dictate(s);
  assert.equal(
    s.inserter.calls[0].text,
    "Deploy NestJS tonight, not tomorrow.",
  );
  assert.equal(s.history.only.cleanupUsed, "ai");
  assert.match(s.history.only.cleanupNote ?? "", /^ai-latency:\d+ms$/);
  assert.deepEqual(
    s.capsule.states.map((x) => x.state),
    ["listening", "processing", "refining", "inserting", "inserted"],
    "AI cleanup shows its own step",
  );
});

test("AI mode: timeout falls back to deterministic cleanup and the dictation still inserts", async () => {
  const slow = aiProvider(
    (_raw, signal) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve("too late"), 500);
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          reject(signal.reason);
        });
      }),
  );
  const s = setup({
    mode: "ai",
    dictionary: [],
    snippets: [],
    vocabulary: [],
    ai: { provider: slow, timeoutMs: 30 },
  });
  s.provider.text = "um hello comma world";
  await dictate(s, 120);
  assert.equal(s.inserter.calls[0].text, "Hello, world.");
  assert.equal(s.history.only.status, "inserted");
  assert.equal(s.history.only.cleanupUsed, "deterministic");
  assert.equal(s.history.only.cleanupNote, "ai-fallback:timeout");
});

test("AI mode: an answered question is rejected; the dictation is inserted as dictated and the rejected output is kept for review", async () => {
  const s = setup({
    mode: "ai",
    dictionary: [],
    snippets: [],
    vocabulary: [],
    ai: { provider: aiProvider(async () => "Paris"), timeoutMs: 1000 },
  });
  s.provider.text = "what is the capital of France";
  await dictate(s);
  assert.equal(s.inserter.calls[0].text, "What is the capital of France.");
  assert.equal(s.history.only.cleanupNote, "ai-fallback:length-collapse");
  assert.equal(s.history.only.aiRejectedText, "Paris");
});

test("AI mode: a dropped negation is rejected", async () => {
  const s = setup({
    mode: "ai",
    dictionary: [],
    snippets: [],
    vocabulary: [],
    ai: {
      provider: aiProvider(
        async () => "Deploy to production until the migration finishes.",
      ),
      timeoutMs: 1000,
    },
  });
  s.provider.text = "do not deploy to production until the migration finishes";
  await dictate(s);
  assert.equal(
    s.inserter.calls[0].text,
    "Do not deploy to production until the migration finishes.",
  );
  assert.equal(s.history.only.cleanupNote, "ai-fallback:negation-changed");
});

test("snippet replacement text is inserted verbatim, never expanded twice or cleaned", async () => {
  const s = setup({
    mode: "deterministic",
    dictionary: [],
    snippets: [{ id: "loop", trigger: "ping", replacement: "ping pong" }],
    vocabulary: [],
  });
  s.provider.text = "ping";
  await dictate(s);
  assert.equal(s.inserter.calls[0].text, "ping pong");
});

test("retry runs the same pipeline (dictionary + snippets) and copies the result", async () => {
  const s = setup({
    mode: "deterministic",
    dictionary,
    snippets,
    vocabulary: [],
  });
  s.provider.fail = new Error("HTTP 503");
  await dictate(s);
  const row = s.history.only;
  assert.equal(row.status, "failed");
  s.provider.fail = null;
  s.provider.text = "send the bill of lading to my email";
  const copied: string[] = [];
  const after = await s.controller.retry(
    row.id,
    async (t) => void copied.push(t),
  );
  assert.deepEqual(copied, ["Send the Bill of Lading to ravshan@example.com."]);
  assert.equal(after?.cleanupUsed, "deterministic");
});

test("off mode keeps the raw words but still applies dictionary and snippets", async () => {
  const s = setup({ mode: "off", dictionary, snippets, vocabulary: [] });
  s.provider.text = "um the yield report to my email";
  await dictate(s);
  assert.equal(
    s.inserter.calls[0].text,
    "um the ELD report to ravshan@example.com",
  );
  assert.equal(s.history.only.cleanupUsed, "off");
});
