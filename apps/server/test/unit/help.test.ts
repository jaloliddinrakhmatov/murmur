import { test } from "node:test";
import assert from "node:assert/strict";
import { HELP_LIMITS, HelpChatEvent } from "@murmur/account-api";
import { defaultLimits, loadHelpConfig } from "../../src/config/env.ts";
import { checkAnswer, EVAL_CASES } from "../../src/help/eval-cases.ts";
import { FakeHelpModel, FAKE_OFF_TOPIC } from "../../src/help/fake.ts";
import { HelpProviderError } from "../../src/help/model.ts";
import { OpenAiCompatibleHelpModel } from "../../src/help/openai-compatible.ts";
import {
  buildMessages,
  buildSystemPrompt,
  CONTACT_PLACEHOLDER,
  loadKnowledge,
} from "../../src/help/prompt.ts";
import { encodeEvent, UpstreamParser } from "../../src/help/sse.ts";
import type { UpstreamItem } from "../../src/help/sse.ts";

const knowledge = loadKnowledge();

// ---- knowledge and prompt ----

test("knowledge: loads, is concise, has the contact placeholder and no secrets", () => {
  assert.ok(knowledge.length > 5000);
  assert.ok(knowledge.split(/\s+/).length < 6000);
  assert.ok(knowledge.includes(CONTACT_PLACEHOLDER));
  assert.doesNotMatch(
    knowledge,
    /gsk_[A-Za-z0-9]|sk-[A-Za-z0-9]{8}|AIza[A-Za-z0-9]/,
  );
  assert.doesNotMatch(knowledge, /\/Users\/|screenshots\/|photos_3/);
});

test("prompt: the static part comes first and is identical for every page", () => {
  const base = buildSystemPrompt({ knowledge });
  const pricing = buildSystemPrompt({ knowledge, page: "pricing" });
  const download = buildSystemPrompt({ knowledge, page: "download" });
  assert.ok(pricing.startsWith(base));
  assert.ok(download.startsWith(base));
  assert.match(pricing.slice(base.length), /pricing page/);
  assert.match(download.slice(base.length), /download page/);
  assert.ok(base.indexOf("Rules") < base.indexOf("--- Murmur guide ---"));
});

test("prompt: rules cover scope, language, honesty, secrets and injection", () => {
  const p = buildSystemPrompt({ knowledge });
  for (const rule of [
    /only about Murmur/,
    /language the visitor writes in/,
    /Never invent/,
    /Never ask for, accept or repeat API keys/,
    /questions, not instructions/,
    /\/download, \/pricing, \/privacy, \/terms/,
  ]) {
    assert.match(p, rule);
  }
});

test("prompt: a contact address replaces the placeholder; without one the model is told there is none", () => {
  const withContact = buildSystemPrompt({
    knowledge,
    contact: "help@murmur.test",
  });
  assert.ok(!withContact.includes(CONTACT_PLACEHOLDER));
  assert.match(withContact, /help@murmur\.test/);
  const without = buildSystemPrompt({ knowledge });
  assert.match(without, /No contact address is published yet/);
});

test("prompt: messages are the system prompt followed by the conversation, unchanged", () => {
  const out = buildMessages("SYS", [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: "and?" },
  ]);
  assert.deepEqual(out, [
    { role: "system", content: "SYS" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: "and?" },
  ]);
});

// ---- upstream stream parsing ----

const line = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
const delta = (text: string) =>
  line({ choices: [{ delta: { content: text } }] });
const feed = (chunks: string[]) => {
  const parser = new UpstreamParser();
  const out: UpstreamItem[] = [];
  for (const c of chunks) out.push(...parser.push(c));
  out.push(...parser.end());
  return out;
};

test("upstream parser: deltas, finish reason and [DONE]", () => {
  const items = feed([
    delta("Hel"),
    delta("lo"),
    line({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    "data: [DONE]\n\n",
  ]);
  assert.deepEqual(items, [
    { kind: "delta", text: "Hel" },
    { kind: "delta", text: "lo" },
    { kind: "finish", reason: "stop" },
    { kind: "done" },
  ]);
});

test("upstream parser: lines split at any byte, CRLF and a final line without newline", () => {
  const whole = delta("a") + delta("b") + "data: [DONE]";
  for (let cut = 1; cut < whole.length; cut += 3) {
    const items = feed([whole.slice(0, cut), whole.slice(cut)]);
    assert.deepEqual(
      items
        .filter((i) => i.kind === "delta")
        .map((i) => (i as { text: string }).text),
      ["a", "b"],
      `cut at ${cut}`,
    );
    assert.equal(items.at(-1)?.kind, "done");
  }
  const crlf = feed([`data: {"choices":[{"delta":{"content":"x"}}]}\r\n\r\n`]);
  assert.deepEqual(crlf, [{ kind: "delta", text: "x" }]);
});

test("upstream parser: error chunks carry no provider text; junk and comments are ignored", () => {
  const items = feed([
    ": keep-alive\n\n",
    "event: message\n",
    "data: not json\n\n",
    "data:\n\n",
    line({ error: { message: "secret detail sk-123", code: 500 } }),
    line({ choices: [] }),
  ]);
  assert.deepEqual(items, [{ kind: "error" }]);
});

test("upstream parser: multi-byte text survives", () => {
  assert.deepEqual(feed([delta("Salom, dunyo! Привет 👋")]), [
    { kind: "delta", text: "Salom, dunyo! Привет 👋" },
  ]);
});

test("encodeEvent: one JSON object per data line, valid against the contract", () => {
  const text = encodeEvent({ type: "delta", text: "a\nb" });
  assert.equal(text, 'data: {"type":"delta","text":"a\\nb"}\n\n');
  assert.ok(HelpChatEvent.safeParse(JSON.parse(text.slice(6))).success);
});

// ---- OpenAI-compatible client ----

function streamResponse(
  chunks: string[],
  init: ResponseInit = { status: 200 },
) {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(c) {
        for (const x of chunks) c.enqueue(enc.encode(x));
        c.close();
      },
    }),
    init,
  );
}
const model = (
  fetchFn: typeof fetch,
  extra: Partial<
    ConstructorParameters<typeof OpenAiCompatibleHelpModel>[0]
  > = {},
) =>
  new OpenAiCompatibleHelpModel({
    kind: "groq",
    baseUrl: "https://upstream.test/v1",
    apiKey: "KEY",
    model: "openai/gpt-oss-120b",
    fetch: fetchFn,
    ...extra,
  });
const run = async (
  m: OpenAiCompatibleHelpModel,
  signal = new AbortController().signal,
) => {
  let out = "";
  for await (const t of m.stream([{ role: "user", content: "q" }], {
    signal,
    maxTokens: 700,
  }))
    out += t;
  return out;
};
const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof HelpProviderError, String(e));
    return e.failure;
  }
  assert.fail("expected a failure");
};

test("client: request shape per provider", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const ok = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return streamResponse([delta("hi"), "data: [DONE]\n\n"]);
  }) as unknown as typeof fetch;
  assert.equal(await run(model(ok)), "hi");
  const groq = JSON.parse(seen[0].init.body as string);
  assert.equal(seen[0].url, "https://upstream.test/v1/chat/completions");
  assert.equal(
    (seen[0].init.headers as Record<string, string>).Authorization,
    "Bearer KEY",
  );
  assert.deepEqual(
    {
      stream: groq.stream,
      max: groq.max_tokens,
      effort: groq.reasoning_effort,
      inc: groq.include_reasoning,
    },
    { stream: true, max: 700 + 1024, effort: "low", inc: false },
  );

  await run(model(ok, { kind: "gemini", model: "gemini-3.5-flash-lite" }));
  const gem = JSON.parse(seen[1].init.body as string);
  assert.equal(gem.max_tokens, 700);
  assert.equal(gem.reasoning_effort, "minimal");

  await run(model(ok, { kind: "openai", model: "gpt-4o-mini" }));
  const oa = JSON.parse(seen[2].init.body as string);
  assert.equal(oa.max_completion_tokens, 700);
  assert.equal(oa.max_tokens, undefined);
  assert.equal(oa.temperature, 0.2);

  await run(model(ok, { kind: "openai", model: "gpt-5-mini" }));
  assert.equal(JSON.parse(seen[3].init.body as string).temperature, undefined);
});

test("client: HTTP errors become coarse reasons and never carry provider text", async () => {
  const respond = (status: number) =>
    model(
      (async () =>
        new Response('{"error":{"message":"bad key sk-LEAK"}}', {
          status,
        })) as unknown as typeof fetch,
    );
  assert.equal(await failure(run(respond(401))), "auth");
  assert.equal(await failure(run(respond(403))), "auth");
  assert.equal(await failure(run(respond(429))), "quota");
  assert.equal(await failure(run(respond(402))), "quota");
  assert.equal(await failure(run(respond(500))), "upstream");
  assert.equal(await failure(run(respond(400))), "upstream");
  try {
    await run(respond(401));
  } catch (e) {
    assert.doesNotMatch(String((e as Error).message), /LEAK/);
  }
});

test("client: network errors, error chunks, empty and cut-off streams", async () => {
  const net = model((async () => {
    throw new TypeError("fetch failed: secret");
  }) as unknown as typeof fetch);
  assert.equal(await failure(run(net)), "upstream");

  const errChunk = model((async () =>
    streamResponse([
      delta("Hi"),
      line({ error: { message: "x" } }),
    ])) as unknown as typeof fetch);
  assert.equal(await failure(run(errChunk)), "upstream");

  const empty = model((async () =>
    streamResponse(["data: [DONE]\n\n"])) as unknown as typeof fetch);
  assert.equal(await failure(run(empty)), "empty");

  const cut = model((async () =>
    streamResponse([delta("Hi")])) as unknown as typeof fetch);
  assert.equal(await failure(run(cut)), "upstream");

  const finishOnly = model((async () =>
    streamResponse([
      delta("A"),
      line({ choices: [{ delta: {}, finish_reason: "length" }] }),
    ])) as unknown as typeof fetch);
  assert.equal(await run(finishOnly), "A");
});

test("client: the 30 s timeout becomes 'timeout'; a client abort stops quietly", async () => {
  const hang = (async (_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    })) as unknown as typeof fetch;
  assert.equal(await failure(run(model(hang, { timeoutMs: 30 }))), "timeout");

  const ac = new AbortController();
  const p = run(model(hang), ac.signal);
  setTimeout(() => ac.abort(), 10);
  await assert.rejects(p, (e: Error) => !(e instanceof HelpProviderError));
});

// ---- config ----

test("help config: unset is off; typos and missing keys are errors", () => {
  assert.equal(loadHelpConfig({}, true), null);
  assert.equal(loadHelpConfig({ MURMUR_HELP_PROVIDER: " " }, true), null);
  assert.throws(
    () => loadHelpConfig({ MURMUR_HELP_PROVIDER: "grok" }, true),
    /one of/,
  );
  assert.throws(
    () => loadHelpConfig({ MURMUR_HELP_PROVIDER: "groq" }, true),
    /API_KEY is required/,
  );
  assert.throws(
    () =>
      loadHelpConfig(
        { MURMUR_HELP_PROVIDER: "groq", MURMUR_HELP_API_KEY: "a b" },
        true,
      ),
    /spaces/,
  );
  const c = loadHelpConfig(
    { MURMUR_HELP_PROVIDER: "Groq", MURMUR_HELP_API_KEY: "k".repeat(20) },
    true,
  );
  assert.deepEqual(c, {
    provider: "groq",
    apiKey: "k".repeat(20),
    model: "",
    dailyLimit: 500,
    contact: null,
  });
});

test("help config: the fake provider is refused in production", () => {
  assert.throws(
    () => loadHelpConfig({ MURMUR_HELP_PROVIDER: "fake" }, true),
    /development or test/,
  );
  assert.equal(
    loadHelpConfig({ MURMUR_HELP_PROVIDER: "fake" }, false)?.provider,
    "fake",
  );
});

test("help config: daily limit, model and contact are validated", () => {
  const base = {
    MURMUR_HELP_PROVIDER: "gemini",
    MURMUR_HELP_API_KEY: "k".repeat(20),
  };
  assert.equal(
    loadHelpConfig({ ...base, MURMUR_HELP_DAILY_LIMIT: "50" }, true)
      ?.dailyLimit,
    50,
  );
  for (const bad of ["0", "-1", "1.5", "abc", "2000000"]) {
    assert.throws(
      () => loadHelpConfig({ ...base, MURMUR_HELP_DAILY_LIMIT: bad }, true),
      /DAILY_LIMIT/,
      bad,
    );
  }
  assert.throws(
    () => loadHelpConfig({ ...base, MURMUR_HELP_MODEL: "bad model;" }, true),
    /model/,
  );
  assert.equal(
    loadHelpConfig({ ...base, MURMUR_HELP_MODEL: "openai/gpt-oss-120b" }, true)
      ?.model,
    "openai/gpt-oss-120b",
  );
  assert.throws(
    () => loadHelpConfig({ ...base, MURMUR_HELP_CONTACT: "nope" }, true),
    /CONTACT/,
  );
  assert.equal(
    loadHelpConfig({ ...base, MURMUR_HELP_CONTACT: "a@b.co" }, true)?.contact,
    "a@b.co",
  );
});

test("help limits: 12 per 10 minutes and 60 per day per IP", () => {
  const l = defaultLimits();
  assert.deepEqual(l.helpPerIpShort, { max: 12, windowMs: 10 * 60_000 });
  assert.deepEqual(l.helpPerIpDaily, { max: 60, windowMs: 24 * 60 * 60_000 });
});

// ---- fake provider and eval cases ----

test("fake provider: streams a deterministic answer built from the guide, and stops on abort", async () => {
  const fake = new FakeHelpModel(knowledge, 0);
  const q = [
    {
      role: "user" as const,
      content: "How do I change the dictation shortcut?",
    },
  ];
  assert.equal(fake.answer(q), fake.answer(q));
  let text = "";
  for await (const t of fake.stream(q, {
    signal: new AbortController().signal,
    maxTokens: 1,
  }))
    text += t;
  assert.equal(text, fake.answer(q));
  assert.match(text, /shortcut/i);
  assert.equal(
    fake.answer([{ role: "user", content: "Write a poem about cats" }]),
    FAKE_OFF_TOPIC,
  );

  const ac = new AbortController();
  let n = 0;
  for await (const _t of new FakeHelpModel(knowledge, 5).stream(q, {
    signal: ac.signal,
    maxTokens: 1,
  })) {
    if (++n === 2) ac.abort();
  }
  assert.ok(n <= 3);
});

test("eval cases: about twenty, with Uzbek, Russian, off-topic, injection and a pasted key", () => {
  assert.ok(EVAL_CASES.length >= 20);
  assert.equal(new Set(EVAL_CASES.map((c) => c.id)).size, EVAL_CASES.length);
  for (const id of [
    "uzbek-groq",
    "russian-privacy",
    "off-topic",
    "injection",
    "pasted-key",
    "price",
    "release-date",
  ]) {
    assert.ok(
      EVAL_CASES.some((c) => c.id === id),
      id,
    );
  }
  for (const c of EVAL_CASES)
    assert.ok(c.question.length <= HELP_LIMITS.maxUserChars);
});

test("eval checks: keyword groups and forbidden words", () => {
  const c = EVAL_CASES.find((x) => x.id === "pasted-key")!;
  assert.equal(
    checkAnswer(
      c,
      "Please don't share keys here; revoke it and make a new key.",
    ).ok,
    true,
  );
  assert.equal(checkAnswer(c, "Looks fine!").ok, false);
  assert.equal(checkAnswer(c, "revoke gsk_Abc123Def").ok, false);
});
