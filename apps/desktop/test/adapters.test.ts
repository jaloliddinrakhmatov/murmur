import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RendererAudioCapture,
  toCaptureError,
  type AudioRendererLink,
  type AudioRendererMessage,
} from "../src/main/audio/capture.ts";
import {
  ClipboardFirstInserter,
  decideInsertion,
  restoreDelayFor,
} from "../src/main/native/inserter.ts";
import { CarbonHotkeys } from "../src/main/native/hotkeys.ts";
import { serial } from "../src/renderer/audio/queue.ts";
import { loadDotEnv, readEnvOverrides } from "../src/main/env.ts";
import { loadNative, type NativeAddon } from "../src/main/native/addon.ts";
import type { TargetSnapshot } from "../src/main/core/types.ts";

const target = (over: Partial<TargetSnapshot> = {}): TargetSnapshot => ({
  appBundleId: "com.apple.TextEdit",
  appName: "TextEdit",
  pid: 1,
  secure: false,
  takenAt: 0,
  ...over,
});

test("insertion policy: secure fields rejected, app switch copies only, otherwise paste", () => {
  assert.deepEqual(
    decideInsertion(target({ secure: true }), "com.apple.TextEdit", false),
    { action: "reject", reason: "secure-field" },
  );
  assert.deepEqual(decideInsertion(target(), "com.apple.TextEdit", true), {
    action: "reject",
    reason: "secure-field",
  });
  assert.deepEqual(decideInsertion(target(), "com.apple.Safari", false), {
    action: "copy-only",
    reason: "target-changed",
  });
  assert.deepEqual(decideInsertion(target(), "com.apple.TextEdit", false), {
    action: "paste",
  });
  assert.deepEqual(
    decideInsertion(target({ pid: 4242 }), "com.apple.TextEdit", false, 4242),
    { action: "copy-only", reason: "self-target" },
  );
  assert.deepEqual(
    decideInsertion(target({ pid: 4242 }), "com.apple.TextEdit", false, 1),
    { action: "paste" },
  );
  assert.deepEqual(
    decideInsertion(target({ appBundleId: null }), "com.apple.Safari", false),
    { action: "paste" },
    "unknown original app cannot be compared",
  );
});

test("clipboard restore delay is longer for slow pasters", () => {
  assert.equal(restoreDelayFor("com.apple.TextEdit"), 500);
  assert.equal(restoreDelayFor("com.microsoft.Word"), 3000);
  assert.equal(restoreDelayFor("com.microsoft.rdc.macos"), 5000);
  assert.equal(restoreDelayFor(null), 500);
});

test("clipboard-first inserter with the real addon: secure input rejects and copies nothing", async () => {
  const native = loadNative();
  const before = native.clipboardChangeCount();
  const inserter = new ClipboardFirstInserter(
    native,
    () => {},
    () => {},
  );
  assert.equal(native.permissionStatus().secureEventInput, false);
  const r = await inserter.insert("hunter2", target({ secure: true }));
  assert.deepEqual(r, { strategy: "rejected", reason: "secure-field" });
  assert.equal(native.clipboardChangeCount(), before, "clipboard untouched");
});

test("clipboard-first inserter: target changed → copy only; paste path degrades to clipboard-only without Post Event permission", async () => {
  const native = loadNative();
  const original = native.clipboardReadText();
  const scheduled: number[] = [];
  const inserter = new ClipboardFirstInserter(
    native,
    () => {},
    (_fn, ms) => scheduled.push(ms),
  );
  const front = native.frontmostApp()?.bundleId ?? null;
  const moved = await inserter.insert(
    "moved text",
    target({ appBundleId: "com.example.other" }),
  );
  assert.deepEqual(moved, {
    strategy: "clipboard-only",
    reason: "target-changed",
  });
  assert.equal(native.clipboardReadText(), "moved text");

  // A real ⌘V lands in whatever app is frontmost (the developer's editor), so the live paste
  // branch only runs on explicit request; otherwise the chain runs with posting disabled.
  if (
    process.env.MURMUR_ALLOW_LIVE_PASTE === "1" &&
    native.permissionStatus().postEvents
  ) {
    const same = await inserter.insert(
      "same app text",
      target({ appBundleId: front }),
    );
    assert.equal(same.strategy, "clipboard-paste");
    assert.deepEqual(scheduled, [500]);
  } else {
    const r = native.insertText("same app text", {
      allowAccessibility: false,
      allowPaste: false,
    });
    assert.deepEqual(
      [r.strategy, r.reason],
      ["clipboard-only", "paste-disabled"],
    );
    assert.deepEqual(scheduled, []);
  }
  assert.equal(native.clipboardReadText(), "same app text");
  if (original != null) native.clipboardWriteText(original, false);
});

/** Combos not held exclusively by another app on this machine (M0: Carbon reports -9878 only for those). */
function freeCombos(
  native: ReturnType<typeof loadNative>,
  count: number,
): string[] {
  const free: string[] = [];
  for (const key of [
    "f5",
    "f6",
    "f7",
    "f8",
    "f9",
    "f13",
    "f14",
    "f15",
    "f16",
    "f17",
    "f18",
    "f19",
  ]) {
    const r = native.registerHotkey(
      900,
      `ctrl+opt+${key}`,
      { exclusive: true },
      () => {},
    );
    native.unregisterHotkey(900);
    if (r.ok) free.push(`ctrl+opt+${key}`);
    if (free.length === count) break;
  }
  if (free.length < count)
    throw new Error(`only ${free.length} free test shortcuts on this machine`);
  return free;
}

test("Carbon hotkeys: a failed change keeps the previous shortcut registered", () => {
  const native = loadNative();
  const [current, taken] = freeCombos(native, 2);
  const presses: string[] = [];
  const hk = new CarbonHotkeys(native, (k) => presses.push(k));
  assert.equal(hk.bind(current).registered, true);

  // Another app holds `taken` exclusively (simulated with a second id).
  native.registerHotkey(99, taken, { exclusive: true }, () => {});
  try {
    const r = hk.replace(taken);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /already used by another app/);
    assert.equal(hk.current.registered, true, "still has a working shortcut");
    assert.equal(hk.current.combo.toLowerCase(), current.toLowerCase());
    // The restored registration is real: registering `current` elsewhere now conflicts.
    const probe = native.registerHotkey(
      98,
      current,
      { exclusive: true },
      () => {},
    );
    assert.equal(probe.ok, false, "previous combo is registered again");
  } finally {
    native.unregisterHotkey(99);
    native.unregisterHotkey(98);
  }

  const invalid = hk.replace("rightoption");
  assert.equal(invalid.ok, false, "modifier-only is refused");
  assert.equal(hk.current.combo.toLowerCase(), current.toLowerCase());

  const ok = hk.replace(taken);
  assert.equal(ok.ok, true);
  assert.equal(hk.current.combo.toLowerCase(), taken.toLowerCase());
  hk.dispose();
});

test("Carbon hotkeys: bind, rebind, conflict message, Esc armed only while recording", () => {
  const native = loadNative();
  const [a, b, c] = freeCombos(native, 3);
  const presses: string[] = [];
  const hk = new CarbonHotkeys(native, (k) => presses.push(k));
  assert.deepEqual(hk.check("ctrl+opt+space").errors, []);
  assert.ok(
    hk
      .check("rightoption")
      .errors.some((e) => e.includes("needs-input-monitoring")),
    "modifier-only not offered in M1",
  );
  assert.ok(hk.check("cmd+space").errors.includes("system-reserved"));
  assert.match(hk.check("ctrl+banana").errors[0], /unknown key/);

  const bound = hk.bind(a);
  assert.equal(bound.registered, true, JSON.stringify(bound));
  assert.equal(bound.combo.toLowerCase(), a.toLowerCase());
  const rebound = hk.bind(b);
  assert.equal(rebound.registered, true);
  const invalid = hk.bind("k");
  assert.equal(invalid.registered, false);
  assert.match(invalid.error ?? "", /needs-modifier/);

  // Conflict with an exclusive registration held elsewhere (simulated with a second id).
  native.registerHotkey(99, c, { exclusive: true }, () => {});
  const conflict = hk.bind(c);
  assert.equal(conflict.registered, false);
  assert.match(conflict.error ?? "", /already used by another app/);
  native.unregisterHotkey(99);

  let cancelled = 0;
  const disarm = hk.arm(() => cancelled++);
  assert.equal(
    native.registerHotkey(
      98,
      "escape",
      { exclusive: true, action: "cancel" },
      () => {},
    ).status,
    -9878,
    "Esc is held while armed",
  );
  disarm();
  assert.equal(
    native.registerHotkey(
      98,
      "escape",
      { exclusive: true, action: "cancel" },
      () => {},
    ).ok,
    true,
    "Esc released after disarm",
  );
  native.unregisterHotkey(98);
  hk.dispose();
  assert.equal(cancelled, 0);
});

test("audio capture adapter assembles chunks, measures peak RMS, maps DOM errors", async () => {
  const listeners = new Set<(m: AudioRendererMessage) => void>();
  const sent: string[] = [];
  const link: AudioRendererLink = {
    send: (c) => {
      sent.push(c.type);
      if (c.type === "start")
        emit({ type: "started", id: c.id, deviceId: null, fallback: false });
      if (c.type === "stop") emit({ type: "stopped" });
    },
    onMessage: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  const emit = (m: AudioRendererMessage) => listeners.forEach((l) => l(m));
  const levels: number[] = [];
  const capture = new RendererAudioCapture(link, (rms) => levels.push(rms));
  await capture.start();
  const loud = new Int16Array(1600).fill(16384);
  emit({ type: "chunk", samples: loud.buffer });
  emit({ type: "chunk", samples: new Int16Array(1600).buffer });
  const audio = await capture.stop();
  assert.equal(audio.samples.length, 3200);
  assert.equal(audio.durationMs, 200);
  assert.ok(Math.abs(audio.peakRms - 0.5) < 0.01);
  assert.equal(levels.length, 2);
  assert.deepEqual(sent, ["start", "stop"]);

  const failing: AudioRendererLink = {
    send: (c) =>
      c.type === "start" &&
      emit({ type: "error", name: "NotAllowedError", message: "denied" }),
    onMessage: link.onMessage,
  };
  await assert.rejects(
    new RendererAudioCapture(failing).start(),
    (e: Error & { code: string }) => e.code === "permission-denied",
  );
  assert.equal(toCaptureError("NotFoundError", "").code, "no-device");
  assert.equal(toCaptureError("NotReadableError", "").code, "device-busy");
});

test(".env loading does not override existing environment and strips quotes", () => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-env-"));
  const path = join(dir, ".env");
  writeFileSync(
    path,
    "# comment\nMURMUR_SPEECH_PROVIDER='groq'\nMURMUR_SPEECH_API_KEY=\"k-1\"\nMURMUR_SHORTCUT=ctrl+opt+k\n",
  );
  const env: NodeJS.ProcessEnv = { MURMUR_SHORTCUT: "from-process" };
  loadDotEnv(path, env);
  assert.deepEqual(readEnvOverrides(env), {
    provider: "groq",
    apiKey: "k-1",
    model: undefined,
    whisperUrl: undefined,
    shortcut: "from-process",
  });
});

test("audio commands run one at a time, so a cancel during start closes the microphone", async () => {
  const log: string[] = [];
  let open = 0;
  const run = serial(async (c: string) => {
    if (c === "start") {
      await new Promise((r) => setTimeout(r, 30)); // getUserMedia still pending
      open++;
      log.push("started");
    } else {
      log.push(`${c} with ${open} open`);
      open = 0;
    }
  });
  // Press, cancel at once, press again, cancel: all arrive before the first start finishes.
  await Promise.all([run("start"), run("cancel"), run("start"), run("cancel")]);
  assert.deepEqual(log, [
    "started",
    "cancel with 1 open",
    "started",
    "cancel with 1 open",
  ]);
  assert.equal(open, 0, "nothing left recording");
  await assert.rejects(serial(async () => Promise.reject(new Error("x")))("a"));
});

test("a start only counts its own acknowledgement, not a cancelled earlier one", async () => {
  const listeners = new Set<(m: AudioRendererMessage) => void>();
  const emit = (m: AudioRendererMessage) => listeners.forEach((l) => l(m));
  const starts: number[] = [];
  const link: AudioRendererLink = {
    send: (c) => {
      if (c.type === "start") starts.push(c.id);
    },
    onMessage: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  const capture = new RendererAudioCapture(link);
  void capture.start().catch(() => {});
  await capture.cancel();
  let resolved = false;
  const second = capture.start().then(() => (resolved = true));
  emit({ type: "started", id: starts[0], deviceId: null, fallback: false }); // late reply to the cancelled start
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(resolved, false, "stale acknowledgement ignored");
  emit({ type: "started", id: starts[1], deviceId: null, fallback: false });
  await second;
  assert.equal(resolved, true);
});

test("cancelling while the microphone is still opening settles the start at once", async () => {
  const link: AudioRendererLink = {
    send: () => {}, // the renderer never answers in time
    onMessage: () => () => {},
  };
  const capture = new RendererAudioCapture(link);
  const t0 = Date.now();
  const start = capture.start();
  await capture.cancel();
  await assert.rejects(
    start,
    (e: Error & { code: string }) => e.code === "cancelled",
  );
  assert.ok(Date.now() - t0 < 500, "not after the 4 s start timeout");
});

test("a microphone disconnected mid-recording keeps what was captured; stop still ends it", async () => {
  const listeners = new Set<(m: AudioRendererMessage) => void>();
  const emit = (m: AudioRendererMessage) => listeners.forEach((l) => l(m));
  const link: AudioRendererLink = {
    send: (c) => {
      if (c.type === "start")
        emit({ type: "started", id: c.id, deviceId: null, fallback: false });
      if (c.type === "stop") emit({ type: "stopped" });
    },
    onMessage: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  const capture = new RendererAudioCapture(link);
  await capture.start();
  emit({ type: "chunk", samples: new Int16Array(1600).fill(8000).buffer });
  emit({
    type: "error",
    name: "NotReadableError",
    message: "microphone disconnected",
  });
  const audio = await capture.stop();
  assert.equal(audio.durationMs, 100, "audio before the disconnect is kept");
  assert.equal(listeners.size, 0, "no listener left behind");
});

test("inserter: a clipboard that could not be restored is logged with its reason, never its content", async () => {
  const events: { event: string; data?: Record<string, unknown> }[] = [];
  const scheduled: (() => void)[] = [];
  const native = {
    frontmostApp: () => ({ bundleId: "com.apple.TextEdit", pid: 1 }),
    permissionStatus: () => ({ secureEventInput: false }),
    insertText: () => ({
      strategy: "clipboard-paste",
      steps: [],
      elapsedMs: 1,
      snapshotId: 7,
      changeCountAfterWrite: 9,
    }),
    clipboardRestore: () => ({
      restored: false,
      reason: "snapshot-too-large",
    }),
  } as unknown as NativeAddon;
  const inserter = new ClipboardFirstInserter(
    native,
    (event, data) => events.push({ event, data }),
    (fn) => scheduled.push(fn),
  );
  const r = await inserter.insert("secret words", target());
  assert.equal(r.strategy, "clipboard-paste");
  scheduled[0]();
  const skipped = events.find((e) => e.event === "clipboard.restore.skipped");
  assert.deepEqual(skipped?.data, { reason: "snapshot-too-large" });
  assert.ok(!JSON.stringify(events).includes("secret words"));
});
