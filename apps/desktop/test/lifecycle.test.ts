// Stage 7: the whole dictation lifecycle through the real controller, the real text pipeline,
// real History (SQLite) and the real encrypted audio vault, with fakes only at the edges: the
// microphone, the speech provider, the inserter and the target (nothing is recorded, sent to a
// service or pasted). Journeys A–D of the Stage 7 reliability work, plus a randomised stress run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ProviderError } from "@murmur/speech";
import type { CleanupProvider } from "@murmur/refine";
import {
  DictationController,
  transcriptionFailure,
  type ProcessingConfig,
} from "../src/main/core/controller.ts";
import { AudioCaptureError } from "../src/main/core/types.ts";
import { HistoryDb } from "../src/main/history/db.ts";
import { AudioVault } from "../src/main/history/vault.ts";
import {
  FakeAudio,
  FakeCancelHotkey,
  FakeCapsule,
  FakeClock,
  FakeInserter,
  FakeProvider,
  fakeTarget,
  flush,
  pcm,
  realHold,
} from "./helpers.ts";

const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await flush();
};

function rig(processing: Partial<ProcessingConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "murmur-life-"));
  const history = new HistoryDb(join(dir, "murmur.sqlite"));
  const vault = new AudioVault(join(dir, "audio"), randomBytes(32));
  const clock = new FakeClock();
  const audio = new FakeAudio();
  const capsule = new FakeCapsule();
  const inserter = new FakeInserter();
  const provider = new FakeProvider();
  const cancelKey = new FakeCancelHotkey();
  const logs: { event: string; data?: Record<string, unknown> }[] = [];
  let ids = 0;
  const historyPort = {
    failInsert: false,
    insert: (r: Parameters<HistoryDb["insert"]>[0]) => {
      if (historyPort.failInsert) throw new Error("database is locked");
      history.insert(r);
    },
    update: (id: string, p: Parameters<HistoryDb["update"]>[1]) =>
      history.update(id, p),
    get: (id: string) => history.get(id),
  };
  const controller = new DictationController(
    {
      hold: realHold(),
      audio,
      target: fakeTarget(),
      inserter,
      capsule,
      cancelHotkey: cancelKey,
      history: historyPort,
      vault,
      provider: () => provider,
      processing: () => ({
        mode: "deterministic",
        dictionary: [],
        snippets: [],
        vocabulary: [],
        ...processing,
      }),
      clock,
      newId: () => `d${++ids}`,
      log: (event, data) => logs.push({ event, data }),
    },
    { resultDisplayMs: 500, transcribeTimeoutMs: 200 },
  );
  const press = async () => {
    controller.hotkey("down");
    await settle();
  };
  /**
   * Releases after `afterMs`. By default waits (in real time, up to 2 s) until the dictation has
   * finished: processing includes real file I/O (the encrypted vault), so a fixed number of
   * ticks isn't enough on a busy machine. `wait: false` returns mid-processing (cancel tests).
   */
  const release = async (afterMs = 1500, wait = true) => {
    await clock.advance(afterMs);
    controller.hotkey("up");
    await settle();
    for (let k = 0; wait && k < 200 && controller.currentPhase !== "idle"; k++)
      await new Promise((res) => setTimeout(res, 10));
  };
  const audioFiles = () => {
    try {
      return readdirSync(join(dir, "audio")).length;
    } catch {
      return 0;
    }
  };
  return {
    history,
    historyPort,
    vault,
    clock,
    audio,
    capsule,
    inserter,
    provider,
    cancelKey,
    logs,
    controller,
    press,
    release,
    audioFiles,
    states: () => capsule.states.map((x) => x.state),
  };
}

test("Journey A: hold, speak, release → inserted exactly once, History and totals updated, timing logged", async () => {
  const r = rig({
    dictionary: [
      {
        id: "1",
        phrase: "NestJS",
        misheardAs: "nest js",
        enabled: true,
      } as never,
    ],
    snippets: [
      {
        id: "s",
        trigger: "my email",
        replacement: "you@example.com",
        enabled: true,
      } as never,
    ],
  });
  r.provider.text = "um deploy nest js then send it to my email";
  await r.press();
  await r.release();
  assert.deepEqual(
    r.inserter.calls.map((c) => c.text),
    ["Deploy NestJS then send it to you@example.com."],
  );
  assert.deepEqual(r.states(), [
    "listening",
    "processing",
    "inserting",
    "inserted",
  ]);
  const [row] = r.history.list({});
  assert.equal(row.status, "inserted");
  assert.equal(row.rawText, "um deploy nest js then send it to my email");
  assert.equal(row.hasAudio, false, "audio removed after a successful insert");
  assert.equal(r.audioFiles(), 0);
  assert.equal(r.history.stats(Date.now()).words, row.wordCount);
  const timing = r.logs.find((l) => l.event === "dictation.timing")!.data!;
  assert.equal(timing.outcome, "inserted");
  for (const k of ["micOpenMs", "transcribeMs", "processMs", "insertMs"])
    assert.equal(typeof timing[k], "number", k);
  assert.ok(
    !JSON.stringify(r.logs).includes("deploy"),
    "no transcript text in any log",
  );
  // Stray key events after the dictation never process it again.
  r.controller.hotkey("up");
  await r.release(0);
  assert.equal(r.inserter.calls.length, 1);
  assert.equal(r.history.count(), 1);
});

test("Journey B: no paste permission → copied, said plainly, never “inserted”; History keeps it", async () => {
  const r = rig();
  r.inserter.outcome = {
    strategy: "clipboard-only",
    reason: "no-post-event-permission",
  };
  await r.press();
  await r.release();
  assert.deepEqual(r.capsule.last, {
    state: "copied",
    message: "Paste is off — copied, press ⌘V",
  });
  assert.ok(!r.states().includes("inserted"));
  const [row] = r.history.list({});
  assert.equal(row.status, "copied");
  assert.equal(row.finalText, "Hello world.");
  assert.equal(row.hasAudio, true, "kept: not delivered into an app");
});

test("Journey C: cancel while the microphone opens, while recording, during transcription and during cleanup", async () => {
  // Microphone still opening.
  const a = rig();
  a.audio.holdStart = true;
  a.controller.hotkey("down");
  await settle();
  a.controller.cancel();
  a.audio.pending?.reject(new AudioCaptureError("cancelled", "cancelled"));
  await settle();
  assert.equal(a.controller.currentPhase, "idle");
  assert.equal(a.audio.cancelled, 1);
  assert.equal(a.history.count(), 0);
  assert.equal(a.capsule.last.state, "cancelled");

  // Recording.
  const b = rig();
  await b.press();
  await b.clock.advance(800);
  b.cancelKey.trigger!();
  await settle();
  assert.equal(b.audio.cancelled, 1);
  assert.equal(b.history.count(), 0);
  assert.equal(b.inserter.calls.length, 0);

  // Transcription: the request is aborted, nothing is inserted, the recording is discarded.
  const c = rig();
  c.provider.delayMs = 10_000;
  await c.press();
  await c.release(1500, false);
  assert.equal(c.controller.currentPhase, "processing");
  assert.ok(c.cancelKey.trigger, "Esc stays armed after release");
  c.cancelKey.trigger!();
  for (
    let k = 0;
    k < 200 && (c.controller.currentPhase as string) !== "idle";
    k++
  )
    await new Promise((res) => setTimeout(res, 5));
  assert.equal(c.controller.currentPhase, "idle");
  assert.equal(c.inserter.calls.length, 0);
  assert.equal(c.capsule.last.state, "cancelled");
  const [row] = c.history.list({});
  assert.equal(row.status, "cancelled");
  assert.equal(row.hasAudio, false);
  assert.equal(c.audioFiles(), 0, "encrypted recording deleted");
  assert.equal(c.cancelKey.armed, c.cancelKey.disarmed, "Esc released");

  // AI cleanup: cancelled at the next step, before anything is inserted.
  let release!: () => void;
  const slowAi: CleanupProvider = {
    id: "slow",
    kind: "cloud",
    readiness: async () => null,
    cleanup: () =>
      new Promise((res) => {
        release = () => res({ text: "Hello world." });
      }),
  };
  const d = rig({ mode: "ai", ai: { provider: slowAi, timeoutMs: 60_000 } });
  await d.press();
  await d.release(1500, false);
  for (let k = 0; k < 200 && d.capsule.last.state !== "refining"; k++)
    await new Promise((res) => setTimeout(res, 5));
  assert.equal(d.capsule.last.state, "refining");
  d.controller.cancel();
  release();
  for (let k = 0; k < 200 && d.controller.currentPhase !== "idle"; k++)
    await new Promise((res) => setTimeout(res, 5));
  assert.equal(d.inserter.calls.length, 0);
  assert.equal(d.capsule.last.state, "cancelled");
  assert.equal(d.history.list({})[0].status, "cancelled");
});

test("Journey C: a cancel that arrives once insertion has begun is ignored — the text goes in once", async () => {
  const r = rig();
  let finish!: () => void;
  r.inserter.insert = async (text, target) => {
    r.inserter.calls.push({ text, target });
    await new Promise<void>((res) => (finish = res));
    return { strategy: "clipboard-paste" };
  };
  await r.press();
  await r.release(1500, false);
  for (let k = 0; k < 200 && r.capsule.last.state !== "inserting"; k++)
    await new Promise((res) => setTimeout(res, 5));
  assert.equal(r.capsule.last.state, "inserting");
  assert.equal(r.cancelKey.trigger, null, "Esc no longer held while pasting");
  r.controller.cancel();
  finish();
  await settle();
  assert.equal(r.inserter.calls.length, 1);
  assert.equal(r.capsule.last.state, "inserted");
  assert.equal(r.history.list({})[0].status, "inserted");
});

test("Journey D: each failure has one deterministic outcome, and the controller always ends idle", async () => {
  const outcome = async (
    setup: (r: ReturnType<typeof rig>) => void,
  ): Promise<{
    state: string;
    message?: string;
    status?: string;
    inserted: number;
  }> => {
    const r = rig();
    setup(r);
    await r.press();
    await r.release();
    // Some outcomes involve real time (the 200 ms transcription timeout).
    for (let k = 0; k < 100 && r.controller.currentPhase !== "idle"; k++)
      await new Promise((res) => setTimeout(res, 10));
    assert.equal(r.controller.currentPhase, "idle");
    return {
      ...r.capsule.last,
      status: r.history.list({})[0]?.status,
      inserted: r.inserter.calls.length,
    };
  };
  assert.deepEqual(
    await outcome((r) => {
      r.audio.startError = new AudioCaptureError("no-device", "none");
    }),
    {
      state: "error",
      message: "No microphone found",
      status: undefined,
      inserted: 0,
    },
  );
  assert.deepEqual(
    await outcome((r) => {
      r.audio.startError = new AudioCaptureError("permission-denied", "no");
    }),
    {
      state: "error",
      message: "Microphone access is off — open Settings",
      status: undefined,
      inserted: 0,
    },
  );
  assert.deepEqual(
    await outcome((r) => {
      r.provider.fail = new ProviderError("openai", "HTTP 401 bad key", 401);
    }),
    {
      state: "error",
      message: "API key rejected — check Settings",
      status: "failed",
      inserted: 0,
    },
  );
  assert.deepEqual(
    await outcome((r) => {
      r.provider.fail = new TypeError("fetch failed");
    }),
    {
      state: "error",
      message: "No connection — retry from History",
      status: "failed",
      inserted: 0,
    },
  );
  // Network timeout (real AbortSignal.timeout, 200 ms in this rig).
  assert.deepEqual(
    await outcome((r) => {
      r.provider.delayMs = 5_000;
    }).then(async (o) => o),
    {
      state: "error",
      message: "Timed out — retry from History",
      status: "failed",
      inserted: 0,
    },
  );
  assert.deepEqual(
    await outcome((r) => {
      r.provider.text = "   ";
    }),
    {
      state: "error",
      message: "Didn't catch that",
      status: "empty",
      inserted: 0,
    },
  );
  assert.deepEqual(
    await outcome((r) => {
      r.inserter.outcome = { strategy: "rejected", reason: "secure-field" };
    }),
    {
      state: "error",
      message: "Password field — not inserted",
      status: "rejected",
      inserted: 1,
    },
  );
  // History can't be written: the text is still delivered, and the Capsule says it wasn't saved.
  assert.deepEqual(
    await outcome((r) => {
      r.historyPort.failInsert = true;
    }),
    {
      state: "inserted",
      message: "Inserted · not saved to History",
      status: undefined,
      inserted: 1,
    },
  );
});

test("Journey D: AI cleanup failing falls back to rules-based cleanup; the text is still inserted", async () => {
  const broken: CleanupProvider = {
    id: "broken",
    kind: "cloud",
    readiness: async () => null,
    cleanup: async () => {
      throw new Error("HTTP 500");
    },
  };
  const r = rig({ mode: "ai", ai: { provider: broken, timeoutMs: 1000 } });
  await r.press();
  await r.release();
  await settle(10);
  assert.deepEqual(
    r.inserter.calls.map((c) => c.text),
    ["Hello world."],
  );
  const [row] = r.history.list({});
  assert.equal(row.cleanupUsed, "deterministic");
  assert.match(row.cleanupNote ?? "", /ai-fallback/);
});

test("provider failures are explained by kind; stored errors keep no secrets", () => {
  const kinds = (e: unknown) => transcriptionFailure(e).kind;
  assert.equal(kinds(new ProviderError("x", "HTTP 403", 403)), "auth");
  assert.equal(kinds(new ProviderError("x", "HTTP 429", 429)), "rate-limit");
  // Out of credits is not "busy": retrying later won't help (seen with a real OpenAI key).
  const quota = transcriptionFailure(
    new ProviderError(
      "openai",
      'HTTP 429 {"error":{"code":"insufficient_quota"}}',
      429,
    ),
  );
  assert.equal(quota.kind, "quota");
  assert.equal(quota.message, "No credits left on this API key");
  assert.equal(
    kinds(new ProviderError("x", "HTTP 400 unsupported language: xx", 400)),
    "language",
  );
  assert.equal(
    kinds(new ProviderError("x", "HTTP 400 bad audio", 400)),
    "other",
  );
  assert.equal(kinds(new ProviderError("x", "HTTP 503", 503)), "service");
  assert.equal(
    kinds(Object.assign(new Error("t"), { name: "TimeoutError" })),
    "timeout",
  );
  assert.equal(
    kinds(new Error("getaddrinfo ENOTFOUND api.example")),
    "network",
  );
  const long = transcriptionFailure(
    new ProviderError("gemini", "too long", undefined, "too-long"),
  );
  assert.equal(long.kind, "too-long");
  assert.equal(long.message, "Too long for Gemini — switch service");
  assert.ok(long.message.length <= 41);
  assert.ok(long.error.startsWith("too-long:"));
  assert.ok(!/retry from History/.test(long.message));
  const leaked = transcriptionFailure(
    new ProviderError(
      "x",
      "HTTP 401 invalid key sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX1234",
      401,
    ),
  );
  assert.ok(!leaked.error.includes("ABCDEFGHIJKLMNOPQRSTUVWX1234"));
});

test("stress: 60 randomised press / release / cancel sequences never leak a session or process twice", async () => {
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const r = rig();
  r.provider.delayMs = 5;
  let expectedDelivered = 0;
  for (let i = 0; i < 60; i++) {
    r.provider.text = `take ${i}`;
    const before = r.inserter.calls.length;
    r.controller.hotkey("down");
    await settle(1 + Math.floor(rand() * 3));
    const roll = rand();
    if (roll < 0.25) {
      // Released too early: a tap.
      await r.clock.advance(50);
      r.controller.hotkey("up");
      await r.clock.advance(1000);
    } else if (roll < 0.5) {
      await r.clock.advance(600);
      r.controller.cancel();
    } else if (roll < 0.65) {
      await r.clock.advance(700);
      r.controller.hotkey("up");
      await settle(1);
      r.controller.cancel(); // during processing
      r.controller.hotkey("up"); // a stray release
    } else {
      await r.clock.advance(700);
      r.controller.hotkey("up");
      r.controller.hotkey("up");
    }
    for (let k = 0; k < 40 && r.controller.currentPhase !== "idle"; k++) {
      await new Promise((res) => setTimeout(res, 2));
      await r.clock.advance(10);
    }
    await r.clock.advance(3000);
    assert.equal(r.controller.currentPhase, "idle", `sequence ${i}`);
    const added = r.inserter.calls.length - before;
    assert.ok(added <= 1, `sequence ${i} inserted ${added} times`);
    expectedDelivered += added;
    assert.equal(
      r.audio.started,
      r.audio.stopped + r.audio.cancelled,
      `sequence ${i}: every opened microphone was closed`,
    );
  }
  const texts = r.inserter.calls.map((c) => c.text);
  assert.equal(
    new Set(texts).size,
    texts.length,
    "no dictation inserted twice",
  );
  assert.equal(
    r.history.list({ statuses: ["inserted"] }).length,
    expectedDelivered,
  );
  assert.equal(r.cancelKey.armed, r.cancelKey.disarmed, "Esc never left armed");
});

test("multilingual and Unicode text: dictionary and snippets work in any script; nothing is mangled", async () => {
  const { processTranscript } = await import("@murmur/refine");
  const dictionary = [
    { id: "1", phrase: "Тошкент", misheardAs: "ташкент", enabled: true },
    { id: "2", phrase: "Zürich", misheardAs: "zurich", enabled: true },
    { id: "3", phrase: "O'zbekiston", misheardAs: null, enabled: true },
  ] as never;
  const snippets = [
    {
      id: "s1",
      trigger: "мой адрес",
      replacement: "ул. Навои, 12",
      enabled: true,
    },
    { id: "s2", trigger: "sig", replacement: "— Sam 🙂", enabled: true },
  ] as never;
  const run = async (raw: string, mode: "off" | "deterministic") =>
    (await processTranscript(raw, { mode, dictionary, snippets })).text;
  // None (off): only the dictionary and snippets touch the words.
  assert.equal(
    await run("привет я в ташкент сегодня мой адрес", "off"),
    "привет я в Тошкент сегодня ул. Навои, 12",
  );
  // Light (deterministic): sentence case and a full stop; English fillers removed.
  assert.equal(
    await run("um meeting in zurich at café münchen sig", "deterministic"),
    "Meeting in Zürich at café münchen — Sam 🙂.",
  );
  assert.equal(
    await run("ну это 東京 и 北京 тест", "deterministic"),
    "Ну это 東京 и 北京 тест.",
  );
  assert.equal(
    await run("o'zbekiston bo'ylab safar 🚀 👍🏽 ok", "deterministic"),
    "O'zbekiston bo'ylab safar 🚀 👍🏽 ok.",
  );
  assert.equal(await run("naïve résumé façade", "off"), "naïve résumé façade");
  assert.equal(await run("", "deterministic"), "");
});

test("retrying a failed dictation from History updates that row only; its original is kept", async () => {
  const r = rig();
  r.provider.fail = new ProviderError("openai", "HTTP 503", 503);
  await r.press();
  await r.release();
  await settle(10);
  const [failed] = r.history.list({});
  assert.equal(failed.status, "failed");
  assert.equal(failed.hasAudio, true, "the recording is kept for retry");
  r.provider.fail = null;
  r.provider.text = "um retried words";
  const copied: string[] = [];
  const retried = await r.controller.retry(failed.id, async (t) => {
    copied.push(t);
  });
  assert.deepEqual(copied, ["Retried words."]);
  assert.equal(r.history.count(), 1, "no second row");
  assert.equal(retried?.id, failed.id);
  assert.equal(retried?.rawText, "um retried words");
  assert.equal(retried?.finalText, "Retried words.");
  assert.equal(retried?.status, "copied", "a retry is copied, never pasted");
  assert.equal(r.inserter.calls.length, 0);
});

test("every Capsule message fits on the Capsule (no “…” truncation)", async () => {
  const { readFileSync } = await import("node:fs");
  const { CAPSULE_MESSAGE_MAX, fitCapsule } =
    await import("../src/main/core/controller.ts");
  // Plain messages: every user-facing literal in the files that set Capsule messages.
  const sources = [
    "src/main/core/controller.ts",
    "src/main/hub/last-transcript.ts",
    "src/main/app.ts",
  ].map((f) => readFileSync(f, "utf8"));
  const messages = sources
    .flatMap((src) => src.match(/"[A-Z][^"\n]*(?: — | · |⌘V)[^"\n]*"/g) ?? [])
    .map((m) => m.slice(1, -1));
  assert.ok(messages.length > 20, "found the messages");
  const tooLong = messages.filter((m) => [...m].length > CAPSULE_MESSAGE_MAX);
  assert.deepEqual(tooLong, []);
  // Composed messages.
  for (const m of [
    "Mic disconnected — inserted what it heard",
    "Mic disconnected — copied, press ⌘V",
    "Mic disconnected — nothing was recorded",
    fitCapsule("Copied — press ⌘V", " · not saved to History"),
    fitCapsule("Password field — not inserted", " · not saved to History"),
  ])
    assert.ok([...m].length <= CAPSULE_MESSAGE_MAX, m);
  assert.equal(
    fitCapsule("Password field — not inserted", " · not saved to History"),
    "Password field — not inserted",
    "the less important note is dropped when both don't fit",
  );
});

test("security: a dictation refused for a password field keeps no text and no recording", async () => {
  const r = rig();
  r.provider.text = "my secret passphrase";
  r.inserter.outcome = { strategy: "rejected", reason: "secure-field" };
  await r.press();
  await r.release();
  const [row] = r.history.list({});
  assert.equal(row.status, "rejected");
  assert.equal(row.rawText, null);
  assert.equal(row.finalText, null);
  assert.equal(row.hasAudio, false);
  assert.equal(r.audioFiles(), 0);
  assert.equal(r.capsule.last.message, "Password field — not inserted");
});

test("security: provider errors lose keys, tokens and Deepgram-style hex keys before they are stored", async () => {
  const { redactSecrets } = await import("../src/shared/redact.ts");
  const out = redactSecrets(
    "401: invalid Authorization: Token 0123456789abcdef0123456789abcdef01234567 / Bearer eyJhbGciOiJIUzI1NiJ9.abc.def / sk-proj-AAAAAAAAAAAAAAAA",
  );
  assert.ok(!/0123456789abcdef/.test(out));
  assert.ok(!/eyJhbGci/.test(out));
  assert.ok(!/AAAAAAAAAAAA/.test(out));
  assert.match(out, /Token \[redacted\]/);
  assert.equal(
    redactSecrets("HTTP 503 upstream timeout"),
    "HTTP 503 upstream timeout",
  );
});

test("security: the local speech server address must be on this Mac", async () => {
  const { isLoopbackUrl, parseSettingsPatch, SettingsSchema } =
    await import("../src/shared/settings.ts");
  for (const ok of [
    "http://127.0.0.1:8178",
    "http://localhost:9000/x",
    "https://[::1]:1",
  ])
    assert.equal(isLoopbackUrl(ok), true, ok);
  for (const bad of [
    "http://evil.example:8178",
    "file:///etc/passwd",
    "http://10.0.0.2",
    "nonsense",
  ])
    assert.equal(isLoopbackUrl(bad), false, bad);
  assert.throws(() =>
    parseSettingsPatch({ speech: { localServerUrl: "https://evil.example" } }),
  );
  assert.deepEqual(
    parseSettingsPatch({ speech: { localServerUrl: "http://localhost:9000" } }),
    { speech: { localServerUrl: "http://localhost:9000" } },
  );
  // A bad value already on disk falls back for that field only; nothing else is reset.
  const loaded = SettingsSchema.parse({
    shortcut: "ctrl+opt+k",
    speech: { localServerUrl: "http://evil.example" },
  });
  assert.equal(loaded.speech.localServerUrl, "http://127.0.0.1:8178");
  assert.equal(loaded.shortcut, "ctrl+opt+k");
});

test("Keychain locked: dictation says so (not 'set up'), and a retry while recordings are locked changes nothing", async () => {
  const r = rig();
  r.provider.ready =
    "Waiting for Keychain access to the saved API key — allow Murmur in the Keychain dialog, or retry in Settings → Data and Privacy.";
  await r.press();
  await r.release();
  assert.deepEqual(r.capsule.last, {
    state: "error",
    message: "Keychain locked — allow Murmur, retry",
  });
  const [row] = r.history.list({});
  assert.equal(row.status, "failed");

  // The recording key is locked: retrying fails loudly and leaves the row and file as they were.
  const { AudioVault, VaultLockedError } =
    await import("../src/main/history/vault.ts");
  const lockedVault = new AudioVault(
    join(mkdtempSync(join(tmpdir(), "murmur-locked-")), "audio"),
    () => null,
  );
  const locked = new DictationController(
    {
      hold: realHold(),
      audio: new FakeAudio(),
      target: fakeTarget(),
      inserter: new FakeInserter(),
      capsule: new FakeCapsule(),
      cancelHotkey: new FakeCancelHotkey(),
      history: r.history,
      vault: lockedVault,
      provider: () => new FakeProvider(),
      clock: new FakeClock(),
      newId: () => "x",
      log: () => {},
    },
    {},
  );
  await assert.rejects(
    locked.retry(row.id, async () => {}),
    VaultLockedError,
  );
  const after = r.history.get(row.id)!;
  assert.equal(after.status, "failed");
  assert.equal(after.hasAudio, row.hasAudio, "not marked as lost");
});

test("a second instance never starts up: only the one holding the lock (or a throwaway run) owns the app", async () => {
  const { ownsApp } = await import("../src/main/single-instance.ts");
  assert.equal(
    ownsApp(false, () => true),
    true,
  );
  assert.equal(
    ownsApp(false, () => false),
    false,
  );
  let asked = false;
  assert.equal(
    ownsApp(true, () => ((asked = true), false)),
    true,
    "smoke and capture runs use their own data and don't take the lock",
  );
  assert.equal(asked, false);
});
