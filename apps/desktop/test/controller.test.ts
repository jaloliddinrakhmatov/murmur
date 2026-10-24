import { test } from "node:test";
import assert from "node:assert/strict";
import { DictationController } from "../src/main/core/controller.ts";
import { ProviderError } from "@murmur/speech";
import { AudioCaptureError } from "../src/main/core/types.ts";
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
  pcm,
  realHold,
} from "./helpers.ts";

function setup(
  overrides: Partial<
    Parameters<typeof DictationController.prototype.configure>[0]
  > = {},
) {
  const clock = new FakeClock();
  const audio = new FakeAudio();
  const capsule = new FakeCapsule();
  const inserter = new FakeInserter();
  const history = new FakeHistory();
  const vault = new FakeVault();
  const provider = new FakeProvider();
  const cancelHotkey = new FakeCancelHotkey();
  const logs: { event: string; data?: unknown }[] = [];
  const sounds: { kind: string; micOpen: boolean }[] = [];
  let ids = 0;
  const controller = new DictationController(
    {
      hold: realHold(),
      audio,
      target: fakeTarget(),
      inserter,
      capsule,
      cancelHotkey,
      history,
      vault,
      provider: () => provider,
      clock,
      newId: () => `d${++ids}`,
      log: (event, data) => logs.push({ event, data }),
      // Each sound records whether the microphone was still recording when it played.
      sound: (kind) =>
        sounds.push({ kind, micOpen: audio.started > audio.stopped }),
    },
    { resultDisplayMs: 500, ...overrides },
  );
  return {
    clock,
    audio,
    capsule,
    inserter,
    history,
    vault,
    provider,
    cancelHotkey,
    controller,
    logs,
    sounds,
  };
}

async function holdAndRelease(s: ReturnType<typeof setup>, holdMs = 1500) {
  s.controller.hotkey("down");
  await flush();
  await s.clock.advance(holdMs);
  s.controller.hotkey("up");
  await flush();
  await flush();
}

test("hold → release inserts cleaned text, records history, deletes audio after success", async () => {
  const s = setup();
  s.provider.text = "um hello comma world";
  await holdAndRelease(s);
  assert.equal(s.audio.started, 1);
  assert.equal(s.audio.stopped, 1);
  assert.deepEqual(
    s.inserter.calls.map((c) => c.text),
    ["Hello, world."],
  );
  assert.equal(s.inserter.calls[0].target.appName, "TextEdit");
  const row = s.history.only;
  assert.equal(row.status, "inserted");
  assert.equal(row.rawText, "um hello comma world");
  assert.equal(row.finalText, "Hello, world.");
  assert.equal(row.wordCount, 2);
  assert.equal(row.hasAudio, false, "audio removed after successful insertion");
  assert.equal(s.vault.files.size, 0);
  assert.deepEqual(
    s.capsule.states.map((x) => x.state),
    ["listening", "processing", "inserting", "inserted"],
  );
  await s.clock.advance(600);
  assert.equal(s.capsule.last.state, "resting");
  assert.equal(s.cancelHotkey.armed, 1);
  assert.equal(s.cancelHotkey.disarmed, 1);
  assert.equal(s.controller.currentPhase, "idle");
});

test("a tap shorter than 300 ms records nothing and inserts nothing", async () => {
  const s = setup();
  s.controller.hotkey("down");
  await flush();
  await s.clock.advance(100);
  s.controller.hotkey("up");
  await s.clock.advance(1000); // past the double-tap window → cancel:tap
  assert.equal(s.audio.cancelled, 1);
  assert.equal(s.audio.stopped, 0);
  assert.equal(s.inserter.calls.length, 0);
  assert.equal(s.history.rows.size, 0);
  assert.equal(s.capsule.last.state, "resting");
  assert.ok(
    !s.capsule.states.some((x) => x.state === "cancelled"),
    "an accidental tap is not announced as cancelled",
  );
});

test("Esc while recording cancels: mic released, nothing inserted, nothing stored", async () => {
  const s = setup();
  s.controller.hotkey("down");
  await flush();
  await s.clock.advance(800);
  s.cancelHotkey.trigger!();
  await flush();
  assert.equal(s.audio.cancelled, 1);
  assert.equal(s.inserter.calls.length, 0);
  assert.equal(s.history.rows.size, 0);
  assert.equal(s.cancelHotkey.disarmed, 1);
  assert.equal(
    s.capsule.last.state,
    "cancelled",
    "a deliberate cancel is confirmed",
  );
  await s.clock.advance(600);
  assert.equal(s.capsule.last.state, "resting");
  s.controller.hotkey("up");
  await flush();
  assert.equal(s.audio.stopped, 0, "the release after a cancel is swallowed");
});

test("double-tap enters hands-free; capsule click stops it", async () => {
  const s = setup();
  s.controller.hotkey("down");
  await flush();
  await s.clock.advance(80);
  s.controller.hotkey("up");
  await s.clock.advance(150);
  s.controller.hotkey("down");
  await s.clock.advance(60);
  s.controller.hotkey("up");
  await flush();
  assert.equal(s.capsule.last.state, "handsFree");
  await s.clock.advance(3000);
  s.controller.toggleFromCapsule();
  await flush();
  await flush();
  assert.equal(s.history.only.status, "inserted");
});

test("silence produces no insertion and no history row", async () => {
  const s = setup();
  s.audio.next = pcm(1500, 0.001);
  await holdAndRelease(s);
  assert.equal(s.inserter.calls.length, 0);
  assert.equal(s.history.rows.size, 0);
  assert.match(s.capsule.last.message ?? "", /mic muted/);
});

test("microphone permission denied → recoverable error, machine reset", async () => {
  const s = setup();
  s.audio.startError = new AudioCaptureError(
    "permission-denied",
    "NotAllowedError",
  );
  s.controller.hotkey("down");
  await flush();
  await flush();
  assert.equal(s.capsule.last.state, "error");
  assert.match(s.capsule.last.message ?? "", /Microphone access/);
  assert.equal(s.controller.currentPhase, "idle");
  s.controller.hotkey("up");
  await flush();
  s.audio.startError = null;
  await holdAndRelease(s);
  assert.equal(
    s.history.only.status,
    "inserted",
    "next dictation works after the error",
  );
});

test("provider failure keeps audio and transcript recoverable; retry copies the result", async () => {
  const s = setup();
  s.provider.fail = new Error("HTTP 503");
  await holdAndRelease(s);
  const row = s.history.only;
  assert.equal(row.status, "failed");
  assert.match(row.error ?? "", /503/);
  assert.equal(row.hasAudio, true);
  assert.equal(s.vault.files.size, 1);
  assert.equal(s.capsule.last.state, "error");
  assert.match(s.capsule.last.message ?? "", /retry from History/i);

  s.provider.fail = null;
  s.provider.text = "second try";
  const copied: string[] = [];
  const after = await s.controller.retry(
    row.id,
    async (t) => void copied.push(t),
  );
  assert.deepEqual(copied, ["Second try."]);
  assert.equal(after?.status, "copied");
  assert.equal(
    s.inserter.calls.length,
    0,
    "retry never pastes into whatever is focused now",
  );
});

test("a recording too long for the service: clear message, no pointless retry with the same service, retry works after switching", async () => {
  const s = setup();
  s.provider.fail = new ProviderError(
    "fake",
    "too long",
    undefined,
    "too-long",
  );
  await holdAndRelease(s);
  const row = s.history.only;
  assert.equal(row.status, "failed");
  assert.match(row.error ?? "", /^too-long:/);
  assert.equal(s.capsule.last.message, "Too long — switch service");
  const calls = s.provider.calls;
  const same = await s.controller.retry(row.id, async () => {});
  assert.equal(s.provider.calls, calls, "same service is not asked again");
  assert.equal(same?.status, "failed");
  assert.equal(same?.hasAudio, true, "still recoverable");
  // After switching service the retry runs.
  s.history.update(row.id, { provider: "other" });
  s.provider.fail = null;
  const copied: string[] = [];
  const after = await s.controller.retry(
    row.id,
    async (t) => void copied.push(t),
  );
  assert.equal(after?.status, "copied");
  assert.equal(copied.length, 1);
});

test("a retry that fails again stays failed, keeps the audio and copies nothing", async () => {
  const s = setup();
  s.provider.fail = new Error("HTTP 503");
  await holdAndRelease(s);
  const row = s.history.only;
  s.provider.fail = new Error("HTTP 429 quota");
  const copied: string[] = [];
  const after = await s.controller.retry(
    row.id,
    async (t) => void copied.push(t),
  );
  assert.equal(after?.status, "failed");
  assert.match(after?.error ?? "", /429/);
  assert.equal(after?.hasAudio, true, "still recoverable");
  assert.equal(s.vault.files.size, 1);
  assert.deepEqual(copied, [], "nothing claimed or copied");
});

test("retry with expired audio says so and stops offering a retry", async () => {
  const s = setup();
  s.provider.fail = new Error("HTTP 503");
  await holdAndRelease(s);
  const row = s.history.only;
  s.vault.files.clear(); // retention purge or manual deletion
  const after = await s.controller.retry(row.id, async () => {});
  assert.equal(after?.status, "failed");
  assert.equal(after?.error, "audio no longer available");
  assert.equal(after?.hasAudio, false);
});

test("provider timeout is reported as a timeout and is retryable", async () => {
  const s = setup({ transcribeTimeoutMs: 30 });
  s.provider.delayMs = 500;
  s.controller.hotkey("down");
  await flush();
  await s.clock.advance(1500);
  s.controller.hotkey("up");
  await new Promise((r) => setTimeout(r, 120));
  const row = s.history.only;
  assert.equal(row.status, "failed");
  assert.equal(row.error, "timeout");
  assert.equal(row.hasAudio, true);
});

test("unconfigured provider → clear setup error, nothing pretended", async () => {
  const s = setup();
  s.provider.ready = "OpenAI API key is not set";
  await holdAndRelease(s);
  assert.equal(s.provider.calls, 0);
  assert.match(
    s.capsule.last.message ?? "",
    /Set up transcription in Settings/,
  );
  assert.equal(s.history.only.status, "failed");
  assert.match(s.history.only.error ?? "", /not-configured/);
});

test("secure target: rejected, not copied, kept in History", async () => {
  const s = setup();
  s.inserter.outcome = { strategy: "rejected", reason: "secure-field" };
  await holdAndRelease(s);
  assert.equal(s.history.only.status, "rejected");
  assert.match(s.capsule.last.message ?? "", /Password field/);
});

test("target changed during processing: copied with a hint instead of pasting", async () => {
  const s = setup();
  s.inserter.outcome = { strategy: "clipboard-only", reason: "target-changed" };
  await holdAndRelease(s);
  assert.equal(s.history.only.status, "copied");
  assert.match(s.capsule.last.message ?? "", /App changed/);
});

test("hotkey during processing is rejected with a message, not queued", async () => {
  const s = setup();
  s.provider.delayMs = 50;
  s.controller.hotkey("down");
  await flush();
  await s.clock.advance(1500);
  s.controller.hotkey("up");
  await flush();
  assert.equal(s.controller.currentPhase, "processing");
  s.controller.hotkey("down");
  assert.match(s.capsule.last.message ?? "", /Still writing/);
  s.controller.hotkey("up");
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(s.audio.started, 1);
  assert.equal(s.history.rows.size, 1);
});

test("20-minute cap: warning at 19 min, automatic stop and insertion at 20", async () => {
  const s = setup();
  s.controller.hotkey("down");
  await flush();
  await s.clock.advance(19 * 60 * 1000 + 300);
  assert.equal(s.capsule.last.state, "warning");
  await s.clock.advance(60 * 1000);
  await flush();
  assert.equal(s.history.only.status, "inserted");
  s.controller.hotkey("up");
  await flush();
  assert.equal(
    s.audio.started,
    1,
    "the late release does not start a new recording",
  );
});

test("history disabled: nothing is stored but insertion still happens", async () => {
  const s = setup({ historyEnabled: false });
  await holdAndRelease(s);
  assert.equal(s.inserter.calls.length, 1);
  assert.equal(s.history.rows.size, 0);
  assert.equal(s.vault.files.size, 0);
});

test("a microphone that fails to start after the dictation was cancelled shows no error", async () => {
  const s = setup();
  s.audio.holdStart = true;
  s.controller.hotkey("down");
  await flush();
  await s.clock.advance(400);
  s.cancelHotkey.trigger!(); // Esc while the microphone is still opening
  await flush();
  s.controller.hotkey("up");
  await flush();
  assert.equal(s.capsule.last.state, "cancelled");
  // The abandoned start fails late (e.g. the 4 s start timeout).
  s.audio.pending!.reject(new AudioCaptureError("unavailable", "late"));
  await flush();
  assert.ok(
    !s.capsule.states.some((x) => x.state === "error"),
    "no error for a dictation the user already cancelled",
  );
  assert.equal(s.controller.currentPhase, "idle");

  // The next dictation is unaffected.
  s.audio.holdStart = false;
  s.audio.pending = null;
  await holdAndRelease(s);
  assert.equal(s.history.only.status, "inserted");
});

test("a late start failure from an earlier attempt doesn't stop the current recording", async () => {
  const s = setup();
  s.audio.holdStart = true;
  s.controller.hotkey("down");
  await flush();
  await s.clock.advance(400);
  s.cancelHotkey.trigger!();
  await flush();
  s.controller.hotkey("up");
  await flush();
  const stale = s.audio.pending!;
  // A new dictation starts and its microphone opens normally.
  s.audio.holdStart = false;
  await s.clock.advance(1000);
  s.controller.hotkey("down");
  await flush();
  assert.equal(s.controller.currentPhase, "recording");
  stale.reject(new AudioCaptureError("unavailable", "late"));
  await flush();
  assert.equal(s.controller.currentPhase, "recording", "still recording");
  assert.equal(s.capsule.last.state, "listening");
});

test("a provider error that echoes an API key is stored redacted", async () => {
  const s = setup();
  s.provider.fail = new Error(
    'HTTP 401 {"error":"Incorrect API key provided: sk-proj-********************abcd"}',
  );
  await holdAndRelease(s);
  const row = s.history.only;
  assert.equal(row.status, "failed");
  assert.match(row.error ?? "", /HTTP 401/);
  assert.doesNotMatch(row.error ?? "", /sk-proj/);
});

test("without Accessibility (no Post Event permission) dictation still works: copied, saved, and the capsule says so", async () => {
  const s = setup();
  s.inserter.outcome = {
    strategy: "clipboard-only",
    reason: "no-post-event-permission",
  };
  s.provider.text = "um send the invoice";
  await holdAndRelease(s);
  assert.equal(s.audio.started, 1, "recording was not blocked");
  assert.deepEqual(
    s.inserter.calls.map((c) => c.text),
    ["Send the invoice."],
    "transcribed and handed to the clipboard fallback",
  );
  const row = s.history.only;
  assert.equal(row.status, "copied");
  assert.equal(row.strategy, "clipboard-only");
  assert.equal(row.finalText, "Send the invoice.");
  const shown = s.capsule.states.find((x) => x.state === "copied");
  assert.equal(shown?.message, "Paste is off — copied, press ⌘V");
  assert.ok(
    !s.capsule.states.some((x) => x.state === "inserted"),
    "never claims it was inserted",
  );
  assert.equal(s.controller.currentPhase, "idle");
});

test("feedback sounds play only with the microphone closed: stop, then done or error; none for taps or cancel", async () => {
  const ok = setup();
  ok.provider.text = "hello there";
  await holdAndRelease(ok);
  assert.deepEqual(ok.sounds, [
    { kind: "stop", micOpen: false },
    { kind: "done", micOpen: false },
  ]);

  const failed = setup();
  failed.provider.fail = new Error("HTTP 503");
  await holdAndRelease(failed);
  assert.deepEqual(
    failed.sounds.map((x) => x.kind),
    ["stop", "error"],
  );

  const tap = setup();
  await holdAndRelease(tap, 100);
  assert.deepEqual(tap.sounds, [], "an accidental tap is silent");

  const cancelled = setup();
  cancelled.controller.hotkey("down");
  await flush();
  await cancelled.clock.advance(800);
  cancelled.controller.cancel();
  await flush();
  assert.deepEqual(cancelled.sounds, [], "cancel is silent");
});

test("microphone lost mid-recording: stops, keeps and processes what was recorded, and says why", async () => {
  const s = setup();
  s.provider.text = "first half of a thought";
  s.controller.hotkey("down");
  await flush();
  await s.clock.advance(1500);
  s.controller.microphoneLost();
  await flush();
  await flush();
  assert.equal(s.audio.stopped, 1, "stopped, not cancelled");
  assert.equal(s.audio.cancelled, 0);
  assert.deepEqual(
    s.inserter.calls.map((c) => c.text),
    ["First half of a thought."],
  );
  assert.deepEqual(s.capsule.last, {
    state: "inserted",
    message: "Mic disconnected — inserted what it heard",
  });
  assert.ok(s.logs.some((l) => l.event === "audio.device.lost"));
  // The key is still held; its release must not start or stop anything.
  s.controller.hotkey("up");
  await flush();
  assert.equal(s.audio.started, 1);
  assert.equal(s.controller.currentPhase, "idle");
  // The next dictation is normal again, without the note.
  await s.clock.advance(5000);
  await holdAndRelease(s);
  assert.equal(s.audio.started, 2);
  assert.equal(s.capsule.last.state, "inserted");
  assert.equal(s.capsule.last.message, undefined);
});

test("microphone lost right away: nothing usable was recorded, and the Capsule says so; ignored when idle", async () => {
  const s = setup();
  s.controller.microphoneLost();
  assert.equal(s.audio.stopped, 0, "idle: nothing to stop");
  s.audio.next = pcm(100);
  s.controller.hotkey("down");
  await flush();
  await s.clock.advance(400);
  s.controller.microphoneLost();
  await flush();
  await flush();
  assert.equal(s.inserter.calls.length, 0);
  assert.deepEqual(s.capsule.last, {
    state: "error",
    message: "Mic disconnected — nothing was recorded",
  });
});

test("Scratchpad: text typed straight into the note window counts as inserted, once (Stage 9B)", async () => {
  const s = setup();
  s.inserter.outcome = { strategy: "direct" };
  s.provider.text = "note to self";
  await holdAndRelease(s);
  assert.equal(s.inserter.calls.length, 1);
  const row = s.history.only;
  assert.equal(row.status, "inserted");
  assert.equal(row.strategy, "direct");
  assert.equal(row.finalText, "Note to self.");
  assert.equal(row.hasAudio, false);
  assert.equal(s.capsule.last.state, "inserted");
});

test("secure target at release: no transcription, no AI cleanup, no insertion, nothing kept", async () => {
  const s = setup();
  const controller = new DictationController(
    {
      hold: realHold(),
      audio: s.audio,
      target: fakeTarget({ secure: true }),
      inserter: s.inserter,
      capsule: s.capsule,
      cancelHotkey: s.cancelHotkey,
      history: s.history,
      vault: s.vault,
      provider: () => s.provider,
      clock: s.clock,
      newId: () => "sec1",
      log: () => {},
      contextTerms: () => {
        contextReads++;
        return ["x"];
      },
    },
    { resultDisplayMs: 500 },
  );
  let contextReads = 0;
  controller.hotkey("down");
  await flush();
  await s.clock.advance(1500);
  controller.hotkey("up");
  await flush();
  await flush();
  assert.equal(s.provider.calls, 0, "audio never sent to transcription");
  assert.equal(s.inserter.calls.length, 0);
  assert.equal(contextReads, 0, "context awareness is not read");
  assert.equal(s.capsule.last.message, "Password field — not inserted");
  assert.equal(s.history.only.status, "rejected");
  assert.equal(s.history.only.rawText, null);
  assert.equal(s.history.only.hasAudio, false);
  assert.equal(s.vault.files.size, 0);
});

test("context awareness off: starting a dictation takes no extra target snapshot", async () => {
  const s = setup();
  let snapshots = 0;
  const base = fakeTarget();
  const controller = new DictationController(
    {
      hold: realHold(),
      audio: s.audio,
      target: {
        snapshot: () => (snapshots++, base.snapshot()),
      },
      inserter: s.inserter,
      capsule: s.capsule,
      cancelHotkey: s.cancelHotkey,
      history: s.history,
      vault: s.vault,
      provider: () => s.provider,
      clock: s.clock,
      newId: () => "ctx1",
      log: () => {},
      contextTerms: () => ["x"],
      contextEnabled: () => false,
    },
    { resultDisplayMs: 500 },
  );
  controller.hotkey("down");
  await flush();
  assert.equal(snapshots, 0, "nothing read at the start");
  await s.clock.advance(1500);
  controller.hotkey("up");
  await flush();
  await flush();
  assert.equal(snapshots, 1, "only the release snapshot");
});

test("vibe coding wired but both options off: starting a dictation takes no extra target snapshot", async () => {
  for (const [vibeOn, expected] of [
    [false, 1],
    [true, 2],
  ] as const) {
    const s = setup();
    let snapshots = 0;
    let begun = 0;
    const base = fakeTarget();
    const controller = new DictationController(
      {
        hold: realHold(),
        audio: s.audio,
        target: { snapshot: () => (snapshots++, base.snapshot()) },
        inserter: s.inserter,
        capsule: s.capsule,
        cancelHotkey: s.cancelHotkey,
        history: s.history,
        vault: s.vault,
        provider: () => s.provider,
        clock: s.clock,
        newId: () => "vibe1",
        log: () => {},
        contextEnabled: () => false,
        vibeEnabled: () => vibeOn,
        vibe: {
          begin: () => (begun++, []),
          apply: async (text) => text,
          end: () => {},
        },
      },
      { resultDisplayMs: 500 },
    );
    controller.hotkey("down");
    await flush();
    assert.equal(begun, vibeOn ? 1 : 0);
    await s.clock.advance(1500);
    controller.hotkey("up");
    await flush();
    await flush();
    assert.equal(snapshots, expected, `vibe ${vibeOn ? "on" : "off"}`);
  }
});

test("retry refuses a row that has no audio, even if a stray vault file exists", async () => {
  const s = setup();
  await holdAndRelease(s);
  const row = s.history.only;
  assert.equal(row.hasAudio, false);
  s.vault.files.set(row.id, new Uint8Array([1, 2, 3]));
  const calls = s.provider.calls;
  const copied: string[] = [];
  const after = await s.controller.retry(
    row.id,
    async (t) => void copied.push(t),
  );
  assert.equal(s.provider.calls, calls, "nothing was transcribed");
  assert.deepEqual(copied, []);
  assert.equal(after?.status, "inserted");
});

test("the dictation language reaches cleanup: an Uzbek 'er' is not removed as a filler", async () => {
  const s = setup({ language: "uz" });
  s.provider.text = "bu er kishi";
  await holdAndRelease(s);
  assert.equal(s.inserter.calls[0]?.text, "Bu er kishi.");
});
