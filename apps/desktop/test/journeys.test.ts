// User journeys across a restart, with the real stores (SQLite file, settings file) and the real
// DictationController; only audio, provider, inserter and Capsule are fakes. These guard the
// UI reconstruction: whatever the
// screens look like, data saved in one session must change the next session's dictation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DictationController } from "../src/main/core/controller.ts";
import {
  DictionaryRepo,
  HistoryDb,
  SnippetRepo,
} from "../src/main/history/db.ts";
import { HubService, type HubServiceDeps } from "../src/main/hub/service.ts";
import { SettingsStore, plainCodec } from "../src/main/settings/store.ts";
import { controllerConfig } from "../src/main/settings/controller-config.ts";
import {
  FakeAudio,
  FakeCancelHotkey,
  FakeCapsule,
  FakeClock,
  FakeInserter,
  FakeProvider,
  FakeVault,
  fakeTarget,
  flush,
  realHold,
} from "./helpers.ts";

let n = 0;
const newId = () => `j-${++n}`;

/** One app session over a data directory: what createApp wires, minus Electron. */
function session(dir: string, taken: string[] = []) {
  const settings = new SettingsStore(dir, plainCodec);
  const history = new HistoryDb(join(dir, "murmur.sqlite"));
  const vault = new FakeVault();
  // Carbon stand-in: registers anything except `taken` (held by "another app").
  const state = {
    combo: settings.get().shortcut,
    registered: true,
    error: null,
  };
  const hotkeys = {
    suspend() {},
    bindAction: () => null,
    get current() {
      return state;
    },
    replace(combo: string) {
      if (taken.includes(combo))
        return {
          ok: false as const,
          error: "Shortcut is already used by another app",
          status: state,
        };
      state.combo = combo;
      return { ok: true as const, status: state };
    },
  };
  const hub = new HubService({
    settings,
    dictionary: new DictionaryRepo(history.db),
    snippets: new SnippetRepo(history.db),
    history,
    vault,
    hotkeys,
    env: {},
    newId,
  } as unknown as HubServiceDeps);
  const clock = new FakeClock();
  const provider = new FakeProvider();
  const requests: { language?: string }[] = [];
  const transcribe = provider.transcribe.bind(provider);
  provider.transcribe = async (
    audio: unknown,
    options: { language?: string; signal?: AbortSignal },
  ) => {
    requests.push({ language: options.language });
    return transcribe(audio, options);
  };
  const inserter = new FakeInserter();
  const controller = new DictationController(
    {
      hold: realHold(),
      audio: new FakeAudio(),
      target: fakeTarget(),
      inserter,
      capsule: new FakeCapsule(),
      cancelHotkey: new FakeCancelHotkey(),
      history,
      vault,
      provider: () => provider,
      processing: () => hub.processingConfig(),
      onHits: (h) => hub.recordHits(h),
      clock,
      newId,
      log: () => {},
    },
    // As createApp does: the controller takes its configuration from the stored settings.
    { resultDisplayMs: 100, ...controllerConfig(settings.get()) },
  );
  const dictate = async (spoken: string) => {
    provider.text = spoken;
    controller.hotkey("down");
    await flush();
    await clock.advance(1500);
    controller.hotkey("up");
    await flush();
    await flush();
  };
  return {
    settings,
    history,
    hub,
    inserter,
    dictate,
    requests,
    hotkeys,
    vault,
  };
}

test("journey: a word and a snippet saved before a restart correct the next dictation; History and Home totals follow", async () => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-journey-"));

  const first = session(dir);
  first.hub.addDictionaryEntry({ phrase: "ELD", misheardAs: "yield" });
  first.hub.addSnippet({ trigger: "my email", replacement: "you@example.com" });
  first.settings.update({
    appearance: "dark",
    cleanup: { mode: "deterministic" },
  });
  first.history.close();

  const second = session(dir);
  assert.equal(second.settings.get().appearance, "dark", "settings survived");
  assert.deepEqual(
    second.hub.listDictionary().map((e) => e.phrase),
    ["ELD"],
  );
  await second.dictate("um the yield report goes to my email");
  assert.equal(
    second.inserter.calls[0]?.text,
    "The ELD report goes to you@example.com.",
    "dictionary and snippet applied to the dictation after the restart",
  );
  const stats = second.hub.historyStats();
  assert.equal(stats.dictations, 1);
  const saved = second.history.list()[0];
  assert.ok(saved.wordCount > 0);
  assert.equal(stats.words, saved.wordCount, "Home totals come from History");
  second.history.close();

  const third = session(dir);
  const [row] = third.history.list();
  assert.equal(row.rawText, "um the yield report goes to my email");
  assert.equal(row.finalText, "The ELD report goes to you@example.com.");
  assert.equal(row.status, "inserted");
  assert.equal(third.hub.listDictionary()[0].usageCount, 1, "usage persisted");
  assert.equal(third.hub.listSnippets()[0].usageCount, 1);
  third.history.close();
});

test("journey: disabling the dictionary in Settings stops corrections in the next session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-journey-"));
  const first = session(dir);
  first.hub.addDictionaryEntry({ phrase: "ELD", misheardAs: "yield" });
  first.settings.update({ dictionary: { enabled: false } });
  first.history.close();

  const second = session(dir);
  await second.dictate("the yield report");
  assert.equal(second.inserter.calls[0]?.text, "The yield report.");
  assert.equal(second.hub.listDictionary()[0].enabled, true, "entry kept");
  second.history.close();
});

test("journey (Stage 5): Settings changes survive a restart and drive the next session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-journey-"));
  const first = session(dir, ["ctrl+opt+f9"]);
  // Shortcut: a taken combination is refused and the previous one stays; a free one is saved.
  assert.throws(() => first.hub.updateSettings({ shortcut: "ctrl+opt+f9" }));
  assert.equal(first.settings.get().shortcut, "ctrl+opt+space");
  assert.equal(first.hotkeys.current.combo, "ctrl+opt+space");
  first.hub.updateSettings({ shortcut: "ctrl+opt+k" });
  first.hub.updateSettings({ speech: { provider: "groq", language: "uz" } });
  // A placeholder key (the session's speech provider is a fake; nothing is sent).
  first.hub.setSecret({ provider: "groq", apiKey: "placeholder-not-a-key" });
  first.hub.updateSettings({ history: { historyRetentionDays: 7 } });
  first.hub.updateSettings({ cleanup: { mode: "off" } });
  first.history.insert({
    id: "old",
    startedAt: Date.now() - 10 * 86_400_000,
    durationMs: 1000,
    status: "failed",
    strategy: null,
    rawText: null,
    finalText: null,
    wordCount: 0,
    appName: null,
    appBundleId: null,
    error: "HTTP 503",
    provider: "groq",
    hasAudio: true,
  });
  await first.vault.save("old", new Uint8Array([1, 2, 3]));
  first.history.close();

  const second = session(dir);
  const s = second.settings.get();
  assert.equal(s.shortcut, "ctrl+opt+k", "the app binds this at start");
  assert.equal(second.hub.provider().id, "groq", "the chosen service is used");
  await second.dictate("um the report");
  assert.equal(
    second.requests[0]?.language,
    "uz",
    "language sent with the request",
  );
  assert.equal(
    second.inserter.calls[0]?.text,
    "um the report",
    "None: no cleanup",
  );
  // Retention: the 10-day-old dictation goes on the next purge (run at launch).
  await second.hub.purgeExpiredHistory();
  assert.equal(second.history.get("old"), null);
  second.history.close();
});
