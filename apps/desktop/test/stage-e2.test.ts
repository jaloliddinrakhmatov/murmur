// Stage E part 2 (M3): writing styles per kind of app, context awareness (names near the cursor
// as vocabulary hints for one dictation), and auto-add to dictionary (words re-spelled after a
// dictation). Both reading features are off by default and keep nothing they read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DictationController } from "../src/main/core/controller.ts";
import {
  CorrectionWatcher,
  type FieldRead,
} from "../src/main/dictionary/corrections.ts";
import { categoryFor } from "../src/shared/styles.ts";
import {
  DEFAULT_SETTINGS,
  parseSettingsPatch,
  applyPatch,
} from "../src/shared/settings.ts";
import { STYLE_CARDS } from "../src/renderer/hub/model/style.ts";
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

test("app categories: messages, work chat, email, and everything else", () => {
  assert.equal(categoryFor("com.apple.MobileSMS"), "personal");
  assert.equal(categoryFor("ru.keepcoder.Telegram"), "personal");
  assert.equal(categoryFor("com.tinyspeck.slackmacgap"), "work");
  assert.equal(categoryFor("com.microsoft.teams2"), "work");
  assert.equal(categoryFor("com.apple.mail"), "email");
  assert.equal(categoryFor("com.google.Chrome"), "other");
  assert.equal(categoryFor(null), "other");
});

test("settings: styles default to formal, context features off; a patch keeps the rest", () => {
  assert.deepEqual(DEFAULT_SETTINGS.styles, {
    personal: "formal",
    work: "formal",
    email: "formal",
    other: "formal",
  });
  assert.deepEqual(DEFAULT_SETTINGS.context, {
    awareness: false,
    autoAddCorrections: false,
  });
  const s = applyPatch(
    DEFAULT_SETTINGS,
    parseSettingsPatch({ styles: { personal: "veryCasual" } }),
  );
  assert.equal(s.styles.personal, "veryCasual");
  assert.equal(s.styles.work, "formal");
  assert.throws(() => parseSettingsPatch({ styles: { personal: "shouting" } }));
});

test("style cards show what Murmur would insert (made by the same code)", () => {
  const [formal, casual, veryCasual] = STYLE_CARDS.map((c) => c.example);
  assert.match(formal, /\.$/);
  assert.equal(casual, formal.replace(/\.$/, ""));
  assert.match(veryCasual, /^so we're/);
});

function controller(opts: { context?: string[] } = {}) {
  const clock = new FakeClock();
  const audio = new FakeAudio();
  const inserter = new FakeInserter();
  const history = new FakeHistory();
  const provider = new FakeProvider();
  const vocab: (string[] | undefined)[] = [];
  provider.transcribe = async (_a, o) => {
    vocab.push(o.vocabulary);
    return { text: "hey joey are we on for coffee" };
  };
  const events: string[] = [];
  const c = new DictationController(
    {
      hold: realHold(),
      audio,
      target: fakeTarget(),
      inserter,
      capsule: new FakeCapsule(),
      cancelHotkey: new FakeCancelHotkey(),
      history,
      vault: new FakeVault(),
      provider: () => provider,
      clock,
      newId: () => "d1",
      log: () => {},
      contextTerms: () => {
        events.push(`context:mic-open=${audio.started > 0}`);
        return opts.context ?? [];
      },
      styleText: (text, bundleId) => `${text} [${bundleId}]`,
      inserted: (text) => events.push(`inserted:${text}`),
      dictationStarting: () => events.push("starting"),
      command: { capture: () => null, run: () => events.push("command") },
    },
    { resultDisplayMs: 500 },
  );
  const hold = async (down: () => void, up: () => void) => {
    down();
    for (let i = 0; i < 3; i++) await flush();
    await clock.advance(1500);
    up();
    await clock.advance(50);
    for (let i = 0; i < 6; i++) await flush();
  };
  return { c, inserter, history, vocab, events, hold };
}

test("controller: the app's style is applied to what is inserted and kept", async () => {
  const t = controller();
  await t.hold(
    () => t.c.hotkey("down"),
    () => t.c.hotkey("up"),
  );
  const inserted = t.inserter.calls[0].text;
  assert.match(inserted, /\[com\.example\.target\]$|\[.*\]$/);
  assert.equal(t.history.only.finalText, inserted);
  assert.ok(
    t.events.includes(`inserted:${inserted}`),
    "the correction watcher is told",
  );
});

test("controller: names near the cursor are read once the mic is open and used as hints for that dictation only", async () => {
  const t = controller({ context: ["Dilnoza"] });
  await t.hold(
    () => t.c.hotkey("down"),
    () => t.c.hotkey("up"),
  );
  assert.deepEqual(t.events.slice(0, 2), ["starting", "context:mic-open=true"]);
  assert.ok(t.vocab[0]?.includes("Dilnoza"));
  // Command Mode never reads the context or starts a correction check.
  t.events.length = 0;
  await t.hold(
    () => t.c.commandHotkey("down"),
    () => t.c.commandHotkey("up"),
  );
  assert.deepEqual(t.events, ["command"]);
});

function watcher(
  field: { value: FieldRead },
  opts: { enabled?: boolean; known?: string[]; blocked?: boolean } = {},
) {
  const added: [string, string][] = [];
  const notices: string[] = [];
  const reads: (number | null)[] = [];
  let now = 0;
  const timers: { at: number; fn: () => void }[] = [];
  const w = new CorrectionWatcher({
    enabled: () => opts.enabled ?? true,
    blocked: () => opts.blocked ?? false,
    ownPid: 999,
    read: (location) => {
      reads.push(location);
      return field.value;
    },
    known: (p) => (opts.known ?? []).includes(p),
    add: (p, m) => added.push([p, m]),
    notify: (m) => notices.push(m),
    log: () => {},
    now: () => now,
    later: (ms, fn) => {
      const t = { at: now + ms, fn };
      timers.push(t);
      return () => timers.splice(timers.indexOf(t), 1);
    },
  });
  const advance = (ms: number) => {
    now += ms;
    for (const t of [...timers].filter((x) => x.at <= now)) {
      timers.splice(timers.indexOf(t), 1);
      t.fn();
    }
  };
  return { w, added, notices, reads, advance };
}

const target = { ...fakeTarget().snapshot(), pid: 7 };
const at = (text: string, extra: Partial<FieldRead> = {}): FieldRead => ({
  ok: true,
  pid: 7,
  isSecure: false,
  text,
  cursor: 120,
  start: 100,
  elementKey: "AXTextArea|||Doc",
  ...extra,
});

test("auto-add: a word re-spelled in the same field is added (with what was heard), once", () => {
  const field = { value: at("I met Jalolidin at noon.") };
  const t = watcher(field);
  t.w.inserted("I met Jalolidin at noon.", target);
  t.advance(500);
  assert.deepEqual(t.reads, [null], "located right after the paste");
  field.value = at("I met Jaloliddin at noon.");
  t.advance(20_000);
  assert.deepEqual(t.added, [["Jaloliddin", "Jalolidin"]]);
  assert.deepEqual(t.notices, ["Added “Jaloliddin” to your dictionary"]);
  t.advance(60_000);
  assert.equal(t.reads.length, 2, "nothing more is read");
});

test("auto-add: off, another field, a password field, rewrites and known words add nothing", () => {
  const off = watcher({ value: at("x") }, { enabled: false });
  off.w.inserted("I met Jalolidin.", target);
  off.advance(30_000);
  assert.deepEqual(off.reads, []);

  const field = { value: at("I met Jalolidin.") };
  const moved = watcher(field);
  moved.w.inserted("I met Jalolidin.", target);
  moved.advance(500);
  field.value = at("I met Jaloliddin.", { elementKey: "AXTextField|||Search" });
  moved.advance(20_000);
  assert.deepEqual(moved.added, [], "another field is never compared");
  field.value = at("I met Jaloliddin.");
  moved.w.dictationStarting();
  assert.deepEqual(
    moved.added,
    [["Jaloliddin", "Jalolidin"]],
    "checked at the next dictation instead",
  );

  const secure = watcher({ value: at("pw", { isSecure: true }) });
  secure.w.inserted("pw", { ...target, secure: true });
  secure.advance(30_000);
  assert.deepEqual(secure.reads, []);

  const knownField = { value: at("I met Jalolidin.") };
  const known = watcher(knownField, { known: ["Jaloliddin"] });
  known.w.inserted("I met Jalolidin.", target);
  known.advance(500);
  knownField.value = at("I met Jaloliddin.");
  known.advance(20_000);
  assert.deepEqual(
    known.added,
    [],
    "a word already in the dictionary isn't added again",
  );

  const rewriteField = { value: at("Send it to Kubernetes team.") };
  const rewrite = watcher(rewriteField);
  rewrite.w.inserted("Send it to Kubernetes team.", target);
  rewrite.advance(500);
  rewriteField.value = at("Send it to the platform team.");
  rewrite.advance(20_000);
  assert.deepEqual(rewrite.added, [], "a rewrite isn't a spelling correction");
});

test("auto-add: gives up after two minutes; a paste that isn't before the cursor isn't watched", () => {
  const field = { value: at("I met Jalolidin.") };
  const t = watcher(field);
  t.w.inserted("I met Jalolidin.", target);
  t.advance(500);
  field.value = at("I met Jaloliddin.", { elementKey: "elsewhere" });
  t.advance(130_000);
  field.value = at("I met Jaloliddin.");
  t.w.dictationStarting();
  assert.deepEqual(t.added, []);
  const lost = watcher({ value: at("something else") });
  lost.w.inserted("I met Jalolidin.", target);
  lost.advance(30_000);
  assert.equal(lost.reads.length, 1, "located, didn't match, stopped");
});

test("auto-add: never reads under Secure Event Input, in Murmur, terminals or password managers", () => {
  const blocked = watcher({ value: at("I met Jalolidin.") }, { blocked: true });
  blocked.w.inserted("I met Jalolidin.", target);
  blocked.advance(30_000);
  assert.deepEqual(blocked.reads, [], "Secure Event Input on: nothing is read");

  for (const bundle of [
    "com.apple.Terminal",
    "com.googlecode.iterm2",
    "com.1password.1password",
    "com.agilebits.onepassword7",
    "com.bitwarden.desktop",
    "com.apple.keychainaccess",
    "com.apple.Passwords",
  ]) {
    const t = watcher({ value: at("I met Jalolidin.") });
    t.w.inserted("I met Jalolidin.", { ...target, appBundleId: bundle });
    t.advance(30_000);
    assert.deepEqual(t.reads, [], bundle);
  }

  const own = watcher({ value: at("I met Jalolidin.") });
  own.w.inserted("I met Jalolidin.", { ...target, pid: 999 });
  own.advance(30_000);
  assert.deepEqual(own.reads, [], "Murmur's own windows");
});

test("auto-add: becoming blocked after the paste stops the check; at most five words a day", () => {
  const field = { value: at("I met Jalolidin.") };
  let blocked = false;
  const t = watcher(field);
  const w = new CorrectionWatcher({
    enabled: () => true,
    blocked: () => blocked,
    ownPid: 999,
    read: () => field.value,
    known: () => false,
    add: (p, m) => t.added.push([p, m]),
    notify: () => {},
    log: () => {},
    now: () => 0,
    later: (_ms, fn) => {
      timersToRun.push(fn);
      return () => {};
    },
  });
  const timersToRun: (() => void)[] = [];
  w.inserted("I met Jalolidin.", target);
  timersToRun.shift()!();
  blocked = true;
  field.value = at("I met Jaloliddin.");
  w.dictationStarting();
  assert.deepEqual(t.added, [], "blocked at check time: nothing is read");

  blocked = false;
  // Names mid-sentence: the kind of re-spelling auto-add learns (ordinary words never count).
  const words = [
    "Dilnoza",
    "Karimov",
    "Jaloliddin",
    "Toshkent",
    "Samarqand",
    "Buxoro",
  ];
  const heard = [
    "Dilnoze",
    "Karimow",
    "Jalolidin",
    "Toshkant",
    "Samarkand",
    "Bukhoro",
  ];
  const join = (ws: string[]) => `I met ${ws.join(" and ")}.`;
  const original = join(heard);
  field.value = at(original);
  timersToRun.length = 0;
  w.inserted(original, target);
  timersToRun.shift()!();
  field.value = at(join(words));
  t.added.length = 0;
  w.dictationStarting();
  assert.equal(t.added.length, 5, "the daily cap");
});

function fieldWatcher(field: { text: string }, pid = 7) {
  const added: [string, string][] = [];
  const timers: (() => void)[] = [];
  const w = new CorrectionWatcher({
    enabled: () => true,
    blocked: () => false,
    ownPid: 999,
    read: (location, before, after) => {
      const cursor = field.text.length;
      const from = Math.max(0, (location ?? cursor) - before);
      return {
        ok: true,
        pid,
        isSecure: false,
        text: field.text.slice(from, (location ?? cursor) + after),
        cursor,
        start: from,
        elementKey: "AXTextArea|||Doc",
      };
    },
    known: () => false,
    add: (p, m) => added.push([p, m]),
    notify: () => {},
    log: () => {},
    now: () => 0,
    later: (_ms, fn) => {
      timers.push(fn);
      return () => {};
    },
  });
  return { w, added, run: () => timers.shift()!() };
}

test("auto-add: an edit earlier in the field doesn't make a cut-off word look like a correction", () => {
  const dictated = "Kubernetes rollout is done.";
  const field = { text: `Notes from the weekly platform sync. ${dictated}` };
  const t = fieldWatcher(field);
  t.w.inserted(dictated, target);
  t.run(); // located
  // Three characters deleted earlier in the field move the dictation to the left.
  field.text = field.text.replace("Notes", "es");
  t.run(); // checked
  assert.deepEqual(t.added, []);
});

test("auto-add: the stretch is found again by its context, so a real correction still counts", () => {
  const dictated = "Please deploy Kubernetes today and Jalolidin agrees.";
  const field = { text: `Notes from the weekly platform sync. ${dictated}` };
  const t = fieldWatcher(field);
  t.w.inserted(dictated, target);
  t.run();
  field.text = field.text
    .replace("Notes", "Our notes")
    .replace("Jalolidin", "Jaloliddin");
  t.run();
  assert.deepEqual(t.added, [["Jaloliddin", "Jalolidin"]]);
});

test("auto-add: a fragment of the heard word is never added", () => {
  const field = { text: "Please deploy Kubernetes" };
  const t = fieldWatcher(field);
  t.w.inserted("Please deploy Kubernetes", target);
  t.run();
  field.text = "Please deploy bernetes";
  t.run();
  assert.deepEqual(t.added, []);
});
