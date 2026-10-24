import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const native = require("../index.cjs");
const addonPath = fileURLToPath(new URL("../index.cjs", import.meta.url));
const noop = () => {};
const perms = native.permissionStatus();

test("validates shortcuts and picks the least-privileged backend", () => {
  const ctrlOptSpace = native.validateShortcut("ctrl+opt+space", "handsFree");
  assert.equal(ctrlOptSpace.backend, "carbon");
  assert.deepEqual(ctrlOptSpace.errors, []);

  const rightOption = native.validateShortcut("rightoption", "pushToTalk");
  assert.equal(rightOption.backend, "eventTap");
  assert.ok(rightOption.warnings.includes("requires-input-monitoring"));

  assert.ok(
    native
      .validateShortcut("cmd+space", "pushToTalk")
      .errors.includes("system-reserved"),
  );
  assert.ok(
    native
      .validateShortcut("k", "pushToTalk")
      .errors.includes("needs-modifier"),
  );
  assert.throws(
    () => native.validateShortcut("ctrl+banana", "pushToTalk"),
    /unknown key/,
  );
});

test("reports duplicate bindings and hold-prefix overlaps", () => {
  const conflicts = native.findShortcutConflicts([
    "ctrl+opt",
    "ctrl+opt+space",
    "cmd+shift+k",
    "shift+cmd+k",
  ]);
  assert.deepEqual(conflicts, [
    { a: 0, b: 1, kind: "holdPrefix" },
    { a: 2, b: 3, kind: "duplicate" },
  ]);
});

test("HoldToTalk wrapper drives hold, tap and hands-free flows", () => {
  const hold = new native.HoldToTalk();
  assert.deepEqual(hold.handle("down", 0), ["start"]);
  assert.equal(hold.state, "holding");
  assert.deepEqual(hold.handle("up", 900), ["stop:released"]);

  const tap = new native.HoldToTalk({ minHoldMs: 300, doubleTapMs: 400 });
  tap.handle("down", 0);
  assert.deepEqual(tap.handle("up", 100), []);
  assert.deepEqual(tap.handle("down", 300), ["handsFree"]);
  tap.handle("up", 350);
  assert.deepEqual(tap.handle("down", 5000), ["stop:toggled"]);
  assert.throws(() => tap.handle("sideways", 1), /unknown input/);
});

test("Carbon registers and unregisters without any TCC permission", () => {
  const r = native.registerHotkey(101, "ctrl+opt+f12", {}, noop);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.status, 0);
  assert.equal(native.registeredHotkeyCount(), 1);
  assert.equal(
    native.registerHotkey(101, "ctrl+opt+f11", {}, noop).error,
    "id-already-registered",
  );
  assert.equal(native.unregisterHotkey(101), 0);
  assert.equal(native.registeredHotkeyCount(), 0);
  assert.equal(
    native.unregisterHotkey(101),
    -1,
    "second unregister is a no-op",
  );
  // Re-registering after unregister works (no leaked OS registration).
  assert.equal(native.registerHotkey(102, "ctrl+opt+f12", {}, noop).ok, true);
  assert.equal(native.unregisterHotkey(102), 0);
});

test("Carbon rejects a duplicate combo within one process (-9878)", () => {
  assert.equal(native.registerHotkey(201, "ctrl+opt+f12", {}, noop).ok, true);
  const dup = native.registerHotkey(202, "ctrl+opt+f12", {}, noop);
  assert.equal(dup.status, -9878);
  native.unregisterHotkey(201);
});

test("rejects modifier-only and invalid shortcuts before calling Carbon", () => {
  for (const [id, shortcut] of [
    [301, "rightoption"],
    [303, "ctrl+opt"],
  ]) {
    assert.equal(
      native.registerHotkey(id, shortcut, {}, noop).error,
      "needs-event-tap",
    );
  }
  assert.equal(
    native.registerHotkey(302, "cmd+space", {}, noop).error,
    "system-reserved",
  );
  assert.equal(native.registeredHotkeyCount(), 0);
});

test("Carbon does NOT detect conflicts with system shortcuts (Cmd+Space accepted)", () => {
  const r = native.registerHotkey(
    401,
    "cmd+space",
    { skipValidation: true },
    noop,
  );
  assert.equal(
    r.status,
    0,
    "documents why Murmur needs its own reserved-combo list",
  );
  native.unregisterHotkey(401);
});

function holdInChild(shortcut, exclusive) {
  const script = `
    const n = require(${JSON.stringify(addonPath)});
    const r = n.registerHotkey(1, ${JSON.stringify(shortcut)}, { exclusive: ${exclusive} }, () => {});
    console.log(JSON.stringify(r));
    process.stdin.on("data", () => { n.unregisterHotkey(1); process.exit(0); });`;
  const child = spawn(process.execPath, ["-e", script], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  return new Promise((resolve) =>
    child.stdout.once("data", (d) => resolve({ child, result: JSON.parse(d) })),
  );
}

for (const [childExclusive, parentExclusive, expectedStatus] of [
  [true, true, -9878],
  [true, false, 0],
  [false, true, 0],
  [false, false, 0],
]) {
  test(`cross-process: holder exclusive=${childExclusive}, new exclusive=${parentExclusive} -> ${expectedStatus}`, async () => {
    const { child, result } = await holdInChild("ctrl+opt+f10", childExclusive);
    assert.equal(result.ok, true);
    const r = native.registerHotkey(
      501,
      "ctrl+opt+f10",
      { exclusive: parentExclusive },
      noop,
    );
    native.unregisterHotkey(501);
    child.stdin.end("bye");
    assert.equal(r.status, expectedStatus);
  });
}

// The key-tap module is the unused R6 code: only built with `--features key-tap`.
const hasKeyTap = typeof native.startKeyTap === "function";
const noKeyTap = "addon built without the key-tap feature";

test(
  "event tap refuses to start without Input Monitoring and does not prompt",
  {
    skip:
      (!hasKeyTap && noKeyTap) ||
      (perms.inputMonitoring && "Input Monitoring is granted here"),
  },
  () => {
    assert.deepEqual(native.startKeyTap(undefined, noop), {
      ok: false,
      error: "input-monitoring-not-granted",
    });
    assert.equal(native.stopKeyTap(), false);
    assert.equal(
      native.permissionStatus().inputMonitoring,
      false,
      "no implicit grant/prompt",
    );
  },
);

test(
  "event tap starts and stops cleanly when Input Monitoring is granted",
  {
    skip:
      (!hasKeyTap && noKeyTap) ||
      (!perms.inputMonitoring && "needs Input Monitoring (manual run)"),
  },
  () => {
    assert.equal(native.startKeyTap(undefined, noop).ok, true);
    assert.equal(native.startKeyTap(undefined, noop).error, "already-running");
    assert.equal(native.stopKeyTap(), true);
  },
);

test(
  "event tap survives 50 rapid start/stop cycles (regression: use-after-free in stopKeyTap)",
  {
    skip:
      (!hasKeyTap && noKeyTap) ||
      (!perms.inputMonitoring && "needs Input Monitoring (manual run)"),
  },
  () => {
    for (let i = 0; i < 50; i++) {
      assert.equal(native.startKeyTap(undefined, noop).ok, true);
      assert.equal(native.stopKeyTap(), true);
    }
  },
);
