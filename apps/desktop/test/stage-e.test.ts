// Stage E (local features, part 1): Command Mode through the dictation controller, Press Enter
// (only after text was really pasted), and muting other audio while dictating (only what Murmur
// muted, restored on every way out of recording and after a crash).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DictationController } from "../src/main/core/controller.ts";
import { OutputMuter } from "../src/main/system/mute.ts";
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
import { AudioCaptureError } from "../src/main/core/types.ts";

function setup(
  opts: { meeting?: boolean; pid?: number | null; secure?: boolean } = {},
) {
  const clock = new FakeClock();
  const audio = new FakeAudio();
  const capsule = new FakeCapsule();
  const inserter = new FakeInserter();
  const history = new FakeHistory();
  const vault = new FakeVault();
  const provider = new FakeProvider();
  const commands: { instruction: string; selection: unknown }[] = [];
  const enters: number[] = [];
  const enterPids: (number | null)[] = [];
  let enterReason = "no-post-event-permission";
  const mutes: boolean[] = [];
  let enterOk = true;
  const controller = new DictationController(
    {
      hold: realHold(),
      audio,
      target: fakeTarget({
        pid: opts.pid === undefined ? 1 : opts.pid,
        secure: opts.secure ?? false,
      }),
      inserter,
      capsule,
      cancelHotkey: new FakeCancelHotkey(),
      history,
      vault,
      provider: () => provider,
      clock,
      newId: () => "d1",
      log: () => {},
      command: {
        capture: () => ({ text: "selected" }),
        run: (instruction, selection) =>
          commands.push({ instruction, selection }),
      },
      pressEnter: (pid) => {
        enters.push(clock.now());
        enterPids.push(pid);
        return enterOk ? { ok: true } : { ok: false, reason: enterReason };
      },
      muteOutput: (m) => mutes.push(m),
      busy: () => (opts.meeting ? "Meeting recording on" : null),
    },
    { resultDisplayMs: 500 },
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
    commands,
    enters,
    enterPids,
    mutes,
    failEnter: (reason = "no-post-event-permission") => {
      enterOk = false;
      enterReason = reason;
    },
  };
}

async function hold(
  s: ReturnType<typeof setup>,
  down: () => void,
  up: () => void,
) {
  down();
  await flush();
  await s.clock.advance(1500);
  up();
  await s.clock.advance(50);
  for (let i = 0; i < 5; i++) await flush();
}

test("command mode: the spoken instruction goes to the panel with the selection; nothing inserted or kept", async () => {
  const s = setup();
  s.provider.text = "make it shorter";
  await hold(
    s,
    () => s.controller.commandHotkey("down"),
    () => s.controller.commandHotkey("up"),
  );
  assert.deepEqual(s.commands, [
    { instruction: "make it shorter", selection: { text: "selected" } },
  ]);
  assert.equal(s.inserter.calls.length, 0, "nothing inserted");
  assert.equal(s.history.rows.size, 0, "instructions aren't History");
  assert.equal(s.vault.files.size, 0);
  assert.ok(
    s.capsule.states.some(
      (x) => x.state === "listening" && x.message === "Say what to do",
    ),
  );
  assert.equal(s.controller.currentPhase, "idle");
  // The next push-to-talk press is an ordinary dictation again.
  s.provider.text = "hello there";
  await hold(
    s,
    () => s.controller.hotkey("down"),
    () => s.controller.hotkey("up"),
  );
  assert.equal(s.inserter.calls.length, 1);
  assert.equal(s.commands.length, 1);
});

test("command mode: a password field focused leaves no History row and says the command was not run", async () => {
  const s = setup({ secure: true });
  s.provider.text = "make it shorter";
  await hold(
    s,
    () => s.controller.commandHotkey("down"),
    () => s.controller.commandHotkey("up"),
  );
  assert.equal(s.history.rows.size, 0, "no row, not even a rejected one");
  assert.equal(s.provider.calls, 0, "audio never transcribed");
  assert.deepEqual(s.commands, []);
  assert.equal(s.vault.files.size, 0);
  const last = s.capsule.states.at(-1);
  assert.equal(last?.message, "Password field — command not run");
  assert.ok(last!.message!.length <= 41);
  // An ordinary dictation into the same field still records its refusal.
  await hold(
    s,
    () => s.controller.hotkey("down"),
    () => s.controller.hotkey("up"),
  );
  assert.equal(s.history.rows.size, 1);
});

test("command mode: ignored while a dictation records; refused while a meeting records", async () => {
  const s = setup();
  s.controller.hotkey("down");
  await flush();
  s.controller.commandHotkey("down");
  s.controller.commandHotkey("up");
  await s.clock.advance(1500);
  s.controller.hotkey("up");
  for (let i = 0; i < 5; i++) await flush();
  assert.equal(s.commands.length, 0);
  assert.equal(s.inserter.calls.length, 1, "the dictation finished normally");
  const meeting = setup({ meeting: true });
  meeting.controller.commandHotkey("down");
  await flush();
  assert.equal(meeting.audio.started, 0);
  assert.equal(meeting.capsule.last.message, "Meeting recording on");
});

test("press enter: when idle presses Return at once; without permission it says so", () => {
  const s = setup();
  s.controller.pressEnter();
  assert.equal(s.enters.length, 1);
  s.failEnter();
  s.controller.pressEnter();
  assert.equal(s.capsule.last.state, "warning");
  assert.equal(s.capsule.last.message, "Enter needs Accessibility access");
});

test("press enter: names the app that must still be in front; a refusal says the app changed", () => {
  const s = setup({ pid: 4242 });
  s.controller.pressEnter();
  assert.deepEqual(s.enterPids, [4242]);
  s.failEnter("target-changed");
  s.controller.pressEnter();
  assert.equal(s.capsule.last.state, "warning");
  assert.equal(s.capsule.last.message, "Enter not sent: app changed");
  const unknown = setup({ pid: null });
  unknown.controller.pressEnter();
  assert.deepEqual(
    unknown.enterPids,
    [null],
    "an unknown app is passed on to be refused",
  );
});

test("press enter during a hands-free dictation: stops it, then presses Return only once the text was pasted", async () => {
  const s = setup();
  s.controller.toggleFromCapsule(); // hands-free
  await flush();
  await s.clock.advance(1500);
  s.controller.pressEnter();
  for (let i = 0; i < 6; i++) await flush();
  assert.equal(s.inserter.calls.length, 1);
  assert.equal(s.enters.length, 1, "Return after the paste");
  assert.deepEqual(
    s.enterPids,
    [1],
    "Return is tied to the app that got the text",
  );
  // When the text could only be copied, Return is not pressed.
  s.inserter.outcome = { strategy: "clipboard-only", reason: "target-changed" };
  s.controller.toggleFromCapsule();
  await flush();
  await s.clock.advance(1500);
  s.controller.pressEnter();
  for (let i = 0; i < 6; i++) await flush();
  assert.equal(s.inserter.calls.length, 2);
  assert.equal(
    s.enters.length,
    1,
    "no Return into an app that didn't get the text",
  );
});

test("mute: on while the microphone records, off on stop, cancel and a microphone that fails", async () => {
  const s = setup();
  await hold(
    s,
    () => s.controller.hotkey("down"),
    () => s.controller.hotkey("up"),
  );
  assert.deepEqual(s.mutes, [true, false]);
  s.controller.hotkey("down");
  await flush();
  await s.clock.advance(1500);
  s.controller.cancel();
  await flush();
  assert.deepEqual(s.mutes, [true, false, true, false]);
  s.audio.startError = new AudioCaptureError("permission-denied", "denied");
  s.controller.hotkey("down");
  for (let i = 0; i < 3; i++) await flush();
  assert.deepEqual(s.mutes, [true, false, true, false, true, false]);
});

function muter(
  opts: { enabled?: boolean; muted?: boolean | null; marker?: boolean } = {},
) {
  let muted = opts.muted === undefined ? false : opts.muted;
  let marker = opts.marker ?? false;
  const calls: boolean[] = [];
  const m = new OutputMuter({
    enabled: () => opts.enabled ?? true,
    isMuted: () => muted,
    setMuted: (v) => {
      calls.push(v);
      if (muted !== null) muted = v;
      return muted !== null;
    },
    marker: {
      exists: () => marker,
      write: () => (marker = true),
      remove: () => (marker = false),
    },
    log: () => {},
  });
  return { m, calls, state: () => ({ muted, marker }) };
}

test("output muter: mutes only when enabled and not already muted; unmutes only what it muted", () => {
  const on = muter();
  on.m.set(true);
  assert.deepEqual(on.state(), { muted: true, marker: true });
  on.m.set(false);
  assert.deepEqual(on.state(), { muted: false, marker: false });
  const off = muter({ enabled: false });
  off.m.set(true);
  assert.deepEqual(off.calls, []);
  const already = muter({ muted: true });
  already.m.set(true);
  already.m.set(false);
  assert.deepEqual(already.calls, [], "your own mute is left alone");
  const noControl = muter({ muted: null });
  noControl.m.set(true);
  assert.deepEqual(noControl.calls, []);
});

test("output muter: after a crash while muted, the next launch turns the sound back on", () => {
  const crashed = muter({ muted: true, marker: true });
  crashed.m.restoreAfterQuit();
  assert.deepEqual(crashed.state(), { muted: false, marker: false });
  const clean = muter({ muted: true });
  clean.m.restoreAfterQuit();
  assert.deepEqual(clean.calls, [], "no marker: your mute is yours");
});

test("output muter: the crash marker exists before the Mac is muted, and is removed if muting fails", () => {
  const order: string[] = [];
  let muted = false;
  let marker = false;
  const m = new OutputMuter({
    enabled: () => true,
    isMuted: () => muted,
    setMuted: (v) => {
      order.push(`mute:${v}:marker=${marker}`);
      muted = v;
      return true;
    },
    marker: {
      exists: () => marker,
      write: () => ((marker = true), void order.push("marker:write")),
      remove: () => ((marker = false), void order.push("marker:remove")),
    },
    log: () => {},
  });
  m.set(true);
  assert.deepEqual(order, ["marker:write", "mute:true:marker=true"]);

  const refused = muter();
  const bad = new OutputMuter({
    enabled: () => true,
    isMuted: () => false,
    setMuted: () => false,
    marker: {
      exists: () => false,
      write: () => {},
      remove: () => {
        refused.calls.push(false);
      },
    },
    log: () => {},
  });
  bad.set(true);
  assert.deepEqual(
    refused.calls,
    [false],
    "marker removed when mute was refused",
  );

  let mk = false;
  const t = new OutputMuter({
    enabled: () => true,
    isMuted: () => false,
    setMuted: () => {
      throw new Error("no device");
    },
    marker: {
      exists: () => mk,
      write: () => (mk = true),
      remove: () => (mk = false),
    },
    log: () => {},
  });
  t.set(true);
  assert.equal(mk, false, "no marker left behind when muting threw");
});

test("output muter: a normal quit gives back the sound Murmur muted, and only that", () => {
  const dictating = muter();
  dictating.m.set(true);
  dictating.m.set(false); // what dispose() does
  assert.deepEqual(dictating.state(), { muted: false, marker: false });
  const yours = muter({ muted: true });
  yours.m.set(false);
  assert.deepEqual(yours.calls, [], "your own mute is untouched at quit");
});

test("press enter: an event failure is not blamed on an app change", () => {
  const s = setup();
  s.failEnter("event-failed");
  s.controller.pressEnter();
  assert.equal(s.capsule.last.message, "Enter not sent");
  s.failEnter("secure-input");
  s.controller.pressEnter();
  assert.equal(s.capsule.last.message, "Enter not sent: password field");
});
