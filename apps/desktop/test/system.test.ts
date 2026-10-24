// Stage 6A services: launch at login (macOS simulated through a port), reset (real settings
// file, SQLite, encrypted audio vault and secret store in a temporary folder) and the
// last-transcript actions (real History; inserter and target are fakes, nothing is pasted).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { writePrivateFile } from "../src/main/system/private-file.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  MeetingRepo,
  NoteRepo,
  DictionaryRepo,
  HistoryDb,
  SnippetRepo,
} from "../src/main/history/db.ts";
import { AudioVault } from "../src/main/history/vault.ts";
import {
  HubService,
  type HubServiceDeps,
  type LoginItemPort,
} from "../src/main/hub/service.ts";
import {
  SettingsStore,
  apiKeySecret,
  plainCodec,
} from "../src/main/settings/store.ts";
import { DEFAULT_SETTINGS } from "../src/shared/settings.ts";
import type { DictationRecord } from "../src/main/core/types.ts";
import { FakeInserter, fakeTarget } from "./helpers.ts";

let n = 0;

/** A login-item port that behaves like macOS might: accepts, refuses, or needs approval. */
function fakeLoginItems(mode: "packaged" | "dev" | "refuse" | "approval") {
  let status = "not-registered";
  const port: LoginItemPort = {
    read: () =>
      mode === "dev" ? null : { enabled: status === "enabled", status },
    write: (enabled) => {
      if (mode === "refuse") return;
      status = !enabled
        ? "not-registered"
        : mode === "approval"
          ? "requires-approval"
          : "enabled";
    },
  };
  return port;
}

function services(
  dir = mkdtempSync(join(tmpdir(), "murmur-6a-")),
  opts: {
    failMeetings?: boolean;
    recording?: boolean;
    failAccount?: boolean;
    mcpApps?: string[];
    switchPending?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const pending = { switch: opts.switchPending ?? false };
  const settings = new SettingsStore(dir, plainCodec);
  const history = new HistoryDb(join(dir, "murmur.sqlite"));
  const vault = new AudioVault(join(dir, "audio"), randomBytes(32));
  const copied: string[] = [];
  const inserter = { copy: (t: string) => copied.push(t) };
  const paste = new FakeInserter();
  let registered = "ctrl+opt+space";
  const cancels = { n: 0 };
  const notes = new NoteRepo(history.db);
  const notesDeleted = { n: 0 };
  const meetings = new MeetingRepo(history.db);
  const hub = new HubService({
    meetings: {
      recordingActive: () => opts.recording === true,
      deleteAll: () => {
        if (opts.failMeetings) throw new Error("disk full");
        return meetings.deleteAll();
      },
      all: () => meetings.list("", "oldest"),
    },
    notes: {
      deleteAll: () => {
        notesDeleted.n++;
        return notes.deleteAll();
      },
      all: () => notes.list(),
    },
    account: {
      signOut: async () => {
        calls.push("signOut");
        if (opts.failAccount) throw new Error("x");
      },
      switchPending: () => pending.switch,
      acceptOwner: () => {
        calls.push("acceptOwner");
        pending.switch = false;
      },
    },
    mcp: {
      resetAll: async () => {
        calls.push("mcp");
        return { apps: opts.mcpApps ?? [] };
      },
    },
    settings,
    history,
    vault,
    dictionary: new DictionaryRepo(history.db),
    snippets: new SnippetRepo(history.db),
    inserter,
    paste,
    target: fakeTarget(),
    hotkeys: {
      get current() {
        return { combo: registered, registered: true, error: null };
      },
      suspend() {},
      bindAction: () => null,
      replace(combo: string) {
        if (combo === "taken") return { ok: false, error: "x", status: {} };
        registered = combo;
        return { ok: true, status: {} };
      },
    },
    controller: { cancel: () => cancels.n++ },
    env: {},
    newId: () => `x${++n}`,
    system: { loginItem: fakeLoginItems("packaged") },
  } as unknown as HubServiceDeps);
  return {
    calls,
    pending,
    dir,
    settings,
    history,
    vault,
    hub,
    copied,
    paste,
    cancels,
    notes,
    notesDeleted,
    meetings,
  };
}

const row = (
  id: string,
  extra: Partial<DictationRecord> = {},
): DictationRecord => ({
  id,
  startedAt: Date.now(),
  durationMs: 4000,
  status: "inserted",
  strategy: "clipboard-paste",
  rawText: "um ship it",
  finalText: "Ship it.",
  wordCount: 2,
  appName: null,
  appBundleId: null,
  error: null,
  provider: "openai",
  hasAudio: false,
  ...extra,
});

test("launch at login (simulated macOS): reflects what macOS reports; refusals are errors", () => {
  const withPort = (mode: Parameters<typeof fakeLoginItems>[0]) =>
    new HubService({
      system: { loginItem: fakeLoginItems(mode) },
    } as unknown as HubServiceDeps);

  const ok = withPort("packaged");
  assert.deepEqual(ok.loginItem(), {
    supported: true,
    enabled: false,
    needsApproval: false,
  });
  assert.equal(ok.setLoginItem({ enabled: true }).enabled, true);
  assert.equal(ok.setLoginItem({ enabled: false }).enabled, false);

  const dev = withPort("dev");
  assert.equal(dev.loginItem().supported, false);
  assert.throws(
    () => dev.setLoginItem({ enabled: true }),
    /installed Murmur app/,
  );

  const refused = withPort("refuse");
  assert.throws(
    () => refused.setLoginItem({ enabled: true }),
    /didn't add Murmur/,
    "never reports success macOS didn't give",
  );
  assert.equal(refused.loginItem().enabled, false);

  const approval = withPort("approval");
  const r = approval.setLoginItem({ enabled: true });
  assert.deepEqual([r.enabled, r.needsApproval], [false, true]);
  assert.throws(() => approval.setLoginItem({ enabled: "yes" }));
});

test("reset: settings, History, recordings and keys go; the library stays unless asked; nothing else is touched", async () => {
  const s = services();
  s.settings.update({
    onboardingCompleted: true,
    shortcut: "ctrl+opt+k",
    appearance: "dark",
    system: { sounds: true, showInDock: true },
  });
  s.settings.setSecret(apiKeySecret("openai"), "test-key-1");
  s.settings.setSecret(apiKeySecret("anthropic"), "test-key-2");
  s.history.insert(
    row("a", { hasAudio: true, status: "failed", finalText: null }),
  );
  await s.vault.save("a", new Uint8Array([1, 2, 3]));
  s.hub.addDictionaryEntry({ phrase: "Murmur" });
  s.hub.addSnippet({ trigger: "my email", replacement: "you@example.com" });

  writeFileSync(join(s.dir, "notes.txt"), "keep me");
  const r = await s.hub.resetApp({ library: false });
  assert.deepEqual(r, {
    ok: true,
    failed: [],
    shortcutKept: false,
    staleMcpApps: [],
  });
  assert.deepEqual(s.calls, ["signOut", "mcp"]);
  assert.equal(s.cancels.n, 1, "a recording in progress is stopped first");
  assert.deepEqual(
    s.settings.get(),
    DEFAULT_SETTINGS,
    "defaults, onboarding again",
  );
  assert.equal(s.history.count(), 0);
  assert.equal(await s.vault.load("a"), null, "encrypted recording deleted");
  assert.equal(s.settings.hasSecret(apiKeySecret("openai")), false);
  assert.equal(s.settings.hasSecret(apiKeySecret("anthropic")), false);
  assert.equal(s.hub.listDictionary().length, 1, "library kept by default");
  assert.equal(s.hub.listSnippets().length, 1);
  assert.deepEqual(
    JSON.parse(readFileSync(join(s.dir, "settings.json"), "utf8")),
    DEFAULT_SETTINGS,
    "on disk too",
  );

  await s.hub.resetApp({ library: true });
  assert.equal(s.hub.listDictionary().length, 0);
  assert.equal(s.hub.listSnippets().length, 0);
  assert.equal(
    readFileSync(join(s.dir, "notes.txt"), "utf8"),
    "keep me",
    "files that aren't Murmur's data are left alone",
  );
  await assert.rejects(s.hub.resetApp({}), "invalid input is refused");
});

test("reset: a failing step is reported while the others still run; a taken default shortcut keeps the current one", async () => {
  const s = services();
  s.settings.update({ shortcut: "ctrl+opt+k" });
  s.history.insert(row("a", { hasAudio: true }));
  // The vault can't delete (e.g. a locked file): History fails, everything else completes.
  (s.vault as unknown as { remove: () => Promise<void> }).remove = async () => {
    throw new Error("locked");
  };
  (
    s.hub as unknown as { d: { hotkeys: { replace: unknown } } }
  ).d.hotkeys.replace = () => ({ ok: false, error: "taken", status: {} });
  s.settings.setSecret(apiKeySecret("groq"), "test-key");
  const r = await s.hub.resetApp({ library: false });
  assert.deepEqual(r.failed, ["history"]);
  assert.equal(r.ok, false);
  assert.equal(r.shortcutKept, true);
  assert.equal(
    s.settings.get().shortcut,
    "ctrl+opt+k",
    "never left without a shortcut",
  );
  assert.equal(s.settings.get().onboardingCompleted, false);
  assert.equal(s.settings.hasSecret(apiKeySecret("groq")), false);
});

test("last transcript: newest delivered text; original words; nothing when History has none", async () => {
  const s = services();
  assert.deepEqual(s.hub.lastTranscript(), {
    available: false,
    hasOriginal: false,
  });
  assert.equal(s.hub.copyLastTranscript("final"), false);
  assert.equal(await s.hub.pasteLastTranscript(), null);

  s.history.insert(
    row("old", { startedAt: Date.now() - 60_000, finalText: "Old." }),
  );
  s.history.insert(row("new"));
  // Newer, but not delivered: skipped.
  s.history.insert(
    row("failed", {
      startedAt: Date.now() + 1000,
      status: "failed",
      finalText: null,
    }),
  );
  assert.deepEqual(s.hub.lastTranscript(), {
    available: true,
    hasOriginal: true,
  });
  assert.equal(s.hub.copyLastTranscript("final"), true);
  assert.equal(s.hub.copyLastTranscript("raw"), true);
  assert.deepEqual(s.copied, ["Ship it.", "um ship it"]);

  // Paste goes through the dictation inserter with the app in front as its target.
  s.paste.outcome = {
    strategy: "clipboard-only",
    reason: "no-post-event-permission",
  };
  const outcome = await s.hub.pasteLastTranscript();
  assert.deepEqual(outcome, {
    strategy: "clipboard-only",
    reason: "no-post-event-permission",
  });
  assert.equal(s.paste.calls[0].text, "Ship it.");
  assert.equal(s.paste.calls[0].target.appName, "TextEdit");
});

test("security: clearing History also deletes recordings no row points to", async () => {
  const s = services();
  s.history.insert(
    row("kept", { hasAudio: true, status: "failed", finalText: null }),
  );
  await s.vault.save("kept", new Uint8Array([1]));
  await s.vault.save("orphan", new Uint8Array([2])); // e.g. a crash before its row was written
  await s.hub.clearHistory();
  assert.equal(await s.vault.load("kept"), null);
  assert.equal(await s.vault.load("orphan"), null);
  assert.equal(s.history.count(), 0);
});

test("reset: Scratchpad notes are deleted only when that box is ticked, independently of the library", async () => {
  const s = services();
  s.notes.create("n1", "Keep this note");
  s.hub.addDictionaryEntry({ phrase: "Murmur" });

  await s.hub.resetApp({ library: true });
  assert.equal(s.notes.list().length, 1, "library reset keeps notes");
  assert.equal(s.notesDeleted.n, 0);

  s.hub.addDictionaryEntry({ phrase: "Murmur" });
  const r = await s.hub.resetApp({ library: false, notes: true });
  assert.equal(r.ok, true);
  assert.equal(s.notes.list().length, 0, "notes deleted when asked");
  assert.equal(
    s.notesDeleted.n,
    1,
    "the note window is closed through this path",
  );
  assert.equal(
    s.hub.listDictionary().length,
    1,
    "the library is a separate choice",
  );
});

test("reset: Notetaker meetings are deleted only when that box is ticked", async () => {
  const s = services();
  s.meetings.create({ id: "m1", title: "Weekly sync", startedAt: 1 }, 1);
  s.notes.create("n1", "Keep this note");

  await s.hub.resetApp({ library: true, notes: true });
  assert.equal(s.meetings.count(), 1, "other choices keep meetings");

  const r = await s.hub.resetApp({ library: false, meetings: true });
  assert.equal(r.ok, true);
  assert.equal(s.meetings.count(), 0, "meetings deleted when asked");
});

test("reset: a failure deleting meetings is reported and the rest still runs", async () => {
  const s = services(undefined, { failMeetings: true });
  s.meetings.create({ id: "m1", title: "Weekly sync", startedAt: 1 }, 1);
  s.settings.update({ appearance: "dark" });
  const r = await s.hub.resetApp({ library: false, meetings: true });
  assert.equal(r.ok, false);
  assert.deepEqual(r.failed, ["meetings"]);
  assert.equal(s.settings.get().appearance, DEFAULT_SETTINGS.appearance);
  assert.equal(s.meetings.count(), 1);
});

test("export: Data and Privacy → Export includes every meeting with its notes", () => {
  const s = services();
  s.meetings.create(
    { id: "m1", title: "Weekly sync", startedAt: 2, notes: "Decisions" },
    1,
  );
  s.meetings.create({ id: "m0", title: "Kickoff", startedAt: 1 }, 1);
  const out = s.hub.exportData();
  assert.deepEqual(
    out.meetings.map((m) => [m.id, m.title, m.notes]),
    [
      ["m0", "Kickoff", ""],
      ["m1", "Weekly sync", "Decisions"],
    ],
  );
});

test("reset: refused, with nothing changed, while a meeting is being recorded", async () => {
  const s = services(undefined, { recording: true });
  s.meetings.create({ id: "m1", title: "Weekly sync", startedAt: 1 }, 1);
  s.settings.update({ appearance: "dark" });
  await assert.rejects(
    s.hub.resetApp({ library: true, meetings: true }),
    /A meeting is being recorded.*Stop the recording first/,
  );
  assert.equal(s.meetings.count(), 1);
  assert.equal(s.settings.get().appearance, "dark");
});

test("private files: an existing, world-readable export is tightened to owner-only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-private-"));
  const file = join(dir, "export.json");
  writeFileSync(file, "old", { mode: 0o644 });
  chmodSync(file, 0o644);
  await writePrivateFile(file, "{}");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readFileSync(file, "utf8"), "{}");
  const fresh = join(dir, "new.json");
  await writePrivateFile(fresh, "{}");
  assert.equal(statSync(fresh).mode & 0o777, 0o600);
});

test("reset: signs out and revokes MCP; names the apps whose entries stop working; connectors return to defaults", async () => {
  const s = services(undefined, { mcpApps: ["Claude", "Cursor"] });
  s.settings.update({
    mcp: { enabled: true },
    connectors: { calendar: { enabled: true, reminders: true } },
    vibeCoding: { variables: true },
  });
  const r = await s.hub.resetApp({ library: false });
  assert.deepEqual(s.calls, ["signOut", "mcp"]);
  assert.deepEqual(r.staleMcpApps, ["Claude", "Cursor"]);
  assert.equal(r.ok, true);
  assert.equal(s.settings.get().mcp.enabled, false);
  assert.deepEqual(s.settings.get().connectors, DEFAULT_SETTINGS.connectors);
  assert.deepEqual(s.settings.get().vibeCoding, DEFAULT_SETTINGS.vibeCoding);
});

test("reset: a failing sign-out is reported and the other steps still run; a recording meeting changes nothing", async () => {
  const s = services(undefined, { failAccount: true });
  s.settings.update({ appearance: "dark" });
  const r = await s.hub.resetApp({ library: false });
  assert.deepEqual(r.failed, ["account"]);
  assert.deepEqual(s.calls, ["signOut", "mcp"]);
  assert.equal(s.settings.get().appearance, "system");

  const busy = services(undefined, { recording: true });
  await assert.rejects(busy.hub.resetApp({ library: false }), /recorded/);
  assert.deepEqual(busy.calls, [], "nothing is signed out or revoked");
});

test("another account: counts what this Mac holds; keep hands it over untouched", async () => {
  const s = services(undefined, { switchPending: true });
  s.history.insert(row("a", { hasAudio: true }));
  await s.vault.save("a", new Uint8Array([1, 2, 3]));
  s.hub.addDictionaryEntry({ phrase: "Murmur" });
  s.notes.create("n1", "A note");
  assert.deepEqual(s.hub.localDataCounts(), {
    dictations: 1,
    notes: 1,
    meetings: 0,
    dictionary: 1,
    snippets: 0,
  });
  await s.hub.resolveAccountSwitch({ choice: "keep" });
  assert.deepEqual(s.calls, ["acceptOwner"]);
  assert.equal(s.history.count(), 1, "nothing deleted");
  assert.equal(s.notes.list().length, 1);
  assert.equal(s.hub.listDictionary().length, 1);
  assert.equal(s.hub.exportData().notes.length, 1, "notes are exported too");
});

test("another account: start fresh deletes the data, keeps settings and keys", async () => {
  const s = services(undefined, { switchPending: true });
  s.settings.update({ appearance: "dark" });
  s.settings.setSecret(apiKeySecret("openai"), "test-key-1");
  s.history.insert(row("a", { hasAudio: true }));
  await s.vault.save("a", new Uint8Array([1, 2, 3]));
  s.hub.addDictionaryEntry({ phrase: "Murmur" });
  s.hub.addSnippet({ trigger: "my email", replacement: "you@example.com" });
  s.notes.create("n1", "A note");
  s.meetings.create({ id: "m1", title: "Weekly sync", startedAt: 2 }, 2);

  await s.hub.resolveAccountSwitch({ choice: "fresh" });
  assert.deepEqual(s.calls, ["acceptOwner"]);
  assert.deepEqual(Object.values(s.hub.localDataCounts()), [0, 0, 0, 0, 0]);
  assert.equal(await s.vault.load("a"), null, "recordings deleted too");
  assert.equal(s.settings.get().appearance, "dark", "settings kept");
  assert.equal(s.settings.hasSecret(apiKeySecret("openai")), true, "keys kept");
});

test("another account: nothing happens without a pending question, a failure keeps it open, and bad input is refused", async () => {
  const idle = services();
  idle.history.insert(row("a"));
  await idle.hub.resolveAccountSwitch({ choice: "fresh" });
  assert.equal(idle.history.count(), 1, "no question pending: nothing deleted");
  assert.deepEqual(idle.calls, []);

  const failing = services(undefined, {
    switchPending: true,
    failMeetings: true,
  });
  failing.history.insert(row("a"));
  await assert.rejects(
    failing.hub.resolveAccountSwitch({ choice: "fresh" }),
    /couldn't delete the meetings/,
  );
  assert.equal(failing.pending.switch, true, "asked again, not handed over");

  const recording = services(undefined, {
    switchPending: true,
    recording: true,
  });
  recording.history.insert(row("a"));
  await assert.rejects(
    recording.hub.resolveAccountSwitch({ choice: "fresh" }),
    /meeting is being recorded/,
  );
  assert.equal(recording.history.count(), 1);

  await assert.rejects(
    failing.hub.resolveAccountSwitch({ choice: "delete-everything" }),
  );
});
