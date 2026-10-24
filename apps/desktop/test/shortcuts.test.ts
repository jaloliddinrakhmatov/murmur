// Stage 6B optional shortcuts: registration through the hotkey adapter (fake native addon: no
// real global hotkey is registered on the test machine), saving and restoring through the
// service, and the last-transcript actions they trigger (fake inserter: nothing is pasted).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CarbonHotkeys } from "../src/main/native/hotkeys.ts";
import { HubService, type HubServiceDeps } from "../src/main/hub/service.ts";
import { SettingsStore, plainCodec } from "../src/main/settings/store.ts";
import {
  lastTranscriptActions,
  REPEAT_GUARD_MS,
} from "../src/main/hub/last-transcript.ts";
import type { NativeAddon } from "../src/main/native/addon.ts";
import type { InsertOutcome } from "../src/main/core/types.ts";

const ORDER = ["ctrl", "opt", "shift", "cmd"];
const ALIAS: Record<string, string> = {
  control: "ctrl",
  option: "opt",
  alt: "opt",
  command: "cmd",
};

/** Normalizes like the Rust rules for the cases used here (modifiers in fixed order). */
function normalize(combo: string): string {
  const parts = combo
    .toLowerCase()
    .split("+")
    .map((p) => ALIAS[p] ?? p);
  const mods = ORDER.filter((m) => parts.includes(m));
  const key = parts.filter((p) => !ORDER.includes(p));
  return [...mods.map((m) => m[0].toUpperCase() + m.slice(1)), ...key].join(
    "+",
  );
}

function fakeNative(taken: string[] = []) {
  const registered = new Map<
    number,
    { combo: string; cb: (e: { kind: "pressed" | "released" }) => void }
  >();
  const native = {
    registered,
    taken: taken.map(normalize),
    validateShortcut(shortcut: string) {
      const n = normalize(shortcut);
      const errors: string[] = [];
      if (n === "Cmd+v") errors.push("system-reserved");
      if (!/Ctrl|Cmd|Opt/.test(n)) errors.push("needs-modifier");
      if (/^Ctrl\+[a-z0-9]$/.test(n))
        errors.push("control-letter-used-by-text-editing");
      if (/^Cmd\+[a-z0-9]$/.test(n)) errors.push("command-letter-used-by-apps");
      return {
        normalized: n,
        backend: /Ctrl|Cmd/.test(n) ? "carbon" : "eventTap",
        errors,
        warnings: [],
      };
    },
    registerHotkey(
      id: number,
      shortcut: string,
      _o: unknown,
      cb: (e: { kind: "pressed" | "released" }) => void,
    ) {
      const n = normalize(shortcut);
      if (
        native.taken.includes(n) ||
        [...registered.values()].some((r) => r.combo === n)
      )
        return { ok: false, status: -9878 };
      registered.set(id, { combo: n, cb });
      return { ok: true, status: 0, normalized: n };
    },
    unregisterHotkey(id: number) {
      return registered.delete(id) ? 0 : -1;
    },
    /** Simulates macOS delivering the hotkey with this id. */
    press(id: number, kind: "pressed" | "released" = "pressed") {
      registered.get(id)?.cb({ kind });
    },
  };
  return native;
}

function hotkeys(taken: string[] = []) {
  const native = fakeNative(taken);
  const actions: string[] = [];
  const ptt: string[] = [];
  const h = new CarbonHotkeys(
    native as unknown as NativeAddon,
    (k) => ptt.push(k),
    (a, k) => actions.push(`${a}:${k}`),
  );
  h.bind("ctrl+opt+space");
  return { h, native, actions, ptt };
}

test("a new Control-letter shortcut is refused, a saved one keeps working", () => {
  const { h, native } = hotkeys();
  const strict = h.replaceAction("pasteLast", "ctrl+a");
  assert.equal(strict.ok, false);
  assert.match(strict.ok ? "" : strict.error, /text-editing/);
  assert.equal(native.registered.size, 1); // push to talk only
  // As saved before the rule existed: registered (validation skipped), reported as a warning.
  const kept = h.bindAction("copyLast", "ctrl+e");
  assert.equal(kept?.registered, true);
  assert.deepEqual(h.check("ctrl+e", "copyLast", true).errors, []);
  assert.deepEqual(h.check("ctrl+e", "copyLast", true).warnings, [
    "control-letter-used-by-text-editing",
  ]);
  assert.ok(h.check("ctrl+e", "copyLast").errors.length > 0);
  const t = h.bindTransforms([{ id: "t1", combo: "cmd+b" }]);
  assert.equal(t.get("t1")?.registered, true);
});

test("restore puts back a kept legacy shortcut that replace (strict) would refuse", () => {
  const { h, native } = hotkeys();
  assert.equal(h.bind("ctrl+d").registered, true, "kept as saved");
  assert.equal(h.replace("ctrl+opt+k").ok, true);
  assert.equal(h.replace("ctrl+d").ok, false, "strict refuses a new ctrl+d");
  // replace() above failed and re-bound the previous one; now simulate a failed save.
  assert.equal(h.restore("ctrl+d").registered, true);
  assert.equal(h.current.combo, "Ctrl+d");
  assert.deepEqual(
    [...native.registered.values()].map((r) => r.combo),
    ["Ctrl+d"],
    "the new combo is no longer live",
  );
});

test("optional shortcuts register with their own id and deliver their action", () => {
  const { h, native, actions } = hotkeys();
  const s = h.bindAction("pasteLast", "ctrl+cmd+v");
  assert.deepEqual(s, { combo: "Ctrl+Cmd+v", registered: true, error: null });
  assert.equal(native.registered.get(3)?.combo, "Ctrl+Cmd+v");
  native.press(3);
  native.press(3, "released");
  assert.deepEqual(actions, ["pasteLast:pressed", "pasteLast:released"]);
  assert.deepEqual(h.actions, {
    pasteLast: { combo: "Ctrl+Cmd+v", registered: true, error: null },
    copyLast: null,
    copyOriginal: null,
    openScratchpad: null,
    transformViewChanges: null,
    commandMode: null,
    pressEnter: null,
    startNotetaker: null,
  });
});

test("conflicts: a combination Murmur already uses is refused, for actions and for push to talk", () => {
  const { h, native } = hotkeys();
  const r = h.replaceAction("copyLast", "ctrl+opt+space");
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /used-by:pushToTalk/);
  assert.equal(native.registered.has(4), false);
  h.bindAction("pasteLast", "ctrl+cmd+v");
  assert.match(
    h.check("control+command+v", "copyOriginal").errors.join(),
    /used-by:pasteLast/,
  );
  assert.match(
    h.check("ctrl+cmd+v", "pushToTalk").errors.join(),
    /used-by:pasteLast/,
  );
  assert.deepEqual(
    h.check("ctrl+cmd+v", "pasteLast").errors,
    [],
    "its own combination is not a conflict",
  );
  assert.match(h.check("cmd+v", "copyLast").errors.join(), /system-reserved/);
  assert.match(
    h.check("opt+v", "copyLast").errors.join(),
    /needs-input-monitoring/,
  );
});

test("a failed change keeps the previous binding; failures never touch other shortcuts; clearing unregisters", () => {
  const { h, native } = hotkeys(["ctrl+cmd+x"]);
  h.bindAction("copyLast", "ctrl+cmd+c");
  h.bindAction("pasteLast", "ctrl+cmd+v");
  const r = h.replaceAction("copyLast", "ctrl+cmd+x");
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /already used by another app/);
  assert.equal(native.registered.get(4)?.combo, "Ctrl+Cmd+c", "kept");
  assert.equal(native.registered.get(3)?.combo, "Ctrl+Cmd+v", "untouched");
  assert.equal(native.registered.get(1)?.combo, "Ctrl+Opt+space", "untouched");
  assert.deepEqual(h.replaceAction("copyLast", null), {
    ok: true,
    status: null,
  });
  assert.equal(native.registered.has(4), false);
  assert.equal(h.actions.copyLast, null);
  // A first-time binding that fails leaves the action unset.
  assert.equal(h.replaceAction("copyOriginal", "ctrl+cmd+x").ok, false);
  assert.equal(native.registered.has(5), false);
});

test("suspending for the recorder releases every Murmur shortcut; resuming restores them", () => {
  const { h, native, ptt } = hotkeys();
  h.bindAction("pasteLast", "ctrl+cmd+v");
  h.suspend(true);
  assert.equal(native.registered.size, 0);
  native.press(1);
  assert.deepEqual(ptt, [], "pressing push to talk now reaches the recorder");
  assert.equal(h.current.registered, true, "status kept while paused");
  h.suspend(false);
  assert.deepEqual(
    [...native.registered.entries()].map(([id, r]) => [id, r.combo]),
    [
      [1, "Ctrl+Opt+space"],
      [3, "Ctrl+Cmd+v"],
    ],
  );
});

function service(
  native = fakeNative(),
  dir = mkdtempSync(join(tmpdir(), "murmur-keys-")),
) {
  const settings = new SettingsStore(dir, plainCodec);
  const h = new CarbonHotkeys(native as unknown as NativeAddon, () => {});
  h.bind(settings.get().shortcut);
  let phase = "idle";
  const hub = new HubService({
    settings,
    hotkeys: h,
    controller: {
      get currentPhase() {
        return phase;
      },
    },
    env: {},
  } as unknown as HubServiceDeps);
  return {
    hub,
    h,
    settings,
    native,
    dir,
    setPhase: (p: string) => (phase = p),
  };
}

test("service: a shortcut is saved only after it registered, and comes back after a restart", () => {
  const s = service(fakeNative(["ctrl+cmd+x"]));
  s.hub.setActionShortcut({ action: "copyLast", shortcut: "ctrl+cmd+c" });
  assert.equal(s.settings.get().shortcuts.copyLast, "ctrl+cmd+c");
  assert.throws(
    () =>
      s.hub.setActionShortcut({ action: "copyLast", shortcut: "ctrl+cmd+x" }),
    /already used by another app or by macOS/,
  );
  assert.equal(s.settings.get().shortcuts.copyLast, "ctrl+cmd+c", "unchanged");
  assert.throws(
    () =>
      s.hub.setActionShortcut({
        action: "pasteLast",
        shortcut: "ctrl+opt+space",
      }),
    /Murmur already uses that shortcut for Push to talk/,
  );
  assert.throws(() =>
    s.hub.setActionShortcut({ action: "launchRockets", shortcut: "ctrl+k" }),
  );
  assert.throws(() => s.hub.setActionShortcut({ action: "copyLast" }));
  // A settings patch can't set them (only the validated path can).
  s.settings.update({ shortcuts: { pasteLast: "ctrl+cmd+p" } });
  assert.equal(s.settings.get().shortcuts.pasteLast, null);

  // Restart: same settings file, fresh registrations.
  const native = fakeNative();
  const again = service(native, s.dir);
  again.hub.syncActionShortcuts();
  assert.equal(native.registered.get(4)?.combo, "Ctrl+Cmd+c");
  assert.equal(again.h.actions.copyLast?.registered, true);

  // Clearing removes the registration and the saved value.
  again.hub.setActionShortcut({ action: "copyLast", shortcut: null });
  assert.equal(native.registered.has(4), false);
  assert.equal(again.settings.get().shortcuts.copyLast, null);
});

test("service: at launch a taken shortcut shows an error while the others still work", () => {
  const s = service();
  s.hub.setActionShortcut({ action: "copyLast", shortcut: "ctrl+cmd+c" });
  s.hub.setActionShortcut({ action: "pasteLast", shortcut: "ctrl+cmd+v" });
  const native = fakeNative(["ctrl+cmd+v"]); // another app took it meanwhile
  const again = service(native, s.dir);
  again.hub.syncActionShortcuts();
  assert.equal(again.h.actions.pasteLast?.registered, false);
  assert.match(again.h.actions.pasteLast?.error ?? "", /another app/);
  assert.equal(again.h.actions.copyLast?.registered, true);
  assert.equal(again.h.current.registered, true, "push to talk unaffected");
  assert.equal(
    again.settings.get().shortcuts.pasteLast,
    "ctrl+cmd+v",
    "kept, so it works again once the other app lets go",
  );
});

test("service: shortcuts can't be paused mid-dictation, and saving always resumes them first", () => {
  const s = service();
  s.setPhase("recording");
  assert.equal(s.hub.suspendShortcuts(true), false);
  assert.equal(s.h.isSuspended, false);
  s.setPhase("idle");
  assert.equal(s.hub.suspendShortcuts(true), true);
  assert.equal(s.native.registered.size, 0);
  s.hub.setActionShortcut({ action: "copyLast", shortcut: "ctrl+cmd+c" });
  assert.equal(s.h.isSuspended, false);
  assert.equal(s.native.registered.size, 2, "push to talk and the new one");
});

// ---- The actions themselves -----------------------------------------------------------------------

function actions(
  over: {
    outcome?: InsertOutcome | null;
    copies?: Partial<Record<"final" | "raw", boolean>>;
    available?: boolean;
    phase?: string;
  } = {},
) {
  let t = 1000;
  const shown: [string, string | undefined][] = [];
  const pasted: number[] = [];
  let release: (() => void) | null = null;
  const holdPaste = { on: false };
  const a = lastTranscriptActions({
    service: {
      pasteLastTranscript: async () => {
        pasted.push(t);
        if (holdPaste.on) await new Promise<void>((r) => (release = r));
        return over.outcome === undefined
          ? { strategy: "clipboard-paste" }
          : over.outcome;
      },
      copyLastTranscript: (which) => over.copies?.[which] ?? true,
      lastTranscript: () => ({
        available: over.available ?? true,
        hasOriginal: true,
      }),
    },
    controller: {
      currentPhase: over.phase ?? "idle",
      announce: (state, message) => shown.push([state, message]),
    },
    log: () => {},
    now: () => t,
  });
  return {
    a,
    shown,
    pasted,
    holdPaste,
    advance: (ms: number) => (t += ms),
    release: () => release?.(),
  };
}

test("actions: paste on key-up, copy on key-down; key repeat and a press during a paste are ignored", async () => {
  const s = actions();
  await s.a.onShortcut("pasteLast", "pressed");
  assert.equal(s.pasted.length, 0, "not on key-down");
  await s.a.onShortcut("pasteLast", "released");
  assert.equal(s.pasted.length, 1);
  await s.a.onShortcut("pasteLast", "released");
  assert.equal(
    s.pasted.length,
    1,
    "a repeat within the guard is the same press",
  );
  s.advance(REPEAT_GUARD_MS + 1);
  s.holdPaste.on = true;
  const slow = s.a.onShortcut("pasteLast", "released");
  s.advance(REPEAT_GUARD_MS + 1);
  void s.a.onShortcut("pasteLast", "released");
  assert.equal(s.pasted.length, 2, "no second paste while one is running");
  s.release();
  await slow;
  s.advance(REPEAT_GUARD_MS + 1);
  s.a.onShortcut("copyLast", "released");
  assert.deepEqual(s.shown.at(-1), ["inserted", undefined]);
  s.a.onShortcut("copyLast", "pressed");
  assert.deepEqual(s.shown.at(-1), ["copied", "Copied — press ⌘V to paste"]);
});

test("actions: the dictation safety outcomes, missing History and missing original words are reported", async () => {
  const cases: [InsertOutcome | null, [string, string | undefined]][] = [
    [
      { strategy: "rejected", reason: "secure-field" },
      ["error", "Password field — not pasted"],
    ],
    [
      { strategy: "clipboard-only", reason: "no-post-event-permission" },
      ["copied", "Paste is off — copied, press ⌘V"],
    ],
    [
      { strategy: "clipboard-only", reason: "self-target" },
      ["copied", "Murmur is in front — copied, press ⌘V"],
    ],
    [
      { strategy: "clipboard-only", reason: "target-changed" },
      ["copied", "App changed — copied, press ⌘V"],
    ],
    [null, ["error", "No dictation to paste yet"]],
  ];
  for (const [outcome, expected] of cases) {
    const s = actions({ outcome });
    await s.a.paste();
    assert.deepEqual(s.shown, [expected]);
  }
  const none = actions({
    copies: { final: false, raw: false },
    available: false,
  });
  none.a.copy("final");
  none.a.copy("raw");
  assert.deepEqual(none.shown, [
    ["error", "No dictation to copy yet"],
    ["error", "No dictation to copy yet"],
  ]);
  const noOriginal = actions({ copies: { raw: false } });
  noOriginal.a.copy("raw");
  assert.deepEqual(noOriginal.shown, [
    ["error", "No original words for the last dictation"],
  ]);
  const busy = actions({ phase: "recording" });
  await busy.a.paste();
  busy.a.copy("final");
  assert.deepEqual(busy.shown, [], "never during a dictation");
  assert.deepEqual(busy.pasted, []);
});

test("fn / Globe feasibility: the real native rules need the event tap (Input Monitoring), so this version refuses them and keeps the current shortcut", async () => {
  const { loadNative } = await import("../src/main/native/addon.ts");
  const { shortcutMessage } =
    await import("../src/renderer/hub/model/settings.ts");
  const native = loadNative();
  // Validation only: nothing is registered with macOS here.
  const h = new CarbonHotkeys(native, () => {});
  for (const combo of ["fn", "globe", "fn+space", "rightoption"]) {
    const v = native.validateShortcut(combo, "pushToTalk");
    assert.equal(v.backend, "eventTap", `${combo} needs the event tap`);
    assert.ok(v.warnings.includes("requires-input-monitoring"));
    const check = h.check(combo, "pushToTalk");
    assert.ok(
      check.errors.some((e) => e.startsWith("needs-input-monitoring")),
      `${combo} refused`,
    );
    assert.match(
      shortcutMessage(check.errors.at(-1)!),
      /fn \(Globe\).*need Input Monitoring/,
    );
  }
  assert.equal(h.current.registered, false, "nothing was registered");
});
