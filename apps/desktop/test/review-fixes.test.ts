// Regression tests for the code-review findings: microphone start/stop bookkeeping, password
// fields never kept, native secure-field reasons, interrupted dictations, recording-key creation
// and shortcut changes that are rejected as a whole.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CleanupProvider } from "@murmur/refine";
import {
  RendererAudioCapture,
  type AudioRendererLink,
  type AudioRendererMessage,
} from "../src/main/audio/capture.ts";
import {
  DictationController,
  type ProcessingConfig,
} from "../src/main/core/controller.ts";
import {
  AudioCaptureError,
  type CapturedAudio,
  type DictationRecord,
  type InsertOutcome,
} from "../src/main/core/types.ts";
import { ClipboardFirstInserter } from "../src/main/native/inserter.ts";
import type { NativeAddon } from "../src/main/native/addon.ts";
import { HistoryDb } from "../src/main/history/db.ts";
import {
  INTERRUPTED_ERROR,
  recoverInterruptedDictations,
} from "../src/main/history/recover.ts";
import { retryInfo } from "../src/renderer/hub/model/history.ts";
import {
  SecureStorage,
  VaultKey,
  testKeychain,
  type KeychainPort,
} from "../src/main/settings/secure-storage.ts";
import { SettingsStore, plainCodec } from "../src/main/settings/store.ts";
import { HubService, type HubServiceDeps } from "../src/main/hub/service.ts";
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

// ---- Audio capture --------------------------------------------------------------------------

function fakeLink() {
  const listeners = new Set<(m: AudioRendererMessage) => void>();
  const sent: string[] = [];
  const emit = (m: AudioRendererMessage) => [...listeners].forEach((l) => l(m));
  const behaviour = {
    onSend: (_c: Parameters<AudioRendererLink["send"]>[0]) => {},
  };
  const link: AudioRendererLink = {
    send: (c) => {
      sent.push(c.type);
      behaviour.onSend(c);
    },
    onMessage: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  return { link, listeners, sent, emit, behaviour };
}

const chunk = (n = 1600, v = 1000) => ({
  type: "chunk" as const,
  samples: new Int16Array(n).fill(v).buffer,
});
const later = () => new Promise<void>((r) => setImmediate(r));

test("stop() records each chunk once, including the one that arrives after the stop command", async () => {
  const f = fakeLink();
  f.behaviour.onSend = (c) => {
    if (c.type === "start")
      f.emit({ type: "started", id: c.id, deviceId: null, fallback: false });
    if (c.type === "stop")
      setTimeout(() => {
        f.emit(chunk());
        f.emit({ type: "stopped" });
      }, 5);
  };
  const cap = new RendererAudioCapture(f.link);
  await cap.start();
  f.emit(chunk());
  const audio = await cap.stop();
  assert.equal(audio.samples.length, 3200);
  assert.equal(f.listeners.size, 0);
});

test("a start that times out cancels the renderer and stops listening", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const f = fakeLink(); // the renderer never answers
    const cap = new RendererAudioCapture(f.link);
    const start = cap.start();
    const settled = assert.rejects(
      start,
      (e: Error & { code: string }) => e.code === "unavailable",
    );
    mock.timers.tick(4000);
    await settled;
    assert.deepEqual(f.sent, ["start", "cancel"]);
    assert.equal(f.listeners.size, 0, "no leaked listener");
  } finally {
    mock.timers.reset();
  }
});

test("a failed start leaves no listener, so later meeting chunks are not recorded", async () => {
  const f = fakeLink();
  f.behaviour.onSend = (c) => {
    if (c.type === "start")
      f.emit({ type: "error", name: "NotAllowedError", message: "denied" });
  };
  const cap = new RendererAudioCapture(f.link);
  await assert.rejects(cap.start());
  assert.equal(f.listeners.size, 0);
});

test("chunks before the start is acknowledged, or after cancel, are not recorded", async () => {
  const f = fakeLink();
  let id = 0;
  f.behaviour.onSend = (c) => {
    if (c.type === "start") id = c.id;
  };
  const cap = new RendererAudioCapture(f.link);
  const start = cap.start();
  f.emit(chunk()); // not ours yet
  f.emit({ type: "started", id, deviceId: null, fallback: false });
  await start;
  f.emit(chunk(800));
  f.behaviour.onSend = (c) => {
    if (c.type === "stop") f.emit({ type: "stopped" });
  };
  const audio = await cap.stop();
  assert.equal(audio.samples.length, 800);
});

test("overlapping timeouts: an old start's timeout and a slow stop never disturb a newer recording", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const f = fakeLink();
    const ids: number[] = [];
    f.behaviour.onSend = (c) => {
      if (c.type === "start") ids.push(c.id); // A never answers
    };
    const cap = new RendererAudioCapture(f.link);
    // A: released while the microphone is still opening; the renderer is stuck, so stop() waits.
    const startA = cap.start();
    const aRejected = startA.catch((e) => e);
    const stopA = cap.stop();
    mock.timers.tick(2000); // stop's own timeout
    const audioA = await stopA;
    assert.equal(audioA.samples.length, 0);
    // B starts and is acknowledged while A's start timer is still pending.
    const startB = cap.start();
    f.emit({ type: "started", id: ids[1], deviceId: null, fallback: false });
    await startB;
    f.emit(chunk(1600));
    const sentBefore = f.sent.length;
    mock.timers.tick(2500); // A's 4 s timeout fires now
    const errA = await aRejected;
    assert.ok(errA instanceof AudioCaptureError);
    await later();
    assert.equal(f.sent.length, sentBefore, "no cancel sent for the old start");
    assert.equal(f.listeners.size, 1, "B still listening");
    f.emit(chunk(1600));
    f.behaviour.onSend = (c) => {
      if (c.type === "stop") f.emit({ type: "stopped" });
    };
    const audioB = await cap.stop();
    assert.equal(audioB.samples.length, 3200, "B kept everything it heard");
    assert.equal(f.listeners.size, 0);
  } finally {
    mock.timers.reset();
  }
});

// ---- Controller -----------------------------------------------------------------------------

class GatedAudio extends FakeAudio {
  gate: (() => void) | null = null;
  async stop(): Promise<CapturedAudio> {
    await new Promise<void>((r) => (this.gate = r));
    return super.stop();
  }
}

function setup(
  options: {
    secure?: boolean;
    audio?: FakeAudio;
    processing?: ProcessingConfig;
  } = {},
) {
  const clock = new FakeClock();
  const audio = options.audio ?? new FakeAudio();
  const capsule = new FakeCapsule();
  const inserter = new FakeInserter();
  const history = new FakeHistory();
  const vault = new FakeVault();
  const provider = new FakeProvider();
  let n = 0;
  const controller = new DictationController(
    {
      hold: realHold(),
      audio,
      target: fakeTarget({ secure: options.secure ?? false }),
      inserter,
      capsule,
      cancelHotkey: new FakeCancelHotkey(),
      history,
      vault,
      provider: () => provider,
      ...(options.processing ? { processing: () => options.processing! } : {}),
      clock,
      newId: () => `d${++n}`,
      log: () => {},
    },
    { resultDisplayMs: 100 },
  );
  return {
    clock,
    audio,
    capsule,
    inserter,
    history,
    vault,
    provider,
    controller,
  };
}

async function press(s: ReturnType<typeof setup>, holdMs = 1500) {
  s.controller.hotkey("down");
  await flush();
  await s.clock.advance(holdMs);
  s.controller.hotkey("up");
  await flush();
  await flush();
}

test("a failed microphone start cancels the audio so it can't stay open unseen", async () => {
  const s = setup();
  s.audio.startError = new AudioCaptureError("unavailable", "timed out");
  s.controller.hotkey("down");
  await flush();
  await flush();
  assert.equal(s.capsule.last.state, "error");
  assert.equal(s.audio.cancelled, 1);
  assert.equal(s.controller.currentPhase, "idle");
});

test("a start failure arriving after release doesn't reset the dictation being processed", async () => {
  const audio = new GatedAudio();
  audio.holdStart = true;
  const s = setup({ audio });
  s.controller.hotkey("down");
  await flush();
  await s.clock.advance(1500);
  s.controller.hotkey("up");
  await flush();
  assert.equal(s.controller.currentPhase, "processing");
  audio.pending!.reject(new AudioCaptureError("unavailable", "timed out"));
  await flush();
  await flush();
  assert.equal(s.controller.currentPhase, "processing", "still processing");
  assert.equal(audio.cancelled, 0);
  assert.notEqual(s.capsule.last.state, "error");
  audio.gate!();
  await flush();
  await flush();
  await flush();
  assert.equal(s.controller.currentPhase, "idle");
  assert.equal(s.history.only.status, "inserted");
});

test("History setting is read once per dictation, at release", async () => {
  const audio = new GatedAudio();
  const s = setup({ audio });
  s.controller.hotkey("down");
  await flush();
  await s.clock.advance(1500);
  s.controller.hotkey("up");
  await flush();
  s.controller.configure({ historyEnabled: false });
  audio.gate!();
  for (let i = 0; i < 6; i++) await flush();
  assert.equal(
    s.history.only.status,
    "inserted",
    "row isn't left half-written",
  );
  assert.equal(s.history.only.hasAudio, false);
});

test("password field: nothing is sent to transcription, no recording kept, no retry offered", async () => {
  const s = setup({ secure: true });
  s.provider.fail = new Error("boom");
  await press(s);
  assert.equal(s.provider.calls, 0, "the audio never leaves the Mac");
  assert.equal(s.vault.files.size, 0, "audio never saved");
  const row = s.history.only;
  assert.equal(row.status, "rejected");
  assert.equal(row.hasAudio, false);
  assert.ok(!/retry/i.test(s.capsule.last.message ?? ""));
  let copied = 0;
  await s.controller.retry(row.id, async () => void copied++);
  assert.equal(copied, 0, "retry never writes the clipboard");
  assert.equal(s.history.only.rawText, null);
  assert.equal(s.history.only.finalText, null);
});

test("password field found only at insertion + AI cleanup rejection: the rejected text is not written", async () => {
  const ai: CleanupProvider = {
    id: "fake-ai",
    kind: "cloud",
    readiness: async () => null,
    cleanup: async () => ({ text: "Paris" }),
  };
  const s = setup({
    processing: {
      mode: "ai",
      dictionary: [],
      snippets: [],
      vocabulary: [],
      ai: { provider: ai, timeoutMs: 1000 },
    },
  });
  s.provider.text = "what is the capital of France";
  s.inserter.outcome = { strategy: "rejected", reason: "secure-field" };
  await press(s);
  const row = s.history.only;
  assert.equal(row.aiRejectedText, null);
  assert.equal(row.rawText, null);
  assert.equal(row.finalText, null);
  assert.equal(row.hasAudio, false);
  assert.equal(s.vault.files.size, 0);
});

test("password field: the text is never sent to AI cleanup", async () => {
  let aiCalls = 0;
  const ai: CleanupProvider = {
    id: "fake-ai",
    kind: "cloud",
    readiness: async () => null,
    cleanup: async () => {
      aiCalls++;
      return { text: "x" };
    },
  };
  const s = setup({
    secure: true,
    processing: {
      mode: "ai",
      dictionary: [],
      snippets: [],
      vocabulary: [],
      ai: { provider: ai, timeoutMs: 1000 },
    },
  });
  await press(s);
  assert.equal(aiCalls, 0);
  assert.equal(s.provider.calls, 0);
  assert.equal(s.capsule.last.message, "Password field — not inserted");
});

// ---- Native secure-field reasons ------------------------------------------------------------

function nativeRefusing(reason: string): NativeAddon {
  return {
    frontmostApp: () => ({ bundleId: "com.apple.TextEdit" }),
    permissionStatus: () => ({ secureEventInput: false }),
    insertText: () => ({ strategy: "rejected", reason, steps: [] }),
  } as unknown as NativeAddon;
}

test("the native layer's password-field reasons both become 'secure-field'", async () => {
  const target = fakeTarget().snapshot();
  for (const reason of ["secure-event-input", "secure-text-field"]) {
    const inserter = new ClipboardFirstInserter(
      nativeRefusing(reason),
      () => {},
      () => {},
    );
    const r: InsertOutcome = await inserter.insert("secret", {
      ...target,
      pid: 1,
    });
    assert.deepEqual(r, { strategy: "rejected", reason: "secure-field" });
  }
  const other = new ClipboardFirstInserter(
    nativeRefusing("no-focus"),
    () => {},
    () => {},
  );
  assert.equal((await other.insert("x", target)).reason, "no-focus");
});

// ---- Interrupted dictations -----------------------------------------------------------------

test("dictations left 'transcribing' by a quit become failed and keep their recording", () => {
  const db = new HistoryDb(":memory:");
  const row = (
    id: string,
    status: DictationRecord["status"],
  ): DictationRecord => ({
    id,
    startedAt: Date.now(),
    durationMs: 1500,
    status,
    strategy: null,
    rawText: null,
    finalText: null,
    wordCount: 0,
    appName: null,
    appBundleId: null,
    error: null,
    provider: "fake",
    hasAudio: true,
  });
  db.insert(row("a", "transcribing"));
  db.insert(row("b", "inserted"));
  assert.equal(recoverInterruptedDictations(db), 1);
  const a = db.get("a")!;
  assert.equal(a.status, "failed");
  assert.equal(a.error, INTERRUPTED_ERROR);
  assert.equal(a.hasAudio, true);
  assert.equal(db.get("b")!.status, "inserted");
  assert.equal(
    retryInfo(a as unknown as Parameters<typeof retryInfo>[0]).canRetry,
    true,
  );
  assert.equal(recoverInterruptedDictations(db), 0);
  db.close();
});

// ---- Recording key --------------------------------------------------------------------------

const noLog = () => {};
function refusingEncrypt(): KeychainPort & { refuse: boolean } {
  const real = testKeychain();
  const port = {
    refuse: true,
    isAvailable: () => Promise.resolve(true),
    encrypt: (t: string) =>
      port.refuse ? Promise.reject(new Error("denied")) : real.encrypt(t),
    decrypt: (b: Buffer) => real.decrypt(b),
  };
  return port;
}

test("creating the recording key when the Keychain refuses to encrypt: locked, nothing written, tried again later", async () => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-review-key-"));
  const port = refusingEncrypt();
  const key = new VaultKey(dir, new SecureStorage(port, noLog), noLog);
  await key.load(); // must not reject
  assert.equal(key.state, "locked");
  assert.equal(key.key, null);
  assert.deepEqual(readdirSync(dir), []);
  port.refuse = false;
  await key.load();
  assert.equal(key.state, "ready");
  assert.deepEqual(readdirSync(dir), ["vault.key"]);
});

test("replacing an unreadable recording key: the old file stays until the new key is encrypted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-review-key-"));
  writeFileSync(join(dir, "vault.key"), "old-unreadable-blob");
  const port = refusingEncrypt();
  const key = new VaultKey(dir, new SecureStorage(port, noLog), noLog);
  await key.load();
  assert.equal(key.state, "unreadable");
  await assert.rejects(key.replaceUnreadable("s"), /denied/);
  assert.deepEqual(readdirSync(dir), ["vault.key"], "no backup, no gap");
  assert.equal(key.state, "unreadable");
  port.refuse = false;
  await key.replaceUnreadable("s");
  assert.equal(key.state, "ready");
  assert.ok(existsSync(join(dir, "vault.key.unreadable-s")));
});

// ---- Shortcut change with a rejected patch --------------------------------------------------

function hotkeysStub(start: string) {
  const state = {
    combo: start,
    registered: true,
    error: null as string | null,
  };
  const replaced: string[] = [];
  const restored: string[] = [];
  return {
    replaced,
    restored,
    // The rollback is lenient (a kept legacy shortcut such as ctrl+d must come back).
    restore(combo: string) {
      restored.push(combo);
      state.combo = combo;
      return state;
    },
    suspend() {},
    get current() {
      return state;
    },
    replace(combo: string) {
      replaced.push(combo);
      state.combo = combo;
      return { ok: true as const, status: state };
    },
  };
}

test("a shortcut isn't re-registered when the rest of the patch is invalid", () => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-review-settings-"));
  const hotkeys = hotkeysStub("Ctrl+Opt+F12");
  const hub = new HubService({
    settings: new SettingsStore(dir, plainCodec),
    hotkeys,
  } as unknown as HubServiceDeps);
  assert.throws(() =>
    hub.updateSettings({ shortcut: "ctrl+opt+k", appearance: "sepia" }),
  );
  assert.deepEqual(hotkeys.replaced, []);
  assert.equal(hotkeys.current.combo, "Ctrl+Opt+F12");
});

test("if saving fails after the shortcut was registered, the previous shortcut is restored", () => {
  const hotkeys = hotkeysStub("Ctrl+Opt+F12");
  const hub = new HubService({
    settings: {
      update() {
        throw new Error("disk full");
      },
    },
    hotkeys,
  } as unknown as HubServiceDeps);
  assert.throws(
    () => hub.updateSettings({ shortcut: "ctrl+opt+k" }),
    /disk full/,
  );
  assert.deepEqual(hotkeys.replaced, ["ctrl+opt+k"]);
  assert.deepEqual(hotkeys.restored, ["Ctrl+Opt+F12"]);
  assert.equal(hotkeys.current.combo, "Ctrl+Opt+F12");
});
