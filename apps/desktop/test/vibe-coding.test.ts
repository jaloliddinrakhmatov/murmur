// Vibe coding: settings, editor title and workspace parsing, the service, and the controller
// wiring (only in code editors, only when on, never for a secure target or Command Mode).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DictationController } from "../src/main/core/controller.ts";
import {
  DEFAULT_SETTINGS,
  applyPatch,
  parseSettingsPatch,
} from "../src/shared/settings.ts";
import { isVibeEditor } from "../src/shared/vibe-apps.ts";
import { VibeCoding } from "../src/main/vibe/service.ts";
import {
  WorkspaceFiles,
  folderPathsFromStorage,
  listFileNames,
  parseEditorTitle,
  type WorkspaceFs,
} from "../src/main/vibe/workspace.ts";
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

const CURSOR = "com.todesktop.230313mzl4w4u92";

test("settings: both off by default; a patch changes one and keeps the rest", () => {
  assert.deepEqual(DEFAULT_SETTINGS.vibeCoding, {
    fileTagging: false,
    variables: false,
  });
  const s = applyPatch(
    DEFAULT_SETTINGS,
    parseSettingsPatch({ vibeCoding: { variables: true } }),
  );
  assert.deepEqual(s.vibeCoding, { fileTagging: false, variables: true });
  assert.equal(s.context.awareness, false);
  assert.throws(() =>
    parseSettingsPatch({ vibeCoding: { fileTagging: "yes" } }),
  );
});

test("editors: VS Code, Cursor and Windsurf only", () => {
  for (const id of ["com.microsoft.VSCode", CURSOR, "com.exafunction.windsurf"])
    assert.ok(isVibeEditor(id), id);
  for (const id of [
    "com.apple.Terminal",
    "com.apple.TextEdit",
    "com.microsoft.VSCodeX",
    null,
    "",
  ])
    assert.ok(!isVibeEditor(id), String(id));
});

test("window titles: the open file and the folder name", () => {
  assert.deepEqual(parseEditorTitle("index.tsx — project — Cursor"), {
    file: "index.tsx",
    parts: ["index.tsx", "project"],
  });
  assert.deepEqual(parseEditorTitle("● app.ts - my-app - Visual Studio Code"), {
    file: "app.ts",
    parts: ["app.ts", "my-app"],
  });
  assert.deepEqual(parseEditorTitle("project — Windsurf"), {
    file: null,
    parts: ["project"],
  });
  assert.equal(parseEditorTitle("Untitled-1 — x").file, null);
  assert.equal(parseEditorTitle("notes.xyz — x").file, null);
  assert.deepEqual(parseEditorTitle(null), { file: null, parts: [] });
});

test("recent folders: file URIs only, from the places the editor keeps them", () => {
  const paths = folderPathsFromStorage({
    windowsState: {
      lastActiveWindow: { folder: "file:///Users/a/last" },
      openedWindows: [{ folder: "file:///Users/a/other" }, {}],
    },
    backupWorkspaces: {
      folders: [
        { folderUri: "vscode-remote://ssh/x" },
        { folderUri: "file:///Users/a/my%20app" },
      ],
    },
    profileAssociations: { workspaces: { "file:///Users/a/last": "p" } },
  });
  assert.deepEqual(paths, [
    "/Users/a/last",
    "/Users/a/other",
    "/Users/a/my app",
  ]);
  assert.deepEqual(folderPathsFromStorage(null), []);
  assert.deepEqual(folderPathsFromStorage({ windowsState: 5 }), []);
});

function tree(files: Record<string, any>): WorkspaceFs & {
  listed: string[];
} {
  const listed: string[] = [];
  const at = (path: string) => {
    let node: any = files;
    for (const p of path.split("/").filter(Boolean)) node = node?.[p];
    return node;
  };
  return {
    listed,
    readStorage: async () => ({
      windowsState: { lastActiveWindow: { folder: "file:///w/project" } },
    }),
    isDirectory: async (p) => p === "/w/project",
    list: async (p) => {
      listed.push(p);
      const node = at(p.replace(/^\/w\/project/, ""));
      if (!node || node === true) throw new Error("ENOENT");
      return Object.entries(node).map(([name, v]) => ({
        name,
        dir: v !== true,
      }));
    },
  };
}

const PROJECT = {
  "index.tsx": true,
  "README.md": true,
  "notes.bin": true,
  ".env": true,
  src: { "app.ts": true, hooks: { "useAuth.ts": true } },
  node_modules: { pkg: { "x.js": true } },
  ".git": { "y.js": true },
  dist: { "z.js": true },
};

test("file names: bounded, names only, ignoring node_modules, .git and other noise", async () => {
  const fs = tree(PROJECT);
  const names = await listFileNames("/w/project", fs);
  assert.deepEqual(names.sort(), [
    "README.md",
    "index.tsx",
    "src/app.ts",
    "src/hooks/useAuth.ts",
  ]);
  assert.ok(!fs.listed.some((p) => /node_modules|\.git|dist/.test(p)));
  assert.equal((await listFileNames("/w/project", fs, 2)).length, 2);
  // Deeper than six levels is not listed.
  const deep: any = { "deep.ts": true };
  let nest: any = deep;
  for (let i = 0; i < 8; i++) nest = nest["d"] = { "f.ts": true };
  const names2 = await listFileNames("/w/project", tree({ d: deep }));
  assert.ok(names2.every((n) => n.split("/").length <= 8));
  assert.ok(!names2.some((n) => n.split("/").length > 7));
});

test("workspace files: found through the window title, cached for a minute", async () => {
  const fs = tree(PROJECT);
  let now = 0;
  const w = new WorkspaceFiles({
    windowTitle: () => "index.tsx — project — Cursor",
    fs,
    now: () => now,
  });
  w.begin(CURSOR);
  const first = await w.names();
  assert.ok(first.includes("src/app.ts") && first.includes("index.tsx"));
  const reads = fs.listed.length;
  now = 30_000;
  w.begin(CURSOR);
  await w.names();
  assert.equal(fs.listed.length, reads, "served from the cache");
  now = 90_000;
  w.begin(CURSOR);
  await w.names();
  assert.ok(fs.listed.length > reads, "refreshed lazily after a minute");
  // A folder name that isn't a known recent folder gives only the open file.
  const other = new WorkspaceFiles({
    windowTitle: () => "main.rs — unknown — Cursor",
    fs,
  });
  other.begin(CURSOR);
  assert.deepEqual(await other.names(), ["main.rs"]);
  // No title (older addon, no Accessibility): nothing.
  const none = new WorkspaceFiles({ windowTitle: () => null, fs });
  none.begin(CURSOR);
  assert.deepEqual(await none.names(), []);
  // An app that isn't an editor has no support folder.
  const term = new WorkspaceFiles({ windowTitle: () => "a.ts — project", fs });
  term.begin("com.apple.Terminal");
  assert.deepEqual(await term.names(), ["a.ts"]);
});

function service(
  opts: {
    fileTagging?: boolean;
    variables?: boolean;
    blocked?: boolean;
    text?: string;
    secure?: boolean;
  } = {},
) {
  const reads: number[] = [];
  const v = new VibeCoding({
    settings: () => ({
      fileTagging: opts.fileTagging ?? false,
      variables: opts.variables ?? false,
    }),
    readingBlocked: () => opts.blocked ?? false,
    readAround: (before, after) => {
      reads.push(before + after);
      return {
        ok: true,
        isSecure: opts.secure ?? false,
        text: opts.text ?? "const userName = getUserById(id);",
      };
    },
    windowTitle: () => "index.tsx — project — Cursor",
    fs: tree(PROJECT),
    log: () => {},
  });
  return { v, reads };
}

test("service: off by default, reads and changes nothing", async () => {
  const { v, reads } = service();
  assert.deepEqual(v.begin(CURSOR), []);
  assert.deepEqual(reads, []);
  assert.equal(
    await v.apply("set user name at index dot tsx", CURSOR),
    "set user name at index dot tsx",
  );
});

test("service: variables become hints and spoken names are mapped, in editors only", async () => {
  const { v, reads } = service({ variables: true });
  assert.deepEqual(v.begin(CURSOR), ["getUserById", "userName"]);
  assert.deepEqual(reads, [800], "a bounded read");
  assert.equal(
    await v.apply("call get user by id with user name", CURSOR),
    "call getUserById with userName",
  );
  v.end();
  assert.equal(await v.apply("user name", CURSOR), "user name", "nothing kept");
  const other = service({ variables: true });
  assert.deepEqual(other.v.begin("com.apple.TextEdit"), []);
  assert.deepEqual(other.reads, []);
  assert.equal(
    await other.v.apply("user name", "com.apple.TextEdit"),
    "user name",
  );
});

test("service: never reads when blocked or the field is secure", async () => {
  const blocked = service({
    variables: true,
    fileTagging: true,
    blocked: true,
  });
  assert.deepEqual(blocked.v.begin(CURSOR), []);
  assert.deepEqual(blocked.reads, []);
  assert.equal(
    await blocked.v.apply("at index dot tsx", CURSOR),
    "at index dot tsx",
  );
  const secure = service({ variables: true, secure: true });
  assert.deepEqual(secure.v.begin(CURSOR), []);
});

test("service: file tagging uses the real files", async () => {
  const { v } = service({ fileTagging: true });
  v.begin(CURSOR);
  assert.equal(
    await v.apply("look at use auth dot ts and the app dot ts file", CURSOR),
    "look @useAuth.ts and the @app.ts",
  );
});

function controller(opts: {
  bundleId?: string;
  secure?: boolean;
  vibe: ReturnType<typeof service>["v"];
  transcript: string;
}) {
  const clock = new FakeClock();
  const audio = new FakeAudio();
  const inserter = new FakeInserter();
  const history = new FakeHistory();
  const provider = new FakeProvider();
  const vocab: (string[] | undefined)[] = [];
  provider.transcribe = async (_a, o) => {
    vocab.push(o.vocabulary);
    return { text: opts.transcript };
  };
  const commands: string[] = [];
  const c = new DictationController(
    {
      hold: realHold(),
      audio,
      target: fakeTarget({
        appBundleId: opts.bundleId ?? CURSOR,
        secure: opts.secure ?? false,
      }),
      inserter,
      capsule: new FakeCapsule(),
      cancelHotkey: new FakeCancelHotkey(),
      history,
      vault: new FakeVault(),
      provider: () => provider,
      clock,
      newId: () => "d1",
      log: () => {},
      vibe: {
        begin: (b) => opts.vibe.begin(b),
        apply: (t, b) => opts.vibe.apply(t, b),
        end: () => opts.vibe.end(),
      },
      command: { capture: () => null, run: (t) => commands.push(t) },
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
  return { c, inserter, history, vocab, commands, hold };
}

const dictate = (t: ReturnType<typeof controller>) =>
  t.hold(
    () => t.c.hotkey("down"),
    () => t.c.hotkey("up"),
  );

test("controller: in an editor the hints and the rewritten text reach transcription and insertion", async () => {
  const { v } = service({ variables: true, fileTagging: true });
  const t = controller({
    vibe: v,
    transcript: "set user name from at index dot tsx",
  });
  await dictate(t);
  assert.ok(t.vocab[0]?.includes("getUserById"));
  const inserted = t.inserter.calls[0].text;
  assert.match(inserted, /userName from @index\.tsx/);
  assert.equal(t.history.only.finalText, inserted);
});

test("controller: another app is untouched", async () => {
  const { v, reads } = service({ variables: true, fileTagging: true });
  const t = controller({
    vibe: v,
    bundleId: "com.apple.TextEdit",
    transcript: "set user name from at index dot tsx",
  });
  await dictate(t);
  assert.deepEqual(reads, []);
  assert.ok(!t.vocab[0]?.includes("getUserById"));
  assert.match(t.inserter.calls[0].text, /user name from at index dot tsx/i);
});

test("controller: a secure target reads and rewrites nothing", async () => {
  const { v, reads } = service({ variables: true, fileTagging: true });
  const t = controller({
    vibe: v,
    secure: true,
    transcript: "set user name from at index dot tsx",
  });
  await dictate(t);
  assert.deepEqual(reads, []);
  assert.equal(t.inserter.calls.length, 0);
});

test("controller: Command Mode never reads code or rewrites the instruction", async () => {
  const { v, reads } = service({ variables: true, fileTagging: true });
  const t = controller({
    vibe: v,
    transcript: "rewrite user name at index dot tsx",
  });
  await t.hold(
    () => t.c.commandHotkey("down"),
    () => t.c.commandHotkey("up"),
  );
  assert.deepEqual(reads, []);
  assert.deepEqual(t.commands, ["rewrite user name at index dot tsx"]);
});
