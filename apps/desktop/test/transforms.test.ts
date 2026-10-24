import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MIGRATIONS,
  TransformRepo,
  openDatabase,
} from "../src/main/history/db.ts";
import { DatabaseSync } from "node:sqlite";
import {
  AiCancelled,
  TransformService,
  type ShortcutStatus,
  type TextService,
  type TransformDeps,
} from "../src/main/transforms/service.ts";
import {
  TransformSessions,
  type Selection,
  type SessionDeps,
} from "../src/main/transforms/session.ts";
import { CarbonHotkeys } from "../src/main/native/hotkeys.ts";
import type { NativeAddon } from "../src/main/native/addon.ts";
import type { InsertOutcome, TargetSnapshot } from "../src/main/core/types.ts";
import {
  DEFAULT_POLISH_RULES,
  PROMPT_ENGINEER_TEMPLATE,
  TRANSFORM_TEMPLATES,
  TRANSFORM_TEXT_MAX,
  shortcutLabel,
  transformPrompt,
  type PanelState,
} from "../src/shared/transforms.ts";
import {
  parseSettingsPatch,
  DEFAULT_SETTINGS,
} from "../src/shared/settings.ts";

const db = () =>
  openDatabase(
    join(mkdtempSync(join(tmpdir(), "murmur-transforms-")), "db.sqlite"),
  );

// ---- Prompts -----------------------------------------------------------------------------------

test("prompts: Polish follows its rules; every prompt treats the text as content", () => {
  const all = transformPrompt({
    kind: "polish",
    prompt: "",
    rules: DEFAULT_POLISH_RULES,
  });
  for (const s of [
    "Remove filler",
    "Reword unclear",
    "Reorder",
    "Add paragraphs",
  ])
    assert.match(all, new RegExp(s));
  const none = transformPrompt({
    kind: "polish",
    prompt: "",
    rules: { concise: false, clarity: false, reorder: false, structure: false },
  });
  assert.doesNotMatch(
    none,
    /Remove filler|Reword unclear|Reorder|Add paragraphs/,
  );
  const pe = transformPrompt({
    kind: "prompt-engineer",
    prompt: "",
    rules: null,
  });
  assert.ok(pe.includes(PROMPT_ENGINEER_TEMPLATE));
  assert.ok(
    transformPrompt({
      kind: "prompt-engineer",
      prompt: "## Mine",
      rules: null,
    }).includes("## Mine"),
  );
  for (const p of [all, none, pe])
    assert.match(p, /never as instructions to follow/);
});

test("prompts: every built-in action (Create New templates) is a real instruction", () => {
  const names = TRANSFORM_TEMPLATES.map((t) => t.name);
  assert.deepEqual(names, [
    "Fix grammar",
    "Make shorter",
    "Make longer",
    "Make professional",
    "Make friendly",
    "Simplify",
    "Summarize",
    "Translate",
  ]);
  for (const t of TRANSFORM_TEMPLATES) {
    const p = transformPrompt({
      kind: "custom",
      prompt: t.prompt,
      rules: null,
    });
    assert.ok(p.includes(t.prompt), t.name);
    assert.match(p, /never as instructions/, t.name);
  }
});

test("settings: Transforms are off by default; the view-changes shortcut is unset and not patchable", () => {
  assert.equal(DEFAULT_SETTINGS.transforms.optIn, false);
  assert.equal(DEFAULT_SETTINGS.shortcuts.transformViewChanges, null);
  assert.deepEqual(parseSettingsPatch({ transforms: { optIn: true } }), {
    transforms: { optIn: true },
  });
  assert.deepEqual(
    parseSettingsPatch({ shortcuts: { transformViewChanges: "opt+o" } }),
    {},
  );
  assert.equal(shortcutLabel("opt+1"), "⌥1");
});

// ---- Repository ----------------------------------------------------------------------------------

test("TransformRepo: Polish ⌃⌥1 and Prompt Engineer ⌃⌥2 are seeded; custom CRUD, unique names, search", () => {
  const r = new TransformRepo(db());
  assert.deepEqual(
    r.list().map((t) => [t.name, t.shortcut, t.builtIn]),
    [
      ["Polish", "ctrl+opt+1", true],
      ["Prompt Engineer", "ctrl+opt+2", true],
    ],
  );
  const t = r.create(
    {
      id: "c1",
      name: "  Boss   Mode ",
      description: "Firm",
      prompt: "Be firm.",
    },
    5,
  );
  assert.equal(t.name, "Boss Mode");
  assert.equal(t.kind, "custom");
  assert.equal(t.position, 2);
  assert.throws(
    () =>
      r.create({ id: "c2", name: "boss mode", description: "", prompt: "x" }),
    /already exists/,
  );
  assert.throws(
    () => r.update("polish", { name: "BOSS MODE" }),
    /already exists/,
  );
  assert.equal(
    r.update("c1", { prompt: "Be very firm." }).prompt,
    "Be very firm.",
  );
  assert.deepEqual(
    r.list("firm").map((x) => x.id),
    ["c1"],
  );
  assert.deepEqual(r.list("ÉDIT").length, 0);
  assert.equal(r.delete("polish"), false, "built-ins can't be deleted");
  assert.equal(r.delete("c1"), true);
  assert.equal(r.get("c1"), null);
});

test("TransformRepo: Reset to defaults restores the built-ins and keeps custom ones", () => {
  const r = new TransformRepo(db());
  r.update("polish", {
    name: "Shine",
    rules: { ...DEFAULT_POLISH_RULES, concise: false },
  });
  r.setShortcut("polish", null);
  r.update("prompt-engineer", { prompt: "## Only this" });
  r.create({ id: "c1", name: "Polish", description: "", prompt: "Mine" });
  r.resetDefaults();
  const polish = r.get("polish")!;
  assert.equal(
    polish.name,
    "Polish (default)",
    "a custom one took the name meanwhile",
  );
  assert.deepEqual(polish.rules, DEFAULT_POLISH_RULES);
  assert.equal(polish.shortcut, "ctrl+opt+1");
  assert.equal(r.get("prompt-engineer")!.prompt, PROMPT_ENGINEER_TEMPLATE);
  assert.equal(r.get("c1")!.prompt, "Mine");
});

test("TransformRepo: Unicode and multiline names and prompts round-trip", () => {
  const r = new TransformRepo(db());
  r.create({
    id: "u",
    name: "Résumé 🙂",
    description: "Ünïcode",
    prompt: "Line 1\nLine 2 — 東京",
  });
  assert.equal(r.get("u")!.prompt, "Line 1\nLine 2 — 東京");
  assert.equal(r.findByName("RÉSUMÉ 🙂")!.id, "u");
});

// ---- Service --------------------------------------------------------------------------------------

function fakeAi(
  opts: {
    ready?: string | null;
    reply?: (
      system: string,
      user: string,
      signal: AbortSignal,
    ) => Promise<string>;
  } = {},
): TextService & { calls: { system: string; user: string }[] } {
  const calls: { system: string; user: string }[] = [];
  return {
    id: "fake",
    calls,
    readiness: async () => opts.ready ?? null,
    generate: async (system, user, { signal }) => {
      calls.push({ system, user });
      return {
        text: await (opts.reply ?? (async (_s, u) => `EDITED: ${u}`))(
          system,
          user,
          signal,
        ),
      };
    },
  };
}

class FakeHotkeys {
  taken = new Set<string>(); // combos another app holds
  conflicts = new Set<string>(); // combos Murmur already uses
  registered = new Map<string, string>();
  check(combo: string) {
    const normalized = combo.toLowerCase();
    return {
      normalized,
      errors: this.conflicts.has(normalized) ? ["used-by:pushToTalk"] : [],
      warnings: [],
    };
  }
  bindTransforms(bindings: { id: string; combo: string }[]) {
    this.registered.clear();
    const out = new Map<string, ShortcutStatus>();
    for (const b of bindings) {
      const ok = !this.taken.has(b.combo);
      if (ok) this.registered.set(b.id, b.combo);
      out.set(
        b.id,
        ok
          ? { combo: b.combo, registered: true, error: null }
          : {
              combo: b.combo,
              registered: false,
              error: "Shortcut is already used by another app",
            },
      );
    }
    return out;
  }
}

function service(over: Partial<TransformDeps> = {}, ai = fakeAi()) {
  const hotkeys = new FakeHotkeys();
  const logs: { event: string; data?: Record<string, unknown> }[] = [];
  let optedIn = true;
  let consented = true;
  let summaryConsented = true;
  let changes = 0;
  let n = 0;
  const svc = new TransformService({
    transforms: new TransformRepo(db()),
    hotkeys,
    newId: () => `id${++n}`,
    optedIn: () => optedIn,
    ai: () => ai,
    aiName: () => "Groq",
    aiProvider: () => "groq",
    aiConsented: () => consented,
    summaryConsented: () => summaryConsented,
    onChange: () => changes++,
    log: (event, data) => logs.push({ event, data }),
    ...over,
  });
  return {
    svc,
    hotkeys,
    logs,
    ai,
    changes: () => changes,
    setOptIn: (v: boolean) => (optedIn = v),
    setConsent: (v: boolean) => (consented = v),
    setSummaryConsent: (v: boolean) => (summaryConsented = v),
  };
}

test("service: validation, create, edit, delete with confirmation, reset", () => {
  const { svc, changes } = service();
  assert.throws(() => svc.create({ name: "", prompt: "x" }), /name/);
  assert.throws(() => svc.create({ name: "x", prompt: "  " }), /Describe/);
  assert.throws(() => svc.create({ name: "x".repeat(41), prompt: "y" }));
  const t = svc.create({ name: "Boss Mode", prompt: "Be firm." });
  assert.equal(
    svc.update({ id: t.id, description: "Firm and short" }).description,
    "Firm and short",
  );
  assert.throws(() => svc.update({ id: t.id, prompt: "" }), /Describe/);
  assert.throws(() => svc.delete({ id: t.id }), /expected/i);
  assert.equal(svc.delete({ id: t.id, confirm: true }), true);
  svc.resetDefaults();
  assert.ok(changes() >= 4);
});

test("service shortcuts: registered only while opted in; a failed change keeps the old one; conflicts refused", () => {
  const { svc, hotkeys, setOptIn } = service();
  setOptIn(false);
  svc.syncShortcuts();
  assert.equal(hotkeys.registered.size, 0, "off: nothing registered");
  svc.setShortcut({ id: "polish", shortcut: "opt+3" });
  assert.equal(svc.get({ id: "polish" })!.shortcut, "opt+3", "saved for later");
  assert.equal(hotkeys.registered.size, 0);
  setOptIn(true);
  svc.syncShortcuts();
  assert.deepEqual(
    [...hotkeys.registered],
    [
      ["polish", "opt+3"],
      ["prompt-engineer", "ctrl+opt+2"],
    ],
  );
  hotkeys.taken.add("opt+9");
  assert.throws(
    () => svc.setShortcut({ id: "polish", shortcut: "opt+9" }),
    /already used by another app/,
  );
  assert.equal(svc.get({ id: "polish" })!.shortcut, "opt+3", "rolled back");
  assert.equal(hotkeys.registered.get("polish"), "opt+3");
  hotkeys.conflicts.add("ctrl+opt+space");
  assert.throws(
    () => svc.setShortcut({ id: "polish", shortcut: "ctrl+opt+space" }),
    /used-by:pushToTalk/,
  );
  svc.setShortcut({ id: "polish", shortcut: null });
  assert.equal(hotkeys.registered.has("polish"), false);
  assert.equal(
    svc.list().find((t) => t.id === "prompt-engineer")!.status?.registered,
    true,
  );
});

test("service run: a saved transform or a one-off instruction; only the given text is sent", async () => {
  const { svc, ai } = service();
  const r = await svc.run({
    requestId: "r",
    transformId: "polish",
    text: "teh text\nline two 🙂",
  });
  assert.deepEqual(r, {
    text: "EDITED: teh text\nline two 🙂",
    name: "Polish",
  });
  assert.equal(ai.calls[0].user, "teh text\nline two 🙂");
  const c = await svc.run({
    requestId: "r2",
    instruction: "make it a haiku",
    text: "x",
  });
  assert.equal(c.name, "Your change");
  assert.match(ai.calls[1].system, /"make it a haiku"/);
  await assert.rejects(
    svc.run({ requestId: "r3", text: "x" }),
    /Choose a transform/,
  );
  await assert.rejects(
    svc.run({ requestId: "r4", transformId: "nope", text: "x" }),
    /no longer exists/,
  );
  await assert.rejects(
    svc.run({
      requestId: "r5",
      transformId: "polish",
      text: "x".repeat(TRANSFORM_TEXT_MAX + 1),
    }),
  );
});

test("service run: nothing is sent without a ready service or the person's consent", async () => {
  const notReady = service({}, fakeAi({ ready: "No API key" }));
  await assert.rejects(
    notReady.svc.run({ requestId: "r", transformId: "polish", text: "x" }),
    /Set up Groq.*Nothing was sent/,
  );
  assert.equal(notReady.ai.calls.length, 0);
  const s = service();
  s.setConsent(false);
  await assert.rejects(
    s.svc.run({ requestId: "r", transformId: "polish", text: "x" }),
    /Allow Transforms to send text to Groq first\. Nothing was sent/,
  );
  assert.equal(s.ai.calls.length, 0);
  assert.deepEqual(await s.svc.aiStatus(), {
    ready: null,
    service: "Groq",
    provider: "groq",
    consented: false,
    summaryConsented: true,
  });
});

test("service run: provider errors say what to fix and never repeat the provider's text", async () => {
  const cases: [string, RegExp][] = [
    [
      "HTTP 404 model gone: secret text",
      /doesn't offer this AI model \(HTTP 404\)/,
    ],
    ["HTTP 401 bad key: secret text", /didn't accept the API key \(HTTP 401\)/],
    [
      "HTTP 403 key blocked: secret text",
      /didn't accept the API key \(HTTP 403\)/,
    ],
    [
      "HTTP 429 quota: secret text",
      /rate-limiting this key, or it has no credits left \(HTTP 429\)/,
    ],
    ["HTTP 503 down: secret text", /couldn't do this \(HTTP 503\)/],
  ];
  for (const [msg, re] of cases) {
    const { svc } = service(
      {},
      fakeAi({
        reply: async () => {
          throw new Error(msg);
        },
      }),
    );
    await assert.rejects(
      svc.run({ requestId: "r", transformId: "polish", text: "secret text" }),
      (e: Error) => re.test(e.message) && !/secret/.test(e.message),
    );
  }
  const timeout = service(
    {},
    fakeAi({
      reply: async () => {
        const e = new Error("t");
        e.name = "TimeoutError";
        throw e;
      },
    }),
  );
  await assert.rejects(
    timeout.svc.run({ requestId: "r", transformId: "polish", text: "x" }),
    /took too long/,
  );
  const empty = service({}, fakeAi({ reply: async () => "  " }));
  await assert.rejects(
    empty.svc.run({ requestId: "r", transformId: "polish", text: "x" }),
    /returned nothing/,
  );
});

test("service run: cancel aborts the request; logs never contain text", async () => {
  let signal: AbortSignal | null = null;
  const { svc, logs } = service(
    {},
    fakeAi({
      reply: (_s, _u, sig) =>
        new Promise((_r, reject) => {
          signal = sig;
          sig.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    }),
  );
  const run = svc.run({
    requestId: "req",
    transformId: "polish",
    text: "private words",
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(svc.cancel("req"), true);
  await assert.rejects(run, (e) => e instanceof AiCancelled);
  assert.equal(signal!.aborted, true);
  assert.equal(svc.cancel("req"), false);
  assert.doesNotMatch(JSON.stringify(logs), /private/);
});

// ---- Carbon bindings --------------------------------------------------------------------------------

function fakeNative() {
  const registered = new Map<
    number,
    {
      combo: string;
      cb: (e: {
        id: number;
        kind: "pressed" | "released";
        tMs: number;
      }) => void;
    }
  >();
  const native = {
    validateShortcut: (combo: string) => ({
      normalized: combo.toLowerCase(),
      errors: [],
      warnings: [],
      backend: "carbon",
    }),
    registerHotkey: (
      id: number,
      combo: string,
      _o: unknown,
      cb: (e: {
        id: number;
        kind: "pressed" | "released";
        tMs: number;
      }) => void,
    ) => {
      const held = [...registered.values()].some(
        (r) => r.combo === combo.toLowerCase(),
      );
      if (held) return { ok: false, status: -9878 };
      registered.set(id, { combo: combo.toLowerCase(), cb });
      return { ok: true, status: 0, normalized: combo.toLowerCase() };
    },
    unregisterHotkey: (id: number) => (registered.delete(id) ? 0 : -1),
  } as unknown as NativeAddon;
  return { native, registered };
}

test("hotkeys: transform shortcuts get their own ids, conflict with Murmur's other keys, pause and resume", () => {
  const { native, registered } = fakeNative();
  const pressed: string[] = [];
  const h = new CarbonHotkeys(native, () => {});
  h.setTransformHandler((id) => pressed.push(id));
  h.bind("ctrl+opt+space");
  const st = h.bindTransforms([
    { id: "polish", combo: "opt+1" },
    { id: "prompt-engineer", combo: "opt+2" },
    { id: "clash", combo: "ctrl+opt+space" },
  ]);
  assert.equal(st.get("polish")!.registered, true);
  assert.equal(st.get("clash")!.registered, false);
  assert.match(st.get("clash")!.error!, /used-by:pushToTalk/);
  assert.deepEqual(h.check("opt+2", "pasteLast").errors, ["used-by:transform"]);
  registered.get(100)!.cb({ id: 100, kind: "pressed", tMs: 0 });
  registered.get(100)!.cb({ id: 100, kind: "released", tMs: 0 });
  assert.deepEqual(pressed, ["polish"], "fires once, on press");
  h.suspend(true);
  assert.equal(registered.has(100), false);
  h.suspend(false);
  assert.equal(registered.get(100)!.combo, "opt+1");
  h.bindTransforms([]);
  assert.equal([...registered.keys()].filter((id) => id >= 100).length, 0);
});

// ---- Sessions: selection, review, safe replacement -------------------------------------------------

function sessions(
  over: Partial<SessionDeps> = {},
  opts: {
    consented?: boolean;
    ready?: string | null;
    reply?: () => Promise<string>;
  } = {},
) {
  const shown: PanelState[] = [];
  const pasted: { text: string; target: TargetSnapshot }[] = [];
  const copied: string[] = [];
  const runs: { transformId?: string; text: string }[] = [];
  const cancelled: string[] = [];
  const logs: unknown[] = [];
  let hidden = 0;
  let allowed = 0;
  let consented = opts.consented ?? true;
  const selection: { value: Selection } = {
    value: {
      ok: true,
      pid: 7,
      isSecure: false,
      text: "teh selected text",
      rangeLocation: 10,
      rangeLength: 17,
      editable: true,
      elementKey: "AXTextArea|||Doc",
    },
  };
  const front = {
    value: { pid: 7, bundleId: "com.apple.TextEdit", name: "TextEdit" } as {
      pid: number;
      bundleId?: string;
      name?: string;
    } | null,
  };
  const outcome: { value: InsertOutcome } = {
    value: { strategy: "clipboard-paste" },
  };
  const reads: number[] = [];
  const copyCalls: number[] = [];
  const copyResult: {
    value: { ok: boolean; text?: string; reason?: string };
  } = { value: { ok: false, reason: "nothing-copied" } };
  let n = 0;
  const s = new TransformSessions({
    ownPid: 1,
    accessibilityGranted: () => true,
    secureInput: () => false,
    readSelection: () => {
      reads.push(1);
      return selection.value;
    },
    copySelection: async (pid) => {
      copyCalls.push(pid);
      return copyResult.value;
    },
    frontmost: () => front.value,
    clipboardRead: async () => "copied text",
    copy: async (t) => (copied.push(t), true),
    paste: async (text, target) => {
      pasted.push({ text, target });
      // The app now reports the cursor right after the pasted text.
      if (outcome.value.strategy === "clipboard-paste")
        selection.value = {
          ok: true,
          pid: 7,
          isSecure: false,
          text: "",
          rangeLocation: 10 + text.length,
          rangeLength: 0,
          editable: true,
          elementKey: "AXTextArea|||Doc",
        };
      return outcome.value;
    },
    transforms: {
      get: ({ id }) => (id === "polish" ? { id, name: "Polish" } : null),
      aiStatus: async () => ({
        ready: opts.ready ?? null,
        service: "Groq",
        provider: "groq",
        consented,
        summaryConsented: false,
      }),
      run: async (input) => {
        const r = input as { transformId?: string; text: string };
        runs.push(r);
        return {
          text: await (opts.reply ?? (async () => "The selected text."))(),
          name: "Polish",
        };
      },
      cancel: (id) => (cancelled.push(id), true),
    },
    allowAi: () => {
      allowed++;
      consented = true;
    },
    panel: { show: (st) => shown.push(st), hide: () => hidden++ },
    noteWindow: { focused: () => false, transform: () => {} },
    openAiSettings: () => {},
    openAccessibility: () => {},
    newId: () => `r${++n}`,
    sleep: async () => {},
    log: (e, d) => logs.push([e, d]),
    ...over,
  });
  return {
    s,
    shown,
    pasted,
    copied,
    runs,
    cancelled,
    logs,
    selection,
    front,
    outcome,
    reads,
    copyCalls,
    copyResult,
    last: () => shown.at(-1)!,
    hidden: () => hidden,
    allowed: () => allowed,
  };
}

test("session: transforms the selection and shows Before/After; nothing is pasted before Replace", async () => {
  const t = sessions();
  await t.s.start("polish");
  assert.deepEqual(t.runs, [
    { requestId: "r2", transformId: "polish", text: "teh selected text" },
  ]);
  const review = t.last();
  assert.equal(review.kind, "review");
  assert.deepEqual(
    review.kind === "review" && [
      review.before,
      review.after,
      review.canReplace,
      review.appName,
    ],
    ["teh selected text", "The selected text.", true, "TextEdit"],
  );
  assert.equal(t.pasted.length, 0);
});

test("session: when the app doesn't share its selection, the selection is copied and only Copy is offered", async () => {
  const t = sessions();
  t.selection.value = { ok: false, error: "no-value", isSecure: false };
  t.front.value = {
    pid: 7,
    bundleId: "ru.keepcoder.Telegram",
    name: "Telegram",
  };
  t.copyResult.value = { ok: true, text: "copied from telegram" };
  await t.s.start("polish");
  assert.deepEqual(t.copyCalls, [7]);
  assert.equal(t.runs[0].text, "copied from telegram");
  const review = t.last();
  assert.equal(review.kind === "review" && review.canReplace, false);
  assert.ok(
    t.logs.some(
      (l) =>
        (l as [string, { source?: string }])[0] === "transform.selection" &&
        (l as [string, { source?: string }])[1].source === "copy",
    ),
  );
  assert.ok(!JSON.stringify(t.logs).includes("copied from telegram"));
  await t.s.act("replace");
  assert.equal(t.pasted.length, 0);
});

test("session: a selection from another process or an empty one also falls back to copy", async () => {
  const other = sessions();
  other.selection.value = { ...other.selection.value, pid: 99 };
  other.copyResult.value = { ok: true, text: "x y" };
  await other.s.start("polish");
  assert.deepEqual(other.copyCalls, [7]);
  const empty = sessions();
  empty.selection.value = { ...empty.selection.value, text: "" };
  await empty.s.start("polish");
  assert.deepEqual(empty.copyCalls, [7]);
  const m = empty.last();
  assert.equal(m.kind === "notice" && /Select the text/.test(m.message), true);
});

test("session: nothing copied shows the notice with Use copied text", async () => {
  const t = sessions();
  t.selection.value = { ok: false, isSecure: false };
  t.front.value = {
    pid: 7,
    bundleId: "ru.keepcoder.Telegram",
    name: "Telegram",
  };
  await t.s.start("polish");
  const m = t.last();
  assert.equal(m.kind, "notice");
  assert.ok(
    m.kind === "notice" &&
      m.clipboard === true &&
      m.message.startsWith("Couldn't copy your selection from Telegram."),
  );
  assert.equal(t.runs.length, 0);
});

test("session: no copy attempt in a password manager, with Secure Input, or when Murmur is in front", async () => {
  const pm = sessions();
  pm.selection.value = { ok: false, isSecure: false };
  pm.front.value = {
    pid: 7,
    bundleId: "com.1password.1password",
    name: "1Password",
  };
  await pm.s.start("polish");
  assert.equal(pm.copyCalls.length, 0);
  assert.equal(pm.last().kind, "notice");

  const secure = sessions({ secureInput: () => true });
  await secure.s.start("polish");
  assert.equal(secure.copyCalls.length, 0);

  const own = sessions();
  own.front.value = { pid: 1, bundleId: "app.murmur", name: "Murmur" };
  await own.s.start("polish");
  assert.equal(own.copyCalls.length, 0);

  const noAx = sessions({ accessibilityGranted: () => false });
  await noAx.s.start("polish");
  assert.equal(noAx.copyCalls.length, 0);
});

test("session: the native password refusal becomes a password notice; the copy is not used", async () => {
  const t = sessions();
  t.selection.value = { ok: false, isSecure: false };
  t.copyResult.value = { ok: false, reason: "secure-text-field" };
  await t.s.start("polish");
  const m = t.last();
  assert.ok(m.kind === "notice" && /password field/.test(m.message));
  assert.equal(t.runs.length, 0);
});

test("session: Replace checks app, field and selection, pastes exactly once, and confirms by the cursor", async () => {
  const t = sessions();
  await t.s.start("polish");
  await t.s.act("replace");
  await t.s.act("replace");
  assert.equal(t.pasted.length, 1, "exactly once");
  assert.equal(t.pasted[0].text, "The selected text.");
  assert.equal(t.pasted[0].target.pid, 7);
  assert.equal(t.pasted[0].target.appBundleId, "com.apple.TextEdit");
  const done = t.last();
  assert.deepEqual(done.kind === "done" && [done.title, done.tone], [
    "Replaced",
    "success",
  ]);
});

test("session: without a reported cursor, Replace says it pasted but couldn't confirm", async () => {
  // An app that reports the selected text but no range: the paste empties the selection.
  const t = sessions({
    paste: async () => {
      t.selection.value = {
        ok: true,
        pid: 7,
        isSecure: false,
        text: "",
        editable: true,
      };
      return { strategy: "clipboard-paste" };
    },
  });
  t.selection.value = {
    ok: true,
    pid: 7,
    isSecure: false,
    text: "teh selected text",
    editable: true,
  };
  await t.s.start("polish");
  await t.s.act("replace");
  const done = t.last();
  assert.deepEqual(done.kind === "done" && [done.title, done.tone], [
    "Pasted",
    "info",
  ]);
});

test("session: app switched, selection changed, range moved or now a password field → nothing replaced, Copy offered", async () => {
  const cases: [string, (t: ReturnType<typeof sessions>) => void, RegExp][] = [
    [
      "app switched",
      (t) => (t.front.value = { pid: 9, name: "Mail" }),
      /isn't in front any more/,
    ],
    [
      "text changed",
      (t) =>
        (t.selection.value = { ...t.selection.value, text: "something else" }),
      /selection changed/,
    ],
    [
      "range moved",
      (t) => (t.selection.value = { ...t.selection.value, rangeLocation: 3 }),
      /selection changed/,
    ],
    [
      "password field",
      (t) => (t.selection.value = { ok: true, pid: 7, isSecure: true }),
      /password field/,
    ],
    [
      "focus lost",
      (t) =>
        (t.selection.value = {
          ok: false,
          error: "no-focused-element",
          isSecure: false,
        }),
      /selection changed/,
    ],
  ];
  for (const [name, change, re] of cases) {
    const t = sessions();
    await t.s.start("polish");
    change(t);
    await t.s.act("replace");
    assert.equal(t.pasted.length, 0, name);
    const st = t.last();
    assert.equal(st.kind, "review", name);
    assert.ok(
      st.kind === "review" && !st.canReplace && re.test(st.notice ?? ""),
      name,
    );
    await t.s.act("copy");
    assert.deepEqual(t.copied, ["The selected text."], name);
  }
});

test("session: the paste chain's own refusals are reported honestly", async () => {
  const copiedOnly = sessions();
  copiedOnly.outcome.value = {
    strategy: "clipboard-only",
    reason: "no-post-event-permission",
  };
  await copiedOnly.s.start("polish");
  await copiedOnly.s.act("replace");
  const a = copiedOnly.last();
  assert.deepEqual(a.kind === "done" && a.title, "Copied instead");
  const rejected = sessions();
  rejected.outcome.value = { strategy: "rejected", reason: "secure-field" };
  await rejected.s.start("polish");
  await rejected.s.act("replace");
  const b = rejected.last();
  assert.ok(b.kind === "review" && /password field/.test(b.notice ?? ""));
});

test("session: password fields, empty selections, apps without a selection, no Accessibility, too long", async () => {
  const secure = sessions();
  secure.selection.value = { ok: true, pid: 7, isSecure: true };
  await secure.s.start("polish");
  assert.ok(
    secure.last().kind === "notice" &&
      /password field/.test((secure.last() as { message: string }).message),
  );
  assert.equal(secure.runs.length, 0);

  const empty = sessions();
  empty.selection.value = { ok: true, pid: 7, isSecure: false, text: "  " };
  await empty.s.start("polish");
  assert.match(
    (empty.last() as { message: string }).message,
    /Select the text/,
  );

  const opaque = sessions();
  opaque.selection.value = {
    ok: false,
    error: "ax-error:-25204",
    isSecure: false,
  };
  await opaque.s.start("polish");
  const o = opaque.last();
  assert.ok(
    o.kind === "notice" &&
      o.clipboard &&
      /Couldn't copy your selection from TextEdit/.test(o.message),
  );

  const noAx = sessions({ accessibilityGranted: () => false });
  await noAx.s.start("polish");
  const x = noAx.last();
  assert.ok(x.kind === "notice" && x.fix === "accessibility" && x.clipboard);
  assert.equal(noAx.reads.length, 0, "the selection isn't even read");

  const long = sessions();
  long.selection.value = {
    ok: true,
    pid: 7,
    isSecure: false,
    text: "x".repeat(TRANSFORM_TEXT_MAX + 1),
  };
  await long.s.start("polish");
  assert.match((long.last() as { message: string }).message, /too long/);
  assert.equal(long.runs.length, 0);
});

test("session: the manual path reads the clipboard once, on request, and offers Copy (no Replace)", async () => {
  const t = sessions({ accessibilityGranted: () => false });
  await t.s.start("polish");
  await t.s.act("useClipboard");
  assert.deepEqual(
    t.runs.map((r) => r.text),
    ["copied text"],
  );
  const r = t.last();
  assert.ok(r.kind === "review" && !r.canReplace);
});

test("session: consent first; Allow records it and then sends", async () => {
  const t = sessions({}, { consented: false });
  await t.s.start("polish");
  const c = t.last();
  assert.deepEqual(c.kind === "consent" && [c.service, c.chars], ["Groq", 17]);
  assert.equal(t.runs.length, 0, "nothing sent before Allow");
  await t.s.act("allow");
  assert.equal(t.allowed(), 1);
  assert.equal(t.runs.length, 1);
});

test("session: AI not set up → explained, nothing sent", async () => {
  const t = sessions({}, { ready: "No API key" });
  await t.s.start("polish");
  const n = t.last();
  assert.ok(
    n.kind === "notice" && n.fix === "ai" && /Nothing was sent/.test(n.message),
  );
  assert.equal(t.runs.length, 0);
});

test("session: failure → error with Retry; Retry sends again", async () => {
  let fail = true;
  const t = sessions(
    {},
    {
      reply: async () => {
        if (fail)
          throw new Error("Groq couldn't do this (HTTP 503). Try again.");
        return "ok";
      },
    },
  );
  await t.s.start("polish");
  const e = t.last();
  assert.ok(e.kind === "error" && e.canRetry && /HTTP 503/.test(e.message));
  fail = false;
  await t.s.act("retry");
  assert.equal(t.last().kind, "review");
  assert.equal(t.runs.length, 2);
});

test("session: Cancel while working aborts, hides the panel, and a late result is ignored", async () => {
  let release!: (v: string) => void;
  const t = sessions(
    {},
    { reply: () => new Promise<string>((r) => (release = r)) },
  );
  const started = t.s.start("polish");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(t.last().kind, "working");
  await t.s.act("close");
  assert.equal(t.cancelled.length, 1);
  assert.equal(t.hidden(), 1);
  release("late");
  await started;
  assert.notEqual(t.last().kind, "review");
});

test("session: a second shortcut press while one is running starts nothing", async () => {
  let release!: (v: string) => void;
  const t = sessions(
    {},
    { reply: () => new Promise<string>((r) => (release = r)) },
  );
  const first = t.s.start("polish");
  await new Promise((r) => setTimeout(r, 0));
  await t.s.start("polish");
  assert.equal(t.runs.length, 1);
  release("done");
  await first;
});

test("session: in Scratchpad the note window handles it; in Murmur's own windows nothing is read", async () => {
  const handled: string[] = [];
  const note = sessions({
    noteWindow: { focused: () => true, transform: (id) => handled.push(id) },
  });
  note.front.value = { pid: 1, name: "Murmur" };
  await note.s.start("polish");
  assert.deepEqual(handled, ["polish"]);
  assert.equal(note.reads.length, 0);
  const hub = sessions();
  hub.front.value = { pid: 1, name: "Murmur" };
  await hub.s.start("polish");
  assert.equal(hub.last().kind, "notice");
  assert.equal(hub.reads.length, 0);
});

test("session: text from History can be transformed and copied, never replaced; view changes shows the last result", async () => {
  const t = sessions();
  await t.s.startWithText("polish", "dictated words");
  const r = t.last();
  assert.ok(
    r.kind === "review" && !r.canReplace && r.before === "dictated words",
  );
  await t.s.act("close");
  t.s.viewChanges();
  const v = t.last();
  assert.ok(v.kind === "review" && v.past && v.after === "The selected text.");
  let now = 0;
  const old = sessions({ now: () => now });
  await old.s.startWithText("polish", "x");
  now = 11 * 60_000;
  old.s.viewChanges();
  assert.equal(old.last().kind, "notice");
});

test("session: logs carry outcomes only, never selected text", async () => {
  const t = sessions();
  await t.s.start("polish");
  await t.s.act("replace");
  assert.doesNotMatch(JSON.stringify(t.logs), /selected/);
});

test("session: no Replace for read-only text or terminals — Copy only, with the reason", async () => {
  const readOnly = sessions();
  readOnly.selection.value = { ...readOnly.selection.value, editable: false };
  await readOnly.s.start("polish");
  const r = readOnly.last();
  assert.ok(
    r.kind === "review" &&
      !r.canReplace &&
      /doesn't let Murmur change/.test(r.notice ?? ""),
  );
  await readOnly.s.act("replace");
  assert.equal(readOnly.pasted.length, 0);

  const terminal = sessions();
  terminal.front.value = {
    pid: 7,
    bundleId: "com.apple.Terminal",
    name: "Terminal",
  };
  await terminal.s.start("polish");
  const t = terminal.last();
  assert.ok(t.kind === "review" && !t.canReplace);
  await terminal.s.act("replace");
  assert.equal(terminal.pasted.length, 0, "never pasted at a shell prompt");
});

test("session: a different field with the same text, or a range the app stopped reporting, is not replaced", async () => {
  const other = sessions();
  await other.s.start("polish");
  other.selection.value = {
    ...other.selection.value,
    elementKey: "AXTextField|||Other window",
  };
  await other.s.act("replace");
  assert.equal(other.pasted.length, 0);
  const noRange = sessions();
  await noRange.s.start("polish");
  noRange.selection.value = {
    ...noRange.selection.value,
    rangeLocation: undefined,
    rangeLength: undefined,
  };
  await noRange.s.act("replace");
  assert.equal(noRange.pasted.length, 0);
});

test("session: Secure Input on → nothing is read", async () => {
  const t = sessions({ secureInput: () => true });
  await t.s.start("polish");
  assert.match((t.last() as { message: string }).message, /Secure Input is on/);
  assert.equal(t.reads.length, 0);
  assert.equal(t.runs.length, 0);
});

test("session: if the paste changed nothing, it says so", async () => {
  const t = sessions({
    paste: async () => ({ strategy: "clipboard-paste" }),
  });
  await t.s.start("polish");
  await t.s.act("replace");
  const d = t.last();
  assert.deepEqual(d.kind === "done" && d.title, "Nothing changed");
});

test("session: consent is recorded for the service the panel named; a switched service is asked about again", async () => {
  let provider = "groq";
  let consented = false;
  let allowedFor: string[] = [];
  const t = sessions({
    transforms: {
      get: ({ id }) => (id === "polish" ? { id, name: "Polish" } : null),
      aiStatus: async () => ({
        ready: null,
        service: provider === "groq" ? "Groq" : "OpenAI",
        provider,
        consented,
        summaryConsented: false,
      }),
      run: async () => ({ text: "ok", name: "Polish" }),
      cancel: () => true,
    },
    allowAi: () => {
      allowedFor.push(provider);
      consented = true;
    },
  });
  await t.s.start("polish");
  provider = "openai";
  await t.s.act("allow");
  const c = t.last();
  assert.ok(
    c.kind === "consent" && c.service === "OpenAI",
    "asked again, naming OpenAI",
  );
  assert.deepEqual(allowedFor, []);
  await t.s.act("allow");
  assert.deepEqual(allowedFor, ["openai"]);
  assert.equal(t.last().kind, "review");
});

test("session: closed while checking the AI service → nothing is sent and the panel stays closed", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let sent = 0;
  const t = sessions({
    transforms: {
      get: ({ id }) => ({ id, name: "Polish" }),
      aiStatus: async () => {
        await gate;
        return {
          ready: null,
          service: "Groq",
          provider: "groq",
          consented: true,
          summaryConsented: false,
        };
      },
      run: async () => {
        sent++;
        return { text: "x", name: "Polish" };
      },
      cancel: () => true,
    },
  });
  const started = t.s.start("polish");
  await new Promise((r) => setTimeout(r, 0));
  t.s.close();
  release();
  await started;
  assert.equal(sent, 0);
  assert.equal(
    t.shown.length,
    0,
    "the panel never showed the request as working",
  );
});

test("session: an error while replacing is reported in the panel", async () => {
  const t = sessions({
    paste: async () => {
      throw new Error("native failure");
    },
  });
  await t.s.start("polish");
  await t.s.act("replace");
  const d = t.last();
  assert.deepEqual(d.kind === "done" && [d.title, d.tone], [
    "Something went wrong",
    "error",
  ]);
});

test("session: forget() drops the last result (opting out, quitting, after 10 minutes)", async () => {
  const t = sessions();
  await t.s.startWithText("polish", "x");
  t.s.forget();
  t.s.viewChanges();
  assert.equal(t.last().kind, "notice");
});

test("service run: a cancel before the AI service answered its readiness check sends nothing", async () => {
  let readyRelease!: () => void;
  const gate = new Promise<void>((r) => (readyRelease = r));
  const ai = fakeAi();
  const slowReady = {
    ...ai,
    readiness: async () => {
      await gate;
      return null;
    },
  };
  const { svc } = service({}, slowReady as typeof ai);
  const run = svc.run({ requestId: "req", transformId: "polish", text: "x" });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(svc.cancel("req"), true);
  readyRelease();
  await assert.rejects(run, (e) => e instanceof AiCancelled);
  assert.equal(ai.calls.length, 0);
});

test("migration v5: built-ins still on ⌥1/⌥2 move to ⌃⌥1/⌃⌥2; a shortcut you chose is kept", () => {
  const path = join(mkdtempSync(join(tmpdir(), "murmur-v4-")), "db.sqlite");
  const v4 = new DatabaseSync(path);
  v4.exec(
    "CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (4);",
  );
  for (const m of MIGRATIONS.slice(0, 4)) v4.exec(m);
  v4.exec(
    "UPDATE transforms SET shortcut = 'opt+1' WHERE id = 'polish'; UPDATE transforms SET shortcut = 'ctrl+cmd+p' WHERE id = 'prompt-engineer';",
  );
  v4.close();
  const r = new TransformRepo(openDatabase(path));
  assert.equal(r.get("polish")!.shortcut, "ctrl+opt+1");
  assert.equal(r.get("prompt-engineer")!.shortcut, "ctrl+cmd+p");
});

test("hotkeys: Option-only combinations are refused (they need Input Monitoring), with the native verdict", () => {
  const { native } = fakeNative();
  (native as unknown as { validateShortcut: unknown }).validateShortcut = (
    combo: string,
  ) => ({
    normalized: combo,
    errors: [],
    warnings: /^opt\+/.test(combo) ? ["requires-input-monitoring"] : [],
    backend: /^opt\+/.test(combo) ? "eventTap" : "carbon",
  });
  const h = new CarbonHotkeys(native, () => {});
  const st = h.bindTransforms([
    { id: "a", combo: "opt+1" },
    { id: "b", combo: "ctrl+opt+1" },
  ]);
  assert.equal(st.get("a")!.registered, false);
  assert.match(st.get("a")!.error!, /needs-input-monitoring/);
  assert.equal(st.get("b")!.registered, true);
});

// ---- Stage 9D-2: meeting summaries through the same AI path ----------------------------------------

test("summarize: needs the service ready and consent before anything is sent", async () => {
  const notReady = service({}, fakeAi({ ready: "Add an API key" }));
  await assert.rejects(
    notReady.svc.summarize("r1", "Transcript: hello"),
    /Set up Groq in Settings → AI cleanup.*Nothing was sent/,
  );
  assert.equal(notReady.ai.calls.length, 0);
  const s = service();
  s.setSummaryConsent(false);
  await assert.rejects(
    s.svc.summarize("r1", "Transcript: hello"),
    /Allow sending meeting transcripts and notes to Groq first\. Nothing was sent/,
  );
  assert.equal(s.ai.calls.length, 0);
  assert.equal((await s.svc.aiStatus()).summaryConsented, false);
  await assert.rejects(
    s.svc.summarize("r1", "x".repeat(400_001)),
    /too long.*Nothing was sent/,
  );
  assert.equal(s.ai.calls.length, 0);
});

test("summarize: sends the meeting with instructions that forbid invented content; logs sizes only", async () => {
  const s = service(
    {},
    fakeAi({ reply: async () => "## Summary\nShip Friday." }),
  );
  const out = await s.svc.summarize("r1", "Transcript:\nWe ship Friday.");
  assert.equal(out, "## Summary\nShip Friday.");
  assert.equal(s.ai.calls[0].user, "Transcript:\nWe ship Friday.");
  assert.match(
    s.ai.calls[0].system,
    /invent no names, dates, numbers or decisions/,
  );
  assert.match(s.ai.calls[0].system, /## Action items/);
  assert.ok(!JSON.stringify(s.logs).includes("Friday"));
});

test("summarize: cancelling stops the request and says so", async () => {
  const s = service(
    {},
    fakeAi({
      reply: (_s, _u, signal) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        ),
    }),
  );
  const running = s.svc.summarize("r1", "Transcript: hi");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(s.svc.cancel("r1"), true);
  await assert.rejects(running, /Cancelled/);
});

// ---- Stage E: Command Mode in the Transform panel -------------------------------------------------

test("command mode: the selection read at the press gets the spoken instruction; Replace is offered", async () => {
  const t = sessions();
  const captured = t.s.captureSelection();
  assert.equal(captured?.text, "teh selected text");
  await t.s.startCommand("make it formal", captured);
  assert.deepEqual(t.runs.at(-1), {
    requestId: "r2",
    instruction: "make it formal",
    text: "teh selected text",
  });
  const review = t.last();
  assert.equal(review.kind, "review");
  assert.equal(review.kind === "review" && review.name, "“make it formal”");
  assert.equal(review.kind === "review" && review.canReplace, true);
});

test("command mode: nothing selected answers the spoken request itself, copy only", async () => {
  const t = sessions();
  t.selection.value = { ...t.selection.value, text: "" };
  const captured = t.s.captureSelection();
  assert.equal(captured, null);
  await t.s.startCommand("what is the capital of Uzbekistan", captured);
  const run = t.runs.at(-1) as { instruction?: string; text: string };
  assert.equal(run.text, "what is the capital of Uzbekistan");
  assert.match(run.instruction ?? "", /spoken request.*answer/i);
  const review = t.last();
  assert.equal(review.kind === "review" && review.name, "Ask Murmur");
  assert.equal(review.kind === "review" && review.canReplace, false);
});

test("command mode: never reads a password field, Secure Input, or Murmur's own windows", () => {
  const secure = sessions();
  secure.selection.value = { ...secure.selection.value, isSecure: true };
  assert.equal(secure.s.captureSelection(), null);
  const input = sessions({ secureInput: () => true });
  assert.equal(input.s.captureSelection(), null);
  assert.equal(input.reads.length, 0, "nothing read while Secure Input is on");
  const own = sessions();
  own.front.value = { pid: 1, name: "Murmur" };
  assert.equal(own.s.captureSelection(), null);
  const noAx = sessions({ accessibilityGranted: () => false });
  assert.equal(noAx.s.captureSelection(), null);
});

test("summarize: the Scratchpad/Transforms consent does not cover meeting summaries", async () => {
  const s = service();
  s.setConsent(true);
  s.setSummaryConsent(false);
  await assert.rejects(
    s.svc.summarize("r1", "Transcript: hi"),
    /Nothing was sent/,
  );
  assert.equal(s.ai.calls.length, 0);
  // And the other way round: summary consent does not allow Transforms.
  s.setConsent(false);
  s.setSummaryConsent(true);
  await assert.rejects(
    s.svc.run({ requestId: "r", transformId: "polish", text: "x" }),
    /Nothing was sent/,
  );
  assert.equal(s.ai.calls.length, 0);
});

test("session: a multi-line result is Copy-only in code editors and terminals, Replace elsewhere", async () => {
  const multi = async () => "line one\nline two";
  for (const bundleId of [
    "com.microsoft.VSCode",
    "com.todesktop.230313mzl4w4u92",
    "com.jetbrains.intellij",
    "dev.zed.Zed",
    "com.apple.dt.Xcode",
  ]) {
    const t = sessions({}, { reply: multi });
    t.front.value = { pid: 7, bundleId, name: "Editor" };
    await t.s.start("polish");
    const r = t.last();
    assert.ok(r.kind === "review" && !r.canReplace, bundleId);
    assert.match(r.kind === "review" ? (r.notice ?? "") : "", /several lines/);
    await t.s.act("replace");
    assert.equal(t.pasted.length, 0, `${bundleId}: nothing pasted`);
  }
  // One line in an editor, and several lines in an ordinary app, can still be replaced.
  const oneLine = sessions({}, { reply: async () => "single line" });
  oneLine.front.value = {
    pid: 7,
    bundleId: "com.microsoft.VSCode",
    name: "Code",
  };
  await oneLine.s.start("polish");
  assert.equal(
    oneLine.last().kind === "review" &&
      (oneLine.last() as { canReplace: boolean }).canReplace,
    true,
  );
  const notes = sessions({}, { reply: multi });
  await notes.s.start("polish");
  assert.equal((notes.last() as { canReplace: boolean }).canReplace, true);
});
