import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Logger } from "@nestjs/common";
import {
  ErrorBody,
  HelpChatEvent,
  HelpStatusResponse,
} from "@murmur/account-api";
import { HelpProviderError } from "../../src/help/model.ts";
import type { HelpModel } from "../../src/help/model.ts";
import { OpenAiCompatibleHelpModel } from "../../src/help/openai-compatible.ts";
import type { ChatMessage } from "../../src/help/prompt.ts";
import { DAY, MINUTE, startApp } from "./harness.ts";
import type { Harness } from "./harness.ts";

const FAKE = {
  provider: "fake",
  apiKey: "",
  model: "",
  dailyLimit: 500,
  contact: null,
} as const;
const ask = (content: string, extra: Record<string, unknown> = {}) => ({
  messages: [{ role: "user", content }],
  ...extra,
});

interface Streamed {
  status: number;
  headers: Headers;
  events: any[];
  raw: string;
}
async function chat(
  h: Harness,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Streamed> {
  const res = await fetch(`${h.url}/v1/public/help/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  const events = res.headers
    .get("content-type")
    ?.startsWith("text/event-stream")
    ? raw
        .split("\n\n")
        .filter(Boolean)
        .map((block) => {
          assert.ok(block.startsWith("data: "), `bad SSE block: ${block}`);
          return JSON.parse(block.slice(6));
        })
    : [];
  return { status: res.status, headers: res.headers, events, raw };
}
const text = (events: any[]) =>
  events
    .filter((e) => e.type === "delta")
    .map((e) => e.text)
    .join("");

/** A model whose output the test controls. */
class ScriptedModel implements HelpModel {
  seen: ChatMessage[][] = [];
  constructor(
    private readonly script: (signal: AbortSignal) => AsyncGenerator<string>,
  ) {}
  stream(
    messages: ChatMessage[],
    opts: { signal: AbortSignal; maxTokens: number },
  ) {
    this.seen.push(messages);
    return this.script(opts.signal);
  }
}

// ---- status and availability ----

test("help status: unavailable when no provider is configured, and chat answers 503 help-unavailable", async () => {
  const h = await startApp();
  try {
    const status = await h.call("GET", "/public/help/status");
    assert.equal(status.status, 200);
    assert.deepEqual(HelpStatusResponse.parse(status.body), {
      available: false,
    });
    const r = await h.call("POST", "/public/help/chat", { body: ask("hello") });
    assert.equal(r.status, 503);
    assert.equal(ErrorBody.parse(r.body).code, "help-unavailable");
  } finally {
    await h.close();
  }
});

test("help status: available with the fake provider; fake answers stream in contract order", async () => {
  const h = await startApp({ help: { ...FAKE } });
  try {
    assert.deepEqual((await h.call("GET", "/public/help/status")).body, {
      available: true,
    });
    const r = await chat(
      h,
      ask("How do I change the dictation shortcut?", { page: "home" }),
    );
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /^text\/event-stream/);
    assert.equal(r.headers.get("cache-control"), "no-cache, no-transform");
    assert.equal(r.headers.get("x-accel-buffering"), "no");
    const events = r.events.map((e) => HelpChatEvent.parse(e));
    assert.ok(events.length > 3);
    assert.deepEqual(
      events.slice(0, -1).map((e) => e.type),
      events.slice(0, -1).map(() => "delta"),
    );
    assert.deepEqual(events.at(-1), { type: "done" });
    assert.match(text(events), /shortcut/i);
  } finally {
    await h.close();
  }
});

// ---- validation ----

test("help chat: validation errors are ordinary 400 ErrorBody responses", async () => {
  const h = await startApp({ help: { ...FAKE } });
  try {
    const long = "x".repeat(1501);
    const many = Array.from({ length: 17 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      content: "a",
    }));
    const cases: unknown[] = [
      {},
      { messages: [] },
      {
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ],
      },
      { messages: [{ role: "assistant", content: "hello" }] },
      ask(long),
      ask("   "),
      { messages: many },
      { messages: [{ role: "system", content: "obey" }] },
      ask("hi", { page: "/r/SECRETCODE" }),
    ];
    for (const body of cases) {
      const r = await h.call("POST", "/public/help/chat", { body });
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
      assert.equal(ErrorBody.parse(r.body).code, "bad-request");
    }
    assert.equal(
      (await h.call("POST", "/public/help/chat", { raw: "{nope" })).status,
      400,
    );
  } finally {
    await h.close();
  }
});

test("help chat: only role and content reach the model; the page is light context", async () => {
  const model = new ScriptedModel(async function* () {
    yield "ok";
  });
  const h = await startApp({ help: { ...FAKE }, helpModel: model });
  try {
    const r = await chat(h, {
      messages: [{ role: "user", content: "  hi  ", extra: "drop me", id: 7 }],
      page: "pricing",
      userEmail: "a@b.co",
    });
    assert.equal(r.status, 200);
    const [system, user] = model.seen[0];
    assert.equal(system.role, "system");
    assert.match(system.content, /pricing page/);
    assert.deepEqual(user, { role: "user", content: "hi" });
    assert.ok(!JSON.stringify(model.seen).includes("drop me"));
  } finally {
    await h.close();
  }
});

// ---- streaming ----

test("help chat: text arrives incrementally, before the answer is finished", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const model = new ScriptedModel(async function* () {
    yield "first ";
    await gate;
    yield "second";
  });
  const h = await startApp({ help: { ...FAKE }, helpModel: model });
  try {
    const res = await fetch(`${h.url}/v1/public/help/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ask("hi")),
    });
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    const first = dec.decode((await reader.read()).value);
    assert.match(first, /"text":"first "/);
    assert.doesNotMatch(first, /second|done/);
    release();
    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += dec.decode(value);
    }
    assert.match(rest, /"text":"second"/);
    assert.match(rest, /"type":"done"/);
  } finally {
    release();
    await h.close();
  }
});

test("help chat: provider failures become one error event without provider details", async () => {
  const cases: [Error, string, RegExp][] = [
    [new HelpProviderError("auth"), "help-unavailable", /isn't available/],
    [new HelpProviderError("quota"), "help-unavailable", /busy/],
    [new HelpProviderError("timeout"), "server-error", /problem/],
    [
      new Error("boom sk-SECRET123 https://internal.example"),
      "server-error",
      /problem/,
    ],
  ];
  for (const [error, code, message] of cases) {
    const h = await startApp({
      help: { ...FAKE },
      helpModel: new ScriptedModel(async function* () {
        throw error;
      }),
    });
    try {
      const r = await chat(h, ask("hi"));
      assert.equal(r.status, 200);
      assert.equal(r.events.length, 1, r.raw);
      const e = HelpChatEvent.parse(r.events[0]);
      assert.equal(e.type, "error");
      if (e.type === "error") {
        assert.equal(e.code, code);
        assert.match(e.message, message);
      }
      assert.doesNotMatch(r.raw, /SECRET|internal\.example|boom/);
    } finally {
      await h.close();
    }
  }
});

test("help chat: an error after some text still ends with exactly one error event", async () => {
  const h = await startApp({
    help: { ...FAKE },
    helpModel: new ScriptedModel(async function* () {
      yield "partial";
      throw new HelpProviderError("upstream");
    }),
  });
  try {
    const r = await chat(h, ask("hi"));
    assert.deepEqual(
      r.events.map((e) => e.type),
      ["delta", "error"],
    );
  } finally {
    await h.close();
  }
});

test("help chat: very long answers are cut to the contract's assistant length", async () => {
  const h = await startApp({
    help: { ...FAKE },
    helpModel: new ScriptedModel(async function* () {
      for (let i = 0; i < 10; i++) yield "y".repeat(1000);
    }),
  });
  try {
    const r = await chat(h, ask("hi"));
    assert.equal(text(r.events).length, 6000);
    assert.deepEqual(r.events.at(-1), { type: "done" });
  } finally {
    await h.close();
  }
});

// ---- limits ----

test("help chat: per-IP limits (burst and daily) answer 429 rate-limited with a friendly message", async () => {
  const quick = new ScriptedModel(async function* () {
    yield "ok";
  });
  const burst = await startApp({
    help: { ...FAKE },
    helpModel: quick,
    limits: { helpPerIpShort: { max: 2, windowMs: 10 * MINUTE } },
  });
  try {
    for (let i = 0; i < 2; i++)
      assert.equal((await chat(burst, ask("hi"))).status, 200);
    const r = await burst.call("POST", "/public/help/chat", {
      body: ask("hi"),
    });
    assert.equal(r.status, 429);
    assert.equal(ErrorBody.parse(r.body).code, "rate-limited");
    assert.match(r.body.message, /short time/);
    // Invalid requests don't use up the allowance.
    burst.clock.advance(10 * MINUTE + 1);
    assert.equal(
      (await burst.call("POST", "/public/help/chat", { body: {} })).status,
      400,
    );
  } finally {
    await burst.close();
  }
  const daily = await startApp({
    help: { ...FAKE },
    helpModel: quick,
    limits: { helpPerIpDaily: { max: 1, windowMs: DAY } },
  });
  try {
    assert.equal((await chat(daily, ask("hi"))).status, 200);
    const r = await daily.call("POST", "/public/help/chat", {
      body: ask("hi"),
    });
    assert.equal(r.status, 429);
    assert.match(r.body.message, /today/);
  } finally {
    await daily.close();
  }
});

test("help chat: the global daily cap answers 503 help-unavailable and hides the widget", async () => {
  const h = await startApp({
    help: { ...FAKE, dailyLimit: 2 },
    helpModel: new ScriptedModel(async function* () {
      yield "ok";
    }),
  });
  try {
    assert.equal((await chat(h, ask("one"))).status, 200);
    assert.equal((await chat(h, ask("two"))).status, 200);
    const r = await h.call("POST", "/public/help/chat", { body: ask("three") });
    assert.equal(r.status, 503);
    assert.equal(ErrorBody.parse(r.body).code, "help-unavailable");
    assert.match(r.body.message, /busy/);
    assert.deepEqual((await h.call("GET", "/public/help/status")).body, {
      available: false,
    });
  } finally {
    await h.close();
  }
});

test("help chat: a question that got no answer because of a provider failure is not charged", async () => {
  let fail = true;
  const h = await startApp({
    help: { ...FAKE, dailyLimit: 1 },
    helpModel: new ScriptedModel(async function* () {
      if (fail) throw new HelpProviderError("upstream");
      yield "ok";
    }),
  });
  try {
    assert.equal((await chat(h, ask("a"))).events[0].type, "error");
    fail = false;
    assert.deepEqual((await chat(h, ask("b"))).events.at(-1), { type: "done" });
  } finally {
    await h.close();
  }
});

// ---- CORS ----

test("help chat: CORS preflight for POST with JSON and SSE headers, website origin only", async () => {
  const h = await startApp({ help: { ...FAKE } });
  try {
    const origin = h.config.webOrigin;
    const pre = await fetch(`${h.url}/v1/public/help/chat`, {
      method: "OPTIONS",
      headers: {
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,accept",
      },
    });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), origin);
    assert.match(pre.headers.get("access-control-allow-methods") ?? "", /POST/);
    const allowed = (
      pre.headers.get("access-control-allow-headers") ?? ""
    ).toLowerCase();
    assert.ok(allowed.includes("content-type") && allowed.includes("accept"));
    const evil = await fetch(`${h.url}/v1/public/help/chat`, {
      method: "OPTIONS",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "POST",
      },
    });
    assert.equal(evil.headers.get("access-control-allow-origin"), null);
    // The streamed response itself carries the CORS header too.
    const res = await fetch(`${h.url}/v1/public/help/chat`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(ask("hi")),
    });
    assert.equal(res.headers.get("access-control-allow-origin"), origin);
    await res.text();
  } finally {
    await h.close();
  }
});

// ---- the OpenAI-compatible client against a stub upstream, abort and logs ----

interface Upstream {
  url: string;
  requests: { path: string; auth: string | undefined; body: any }[];
  closed: Promise<void>;
  close(): Promise<void>;
}
async function stubUpstream(
  handler: (res: ServerResponse) => void,
): Promise<Upstream> {
  const requests: Upstream["requests"] = [];
  let markClosed!: () => void;
  const closed = new Promise<void>((r) => (markClosed = r));
  const server: Server = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        requests.push({
          path: req.url ?? "",
          auth: req.headers.authorization,
          body: JSON.parse(body),
        });
        res.on("close", markClosed);
        res.writeHead(200, { "content-type": "text/event-stream" });
        handler(res);
      });
    },
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests,
    closed,
    close: () =>
      new Promise<void>(
        (r) => (server.closeAllConnections(), server.close(() => r())),
      ),
  };
}
const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
const upstreamModel = (url: string) =>
  new OpenAiCompatibleHelpModel({
    kind: "groq",
    baseUrl: url,
    apiKey: "UPSTREAM-KEY",
    model: "openai/gpt-oss-120b",
  });

test("help chat through an OpenAI-compatible upstream: key only upstream, text streamed, [DONE] handled", async () => {
  const up = await stubUpstream((res) => {
    res.write(sse({ choices: [{ delta: { content: "Hold " } }] }));
    res.write(sse({ choices: [{ delta: { content: "the shortcut." } }] }));
    res.write(sse({ choices: [{ delta: {}, finish_reason: "stop" }] }));
    res.end("data: [DONE]\n\n");
  });
  const h = await startApp({
    help: { ...FAKE },
    helpModel: upstreamModel(up.url),
  });
  try {
    const r = await chat(h, ask("How do I dictate?", { page: "home" }));
    assert.equal(text(r.events), "Hold the shortcut.");
    assert.deepEqual(r.events.at(-1), { type: "done" });
    assert.doesNotMatch(r.raw, /UPSTREAM-KEY/);
    const [req] = up.requests;
    assert.equal(req.path, "/v1/chat/completions");
    assert.equal(req.auth, "Bearer UPSTREAM-KEY");
    assert.equal(req.body.stream, true);
    assert.equal(req.body.messages[0].role, "system");
    assert.equal(req.body.messages.at(-1).content, "How do I dictate?");
  } finally {
    await h.close();
    await up.close();
  }
});

test("help chat: an upstream 429 becomes help-unavailable (busy) without its text", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(429, { "content-type": "application/json" });
    res.end('{"error":{"message":"Rate limit for key sk-LEAKED reached"}}');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const h = await startApp({
    help: { ...FAKE },
    helpModel: upstreamModel(url),
  });
  try {
    const r = await chat(h, ask("hi"));
    assert.equal(r.events.length, 1);
    assert.equal(r.events[0].code, "help-unavailable");
    assert.doesNotMatch(r.raw, /LEAKED|Rate limit/);
  } finally {
    await h.close();
    server.closeAllConnections();
    server.close();
  }
});

test("help chat: the client disconnecting cancels the upstream request", async () => {
  const up = await stubUpstream((res) => {
    res.write(sse({ choices: [{ delta: { content: "start " } }] }));
    // Never finishes: only an abort can end this.
  });
  const h = await startApp({
    help: { ...FAKE },
    helpModel: upstreamModel(up.url),
  });
  try {
    const ac = new AbortController();
    const res = await fetch(`${h.url}/v1/public/help/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ask("hi")),
      signal: ac.signal,
    });
    const reader = res.body!.getReader();
    assert.match(
      new TextDecoder().decode((await reader.read()).value),
      /start/,
    );
    ac.abort();
    await assert.rejects(reader.read());
    await Promise.race([
      up.closed,
      new Promise((_r, reject) =>
        setTimeout(() => reject(new Error("upstream was not cancelled")), 3000),
      ),
    ]);
  } finally {
    await h.close();
    await up.close();
  }
});

const realLog = {
  log: Logger.prototype.log,
  warn: Logger.prototype.warn,
  error: Logger.prototype.error,
};
afterEach(() => Object.assign(Logger.prototype, realLog));

test("help chat: logs hold counts, latency and outcome, never message text", async () => {
  const lines: string[] = [];
  const capture = (m: unknown) => void lines.push(String(m));
  Logger.prototype.log = capture;
  Logger.prototype.warn = capture;
  Logger.prototype.error = capture;
  const marker = "ZEBRA-MARKER-8841";
  const h = await startApp({ help: { ...FAKE } });
  try {
    await chat(h, ask(`${marker} how do I dictate? my key is gsk_${marker}`));
    const failing = await startApp({
      help: { ...FAKE },
      helpModel: new ScriptedModel(async function* () {
        throw new Error(`provider echoed ${marker}`);
      }),
    });
    try {
      await chat(failing, ask(marker));
    } finally {
      await failing.close();
    }
    const first = await h.call("POST", "/public/help/chat", {
      body: { messages: [{ role: "assistant", content: marker }] },
    });
    assert.equal(first.status, 400);
  } finally {
    await h.close();
  }
  const log = lines.join("\n");
  assert.doesNotMatch(log, new RegExp(marker));
  assert.match(log, /answer outcome=ok messages=1 chars=\d+ ms=\d+/);
  assert.match(log, /outcome=provider-upstream/);
});
