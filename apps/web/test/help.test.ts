import assert from "node:assert/strict";
import { test } from "node:test";
import { HELP_LIMITS } from "@murmur/account-api";
import {
  buildRequestMessages,
  checkHelpStatus,
  createSseParser,
  helpFailureMessage,
  pageKind,
  parseStoredChat,
  resetHelpStatusCache,
  serializeChat,
  streamHelp,
  type HelpFailureKind,
  type HelpTurn,
  type StreamLimits,
} from "../src/lib/help.ts";
import {
  parseInline,
  parseMarkdown,
  safeHref,
  type Block,
  type Inline,
} from "../src/lib/help-markdown.ts";

const BASE = "http://help.test/v1";

function events(...chunks: string[]) {
  const out: string[] = [];
  const parser = createSseParser((d) => out.push(d));
  for (const c of chunks) parser.push(c);
  parser.end();
  return out;
}

test("sse: one event per blank line, split anywhere", () => {
  const text = 'data: {"a":1}\n\ndata: {"b":2}\n\n';
  assert.deepEqual(events(text), ['{"a":1}', '{"b":2}']);
  for (let cut = 0; cut <= text.length; cut++) {
    assert.deepEqual(events(text.slice(0, cut), text.slice(cut)), [
      '{"a":1}',
      '{"b":2}',
    ]);
  }
});

test("sse: CRLF, CR, a CRLF split between chunks, no space after colon", () => {
  assert.deepEqual(events("data:x\r\n\r\ndata: y\r\r"), ["x", "y"]);
  assert.deepEqual(events("data: a\r", "\n\r", "\ndata: b\r\n\r\n"), [
    "a",
    "b",
  ]);
});

test("sse: comments, other fields, BOM, multi-line data, unterminated tail", () => {
  assert.deepEqual(events(": keep-alive\n\n"), []);
  assert.deepEqual(
    events("﻿event: message\nid: 3\nretry: 5\ndata: a\ndata: b\n\n"),
    ["a\nb"],
  );
  assert.deepEqual(events("data: last"), ["last"]);
  assert.deepEqual(events("data: a\n\n: ping\n\ndata: b\n\n"), ["a", "b"]);
});

function sseResponse(
  parts: (string | Uint8Array)[],
  init: { delayMs?: number; hang?: boolean; type?: string } = {},
): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const part of parts) {
        if (init.delayMs) await new Promise((r) => setTimeout(r, init.delayMs));
        controller.enqueue(typeof part === "string" ? enc.encode(part) : part);
      }
      if (!init.hang) controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": init.type ?? "text/event-stream" },
  });
}

const delta = (text: string) =>
  `data: ${JSON.stringify({ type: "delta", text })}\n\n`;
const DONE = `data: ${JSON.stringify({ type: "done" })}\n\n`;
const ask: HelpTurn[] = [{ role: "user", content: "How do I set up Murmur?" }];

async function run(
  fetchImpl: typeof fetch,
  extra: { signal?: AbortSignal; limits?: StreamLimits; online?: boolean } = {},
) {
  const got: string[] = [];
  const result = await streamHelp({
    messages: ask,
    page: "home",
    base: BASE,
    fetchImpl,
    onDelta: (t) => got.push(t),
    signal: extra.signal,
    limits: extra.limits,
    isOnline: () => extra.online ?? true,
  });
  return { result, text: got.join("") };
}

test("stream: deltas then done, split mid-line and multibyte", async () => {
  const bytes = new TextEncoder().encode(
    delta("Héllo ") + delta("wörld") + DONE,
  );
  const cut = 17;
  const { result, text } = await run((async () =>
    sseResponse([bytes.slice(0, cut), bytes.slice(cut)])) as typeof fetch);
  assert.deepEqual(result, { ok: true });
  assert.equal(text, "Héllo wörld");
});

test("stream: request shape (no path, trimmed body)", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  await run((async (url: string, init: RequestInit) => {
    seen = { url, init };
    return sseResponse([DONE]);
  }) as unknown as typeof fetch);
  assert.ok(seen);
  const s = seen as { url: string; init: RequestInit };
  assert.equal(s.url, `${BASE}/public/help/chat`);
  assert.equal(s.init.method, "POST");
  assert.equal(s.init.credentials, "omit");
  assert.deepEqual(JSON.parse(String(s.init.body)), {
    messages: ask,
    page: "home",
  });
});

test("stream: error event after text keeps what arrived", async () => {
  const err = `data: ${JSON.stringify({ type: "error", code: "server-error", message: "x" })}\n\n`;
  const { result, text } = await run((async () =>
    sseResponse([delta("Par"), err, delta("ignored")])) as typeof fetch);
  assert.deepEqual(result, { ok: false, kind: "server" });
  assert.equal(text, "Par");
});

test("stream: help-unavailable and rate-limited events", async () => {
  for (const [code, kind] of [
    ["help-unavailable", "unavailable"],
    ["rate-limited", "rate-limited"],
  ] as const) {
    const err = `data: ${JSON.stringify({ type: "error", code, message: "x" })}\n\n`;
    const { result } = await run((async () =>
      sseResponse([err])) as typeof fetch);
    assert.deepEqual(result, { ok: false, kind });
  }
});

test("stream: ends without done is interrupted; junk events are skipped", async () => {
  const { result, text } = await run((async () =>
    sseResponse([
      "data: not json\n\n",
      'data: {"type":"wat"}\n\n',
      delta("a"),
    ])) as typeof fetch);
  assert.deepEqual(result, { ok: false, kind: "interrupted" });
  assert.equal(text, "a");
});

test("stream: HTTP errors map to kinds", async () => {
  const cases: [number, unknown, HelpFailureKind][] = [
    [429, { code: "rate-limited", message: "slow" }, "rate-limited"],
    [503, { code: "help-unavailable", message: "off" }, "unavailable"],
    [400, { code: "bad-request", message: "bad" }, "invalid"],
    [500, { code: "server-error", message: "boom" }, "server"],
    [502, null, "server"],
  ];
  for (const [status, body, kind] of cases) {
    const { result } = await run(
      (async () =>
        new Response(body === null ? "<html>" : JSON.stringify(body), {
          status,
        })) as typeof fetch,
    );
    assert.deepEqual(result, { ok: false, kind }, String(status));
  }
});

test("stream: a 200 that is not an event stream is a server problem", async () => {
  const { result } = await run((async () =>
    sseResponse([DONE], { type: "application/json" })) as typeof fetch);
  assert.deepEqual(result, { ok: false, kind: "server" });
});

test("stream: offline, unreachable, not configured", async () => {
  const boom = (async () => {
    throw new TypeError("Failed to fetch");
  }) as typeof fetch;
  assert.deepEqual((await run(boom)).result, {
    ok: false,
    kind: "unreachable",
  });
  assert.deepEqual((await run(boom, { online: false })).result, {
    ok: false,
    kind: "offline",
  });
  const none = await streamHelp({
    messages: ask,
    base: null,
    onDelta: () => undefined,
  });
  assert.deepEqual(none, { ok: false, kind: "not-configured" });
});

test("stream: Stop aborts, even while waiting for the first byte", async () => {
  const controller = new AbortController();
  const pending = run(
    ((_: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("a", "AbortError")),
        );
      })) as unknown as typeof fetch,
    { signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 10);
  assert.deepEqual((await pending).result, { ok: false, kind: "aborted" });
});

test("stream: Stop mid-stream keeps the partial text", async () => {
  const controller = new AbortController();
  const got: string[] = [];
  const result = await streamHelp({
    messages: ask,
    base: BASE,
    fetchImpl: (async () =>
      sseResponse([delta("one "), delta("two ")], {
        hang: true,
      })) as typeof fetch,
    onDelta: (t) => {
      got.push(t);
      if (got.length === 2) controller.abort();
    },
    signal: controller.signal,
    isOnline: () => true,
  });
  assert.deepEqual(result, { ok: false, kind: "aborted" });
  assert.equal(got.join(""), "one two ");
});

test("stream: timeouts (no response, then silence mid-stream)", async () => {
  const limits = { connectMs: 30, idleMs: 30, totalMs: 1000 };
  const silent = (async (_: string, init: RequestInit) =>
    new Promise((_r, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("x")));
    })) as unknown as typeof fetch;
  assert.deepEqual((await run(silent, { limits })).result, {
    ok: false,
    kind: "timeout",
  });
  const stalls = (async () =>
    sseResponse([delta("a")], { hang: true })) as typeof fetch;
  const r = await run(stalls, { limits });
  assert.deepEqual(r.result, { ok: false, kind: "timeout" });
  assert.equal(r.text, "a");
});

test("failure messages: friendly, empty only for aborted", () => {
  const kinds: HelpFailureKind[] = [
    "offline",
    "unreachable",
    "not-configured",
    "rate-limited",
    "unavailable",
    "invalid",
    "timeout",
    "interrupted",
    "server",
  ];
  for (const k of kinds) {
    const m = helpFailureMessage(k);
    assert.ok(m.length > 15 && !/error|exception|undefined/i.test(m), k);
  }
  assert.equal(helpFailureMessage("aborted"), "");
});

test("status: cached for the session, failures are retried", async () => {
  resetHelpStatusCache();
  const original = globalThis.fetch;
  const previous = process.env.NEXT_PUBLIC_MURMUR_API;
  process.env.NEXT_PUBLIC_MURMUR_API = BASE;
  let calls = 0;
  let answer: () => Response = () => {
    throw new TypeError("down");
  };
  globalThis.fetch = (async () => {
    calls++;
    return answer();
  }) as typeof fetch;
  try {
    const down = await checkHelpStatus();
    assert.deepEqual(down, { state: "unavailable", reason: "unreachable" });
    answer = () => Response.json({ available: true });
    assert.deepEqual(await checkHelpStatus(), { state: "available" });
    assert.deepEqual(await checkHelpStatus(), { state: "available" });
    assert.equal(calls, 2);
    answer = () => Response.json({ available: false });
    assert.deepEqual(await checkHelpStatus({ force: true }), {
      state: "unavailable",
      reason: "unavailable",
    });
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = original;
    if (previous === undefined) delete process.env.NEXT_PUBLIC_MURMUR_API;
    else process.env.NEXT_PUBLIC_MURMUR_API = previous;
    resetHelpStatusCache();
  }
});

test("page kind comes from the pathname and never carries the path", () => {
  assert.equal(pageKind("/"), "home");
  assert.equal(pageKind("/pricing/"), "pricing");
  assert.equal(pageKind("/download"), "download");
  assert.equal(pageKind("/privacy"), "privacy");
  assert.equal(pageKind("/terms"), "terms");
  assert.equal(pageKind("/r/ABCD-1234"), "referral");
  assert.equal(pageKind("/join/SECRETTOKEN123"), "join");
  assert.equal(pageKind("/nope"), "other");
  assert.equal(pageKind(null), "home");
  assert.equal(pageKind("/pricingx"), "other");
});

test("request messages: newest kept, starts with the visitor, merged, clipped", () => {
  const long: HelpTurn[] = [];
  for (let i = 0; i < 25; i++) {
    long.push({ role: "user", content: `q${i}` });
    long.push({ role: "assistant", content: `a${i}` });
  }
  long.push({ role: "user", content: "last" });
  const out = buildRequestMessages(long);
  assert.ok(out.length <= HELP_LIMITS.maxMessages);
  assert.equal(out[0].role, "user");
  assert.deepEqual(out[out.length - 1], { role: "user", content: "last" });
  assert.equal(out.length, 15);

  assert.deepEqual(
    buildRequestMessages([
      { role: "user", content: "one" },
      { role: "assistant", content: "  " },
      { role: "user", content: "two" },
    ]),
    [{ role: "user", content: "one\n\ntwo" }],
  );
  const clipped = buildRequestMessages([
    { role: "user", content: "x".repeat(2000) },
    { role: "assistant", content: "y".repeat(7000) },
    { role: "user", content: "z" },
  ]);
  assert.equal(clipped[0].content.length, HELP_LIMITS.maxUserChars);
  assert.equal(clipped[1].content.length, HELP_LIMITS.maxAssistantChars);
});

test("session storage: round trip, junk ignored", () => {
  const chat = [
    { role: "user" as const, content: "hi" },
    { role: "assistant" as const, content: "part", failed: "timeout" as const },
  ];
  assert.deepEqual(parseStoredChat(serializeChat(chat)), chat);
  assert.deepEqual(parseStoredChat("nope"), []);
  assert.deepEqual(parseStoredChat('[{"role":"system","content":"x"}]'), []);
  assert.deepEqual(
    parseStoredChat('[{"role":"user","content":"x","failed":"timeout"}]'),
    [],
  );
  assert.deepEqual(
    parseStoredChat('[{"role":"assistant","content":"x","failed":"bogus"}]'),
    [],
  );
  assert.deepEqual(parseStoredChat(null), []);
});

// ---- Markdown ----

function flat(nodes: Inline[]): string {
  return nodes
    .map((n) => {
      switch (n.t) {
        case "text":
        case "code":
          return n.v;
        case "br":
          return "\n";
        default:
          return flat(n.c);
      }
    })
    .join("");
}

function links(blocks: Block[]): { href: string; external: boolean }[] {
  const found: { href: string; external: boolean }[] = [];
  const walk = (nodes: Inline[]) => {
    for (const n of nodes) {
      if (n.t === "link") found.push({ href: n.href, external: n.external });
      if ("c" in n) walk(n.c);
    }
  };
  for (const b of blocks) {
    if (b.t === "p") walk(b.c);
    if (b.t === "ul" || b.t === "ol") b.items.forEach(walk);
  }
  return found;
}

test("markdown: inline formatting", () => {
  const n = parseInline("a **bold** and *it* and `co*de*` and _under_");
  assert.deepEqual(
    n.map((x) => x.t),
    ["text", "strong", "text", "em", "text", "code", "text", "em"],
  );
  assert.equal(flat(n), "a bold and it and co*de* and under");
  assert.equal(flat(parseInline("2 * 3 * 4")), "2 * 3 * 4");
  assert.equal(flat(parseInline("snake_case_name")), "snake_case_name");
  assert.equal(flat(parseInline("**unfinished")), "**unfinished");
  assert.equal(flat(parseInline("\\*not em\\*")), "*not em*");
});

test("markdown: blocks", () => {
  const blocks = parseMarkdown(
    "Intro line\nsecond line\n\n1. First\n2. Second\n   more\n\n- a\n- b\n\n## Title\n\n```\ncode **x**\n```",
  );
  assert.deepEqual(
    blocks.map((b) => b.t),
    ["p", "ol", "ul", "p", "pre"],
  );
  const ol = blocks[1] as Extract<Block, { t: "ol" }>;
  assert.equal(ol.start, 1);
  assert.equal(flat(ol.items[1]), "Second\nmore");
  assert.equal((blocks[4] as Extract<Block, { t: "pre" }>).v, "code **x**");
  assert.equal(
    (parseMarkdown("3. three\n4. four")[0] as { start: number }).start,
    3,
  );
  // an unfinished fence (mid-stream) is a code block, not lost text
  assert.deepEqual(parseMarkdown("```\nhalf"), [{ t: "pre", v: "half" }]);
});

test("markdown: links are only http(s) or site-relative", () => {
  assert.deepEqual(safeHref("/privacy"), { href: "/privacy", external: false });
  assert.deepEqual(safeHref("/#faq"), { href: "/#faq", external: false });
  assert.equal(safeHref("//evil.example")?.href, undefined);
  assert.equal(safeHref("javascript:alert(1)"), null);
  assert.equal(safeHref("JaVaScRiPt:alert(1)"), null);
  assert.equal(safeHref(" javascript:alert(1)"), null);
  assert.equal(safeHref("java\nscript:alert(1)"), null);
  assert.equal(safeHref("data:text/html,<script>1</script>"), null);
  assert.equal(safeHref("vbscript:x"), null);
  assert.equal(safeHref("mailto:a@b.c"), null);
  assert.equal(safeHref("/\\evil.example"), null);
  assert.equal(safeHref("relative/path"), null);
  assert.deepEqual(safeHref("https://example.com/a?b=1"), {
    href: "https://example.com/a?b=1",
    external: true,
  });
});

test("markdown: hostile input stays text or loses its link", () => {
  const bad = parseMarkdown(
    "[click](javascript:alert(1)) <script>alert(1)</script> <img src=x onerror=alert(1)> [x](data:text/html;base64,AAAA) [y](//evil.example)",
  );
  assert.deepEqual(links(bad), []);
  const text = flat((bad[0] as Extract<Block, { t: "p" }>).c);
  assert.ok(text.includes("<script>alert(1)</script>"));
  assert.ok(text.includes("click"));
  assert.ok(!text.includes("javascript:"));

  const good = parseMarkdown(
    "See [FAQ](/#faq), [site](https://example.com/x) and https://example.org/path.",
  );
  assert.deepEqual(links(good), [
    { href: "/#faq", external: false },
    { href: "https://example.com/x", external: true },
    { href: "https://example.org/path", external: true },
  ]);
});
