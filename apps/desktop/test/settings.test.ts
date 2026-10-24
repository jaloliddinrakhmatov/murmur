import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore, plainCodec } from "../src/main/settings/store.ts";
import { HubService, type HubServiceDeps } from "../src/main/hub/service.ts";
import { DEFAULT_SETTINGS, type Settings } from "../src/shared/settings.ts";
import type { DictationRow } from "../src/shared/ipc.ts";
import {
  DEFAULT_SHORTCUT,
  inSettings,
  latestFor,
  privacyFlows,
  providerState,
  recordKey,
  shortcutMessage,
} from "../src/renderer/hub/model/settings.ts";
import {
  filterLanguages,
  LANGUAGES,
  languageName,
  languagesFor,
  languageUnsupported,
} from "../src/renderer/hub/model/languages.ts";
import {
  isSettingsSection,
  isSettingsTarget,
  resolveSettingsTarget,
} from "../src/renderer/hub/model/settings-sections.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "murmur-settings-"));

/** A store with every field moved away from its default, so a reset would show. */
function customised(dir = tmp()) {
  const store = new SettingsStore(dir, plainCodec);
  store.update({
    onboardingCompleted: true,
    shortcut: "ctrl+opt+f12",
    appearance: "dark",
    capsule: "whileActive",
    speech: { provider: "groq", language: "uz", timeoutMs: 45000 },
    cleanup: { mode: "off", aiTimeoutMs: 8000 },
    dictionary: { enabled: false, useAsVocabulary: false },
    snippets: { enabled: false },
    history: { audioRetentionDays: 30, historyRetentionDays: 90 },
  });
  return { dir, store, before: structuredClone(store.get()) };
}

/** Everything except the fields a patch is allowed to change. */
function unchangedExcept(
  before: Settings,
  after: Settings,
  changed: string[],
): void {
  const strip = (s: Settings) => {
    const copy = structuredClone(s) as Record<string, unknown>;
    for (const path of changed) {
      const [a, b] = path.split(".");
      if (b) delete (copy[a] as Record<string, unknown>)[b];
      else delete copy[a];
    }
    return copy;
  };
  assert.deepEqual(strip(after), strip(before));
}

// ---- Persistence: a change never resets anything else ---------------------------------------

test("changing appearance doesn't reset onboarding or anything else", () => {
  const { store, before } = customised();
  const after = store.update({ appearance: "light" });
  assert.equal(after.appearance, "light");
  assert.equal(after.onboardingCompleted, true);
  unchangedExcept(before, after, ["appearance"]);
});

test("changing the transcription provider doesn't reset dictionary or snippets", () => {
  const { store, before } = customised();
  const after = store.update({ speech: { provider: "openai" } });
  assert.equal(after.speech.provider, "openai");
  assert.equal(after.dictionary.enabled, false);
  assert.equal(after.snippets.enabled, false);
  unchangedExcept(before, after, ["speech.provider"]);
});

test("changing History retention doesn't reset unrelated settings", () => {
  const { store, before } = customised();
  const after = store.update({ history: { historyRetentionDays: 7 } });
  assert.equal(after.history.historyRetentionDays, 7);
  unchangedExcept(before, after, ["history.historyRetentionDays"]);
});

test("microphone and accessibility permission requests don't touch settings (nor the chosen microphone)", async () => {
  const { store, before } = customised();
  let asked = 0;
  const hub = new HubService({
    settings: store,
    system: {
      requestMicrophone: async () => (asked++, true),
      microphoneStatus: () => "granted",
    },
    native: {
      requestAccessibility: () => true,
      permissionStatus: () => ({
        accessibility: true,
        postEvents: true,
        inputMonitoring: false,
      }),
    },
  } as unknown as HubServiceDeps);
  assert.equal(await hub.requestMicrophone(), "granted");
  assert.equal(hub.requestAccessibility(), true);
  assert.equal(asked, 1);
  assert.deepEqual(store.get(), before);
  assert.equal(store.get().shortcut, "ctrl+opt+f12");
});

test("settings persist after a restart", () => {
  const { dir, before } = customised();
  const reopened = new SettingsStore(dir, plainCodec);
  assert.deepEqual(reopened.get(), before);
});

test("a rejected update keeps the last valid configuration, in memory and on disk", () => {
  const { dir, store, before } = customised();
  const file = readFileSync(join(dir, "settings.json"), "utf8");
  for (const bad of [
    { appearance: "sepia" },
    { speech: { provider: "nope" } },
    { history: { historyRetentionDays: -1 } },
    { cleanup: { aiTimeoutMs: 1 } },
    { privacy: { cloudHistory: true } },
    { shortcut: "" },
  ])
    assert.throws(() => store.update(bad), JSON.stringify(bad));
  assert.deepEqual(store.get(), before);
  assert.equal(readFileSync(join(dir, "settings.json"), "utf8"), file);
  assert.deepEqual(new SettingsStore(dir, plainCodec).get(), before);
});

// ---- Shortcut changes through the service -----------------------------------------------------

/** Fake hotkeys with the real `replace` contract: a failure leaves the previous one registered. */
function fakeHotkeys(start: string, taken: string[] = []) {
  const state = {
    combo: start,
    registered: true,
    error: null as string | null,
  };
  return {
    suspend() {},
    bindAction: () => null,
    get current() {
      return state;
    },
    replace(combo: string) {
      if (taken.includes(combo.toLowerCase()))
        return {
          ok: false as const,
          error: "Shortcut is already used by another app",
          status: state,
        };
      state.combo = combo.replace(/\b\w/g, (c) => c.toUpperCase());
      return { ok: true as const, status: state };
    },
  };
}

function shortcutService(taken: string[] = []) {
  const { store, before } = customised();
  const hotkeys = fakeHotkeys("Ctrl+Opt+F12", taken);
  const hub = new HubService({
    settings: store,
    hotkeys,
  } as unknown as HubServiceDeps);
  let notified = 0;
  hub.onStatusChanged(() => notified++);
  return { hub, store, before, hotkeys, notified: () => notified };
}

test("a new shortcut is registered first, then saved (lowercase, normalized)", () => {
  const s = shortcutService();
  const after = s.hub.updateSettings({ shortcut: "ctrl+opt+k" });
  assert.equal(after.shortcut, "ctrl+opt+k");
  assert.equal(s.hotkeys.current.combo, "Ctrl+Opt+K");
  unchangedExcept(s.before, after, ["shortcut"]);
  assert.ok(s.notified() > 0, "status refresh for the UI");
});

test("a shortcut that can't be registered is not saved and the old one keeps working", () => {
  const s = shortcutService(["ctrl+opt+k"]);
  assert.throws(
    () => s.hub.updateSettings({ shortcut: "ctrl+opt+k", appearance: "light" }),
    /already used by another app or by macOS/,
  );
  assert.deepEqual(s.store.get(), s.before, "nothing in the patch was stored");
  assert.equal(s.hotkeys.current.combo, "Ctrl+Opt+F12");
  assert.equal(s.hotkeys.current.registered, true);
});

test("re-saving the current shortcut doesn't re-register it", () => {
  const s = shortcutService(["ctrl+opt+f12"]);
  const after = s.hub.updateSettings({ shortcut: "CTRL+OPT+F12" });
  assert.equal(after.shortcut, "ctrl+opt+f12");
  assert.equal(s.hotkeys.current.combo, "Ctrl+Opt+F12");
});

// ---- Recorder ---------------------------------------------------------------------------------

const ev = (
  key: string,
  code: string,
  mods: Partial<
    Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>
  > = {},
) => ({
  key,
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

test("the recorder turns key presses into shortcuts the native validator understands", () => {
  assert.deepEqual(
    recordKey(ev(" ", "Space", { ctrlKey: true, altKey: true })),
    {
      kind: "combo",
      combo: DEFAULT_SHORTCUT,
    },
  );
  // Option+K types "˚" but the physical key is K.
  assert.deepEqual(
    recordKey(ev("˚", "KeyK", { ctrlKey: true, altKey: true })),
    {
      kind: "combo",
      combo: "ctrl+opt+k",
    },
  );
  assert.deepEqual(
    recordKey(ev("F11", "F11", { metaKey: true, shiftKey: true })),
    {
      kind: "combo",
      combo: "shift+cmd+f11",
    },
  );
  assert.deepEqual(recordKey(ev("7", "Digit7", { ctrlKey: true })), {
    kind: "combo",
    combo: "ctrl+7",
  });
  assert.deepEqual(recordKey(ev("ArrowUp", "ArrowUp", { altKey: true })), {
    kind: "combo",
    combo: "opt+up",
  });
  assert.deepEqual(
    recordKey(ev("F12", "", { ctrlKey: true, altKey: true })),
    {
      kind: "combo",
      combo: "ctrl+opt+f12",
    },
    "synthetic event without code",
  );
  assert.deepEqual(
    recordKey(ev("Control", "ControlLeft", { ctrlKey: true, altKey: true })),
    {
      kind: "modifiers",
      preview: "ctrl+opt",
    },
  );
  assert.deepEqual(recordKey(ev("Escape", "Escape")), { kind: "cancel" });
  assert.deepEqual(recordKey(ev("Escape", "Escape", { ctrlKey: true })), {
    kind: "combo",
    combo: "ctrl+escape",
  });
  assert.equal(
    recordKey(ev(",", "Comma", { ctrlKey: true })).kind,
    "unsupported",
  );
});

test("validator codes become readable messages", () => {
  assert.match(shortcutMessage("needs-modifier"), /Control, Option or Command/);
  assert.match(shortcutMessage("system-reserved"), /macOS uses/);
  assert.match(
    shortcutMessage("needs-input-monitoring (not available in this version)"),
    /fn \(Globe\) and shortcuts made only of modifier keys need Input Monitoring/,
  );
  assert.match(shortcutMessage("unknown key 'comma'"), /letter, number/);
  assert.equal(shortcutMessage("something-new"), "something-new");
});

// ---- Transcription and privacy -----------------------------------------------------------------

test("languages: only those the service accepts; stored codes are kept and flagged", () => {
  assert.equal(languagesFor("openai").length, LANGUAGES.length);
  assert.equal(languagesFor("groq").at(-1)?.code, "ko");
  const deepgram = languagesFor("deepgram").map((l) => l.code);
  assert.ok(deepgram.includes("en") && !deepgram.includes("uz"));
  assert.equal(languageName(""), "Detect automatically");
  assert.equal(languageName("uz"), "Uzbek");
  assert.equal(languageName("sw"), "Other (sw)", "a stored code is kept");
  assert.equal(languageUnsupported("uz", "deepgram"), true);
  assert.equal(languageUnsupported("uz", "groq"), false);
  assert.equal(
    languageUnsupported("", "deepgram"),
    false,
    "automatic always works",
  );
});

test("language search matches English and native names, ignoring case and accents", () => {
  const names = (q: string) => filterLanguages(LANGUAGES, q).map((l) => l.code);
  assert.deepEqual(names("UZB"), ["uz"]);
  assert.deepEqual(names("русский"), ["ru"]);
  assert.deepEqual(names("francais"), ["fr"], "accent-insensitive");
  assert.equal(names("").length, LANGUAGES.length);
  assert.deepEqual(names("zzz"), []);
});

test("settings links: old section names open the new section and its dialog", () => {
  assert.deepEqual(resolveSettingsTarget("shortcuts"), {
    section: "general",
    dialog: "shortcuts",
  });
  // Stage 6B: the microphone row has its own dialog now.
  assert.deepEqual(resolveSettingsTarget("microphone"), {
    section: "general",
    dialog: "microphone",
  });
  assert.deepEqual(resolveSettingsTarget("language"), {
    section: "general",
    dialog: "language",
  });
  assert.deepEqual(resolveSettingsTarget("privacy"), {
    section: "privacy",
    dialog: null,
  });
  assert.ok(isSettingsTarget("shortcuts") && !isSettingsSection("shortcuts"));
  assert.ok(!isSettingsTarget("payments"));
  // Stage B: the Account group opens through settings/account, settings/team, settings/billing.
  for (const id of ["account", "team", "billing"] as const) {
    assert.ok(isSettingsSection(id) && isSettingsTarget(id));
    assert.deepEqual(resolveSettingsTarget(id), { section: id, dialog: null });
  }
});

const row = (extra: Partial<DictationRow>): DictationRow =>
  ({
    id: "r",
    startedAt: 0,
    durationMs: 1000,
    status: "inserted",
    strategy: null,
    rawText: "x",
    finalText: "x",
    wordCount: 1,
    appName: null,
    appBundleId: null,
    error: null,
    hasAudio: false,
    provider: "openai",
    ...extra,
  }) as DictationRow;

test("provider status is claimed only from real evidence", () => {
  assert.deepEqual(providerState("OpenAI API key is not set.", null), {
    tone: "danger",
    label: "Not set up",
    detail: "OpenAI API key is not set.",
  });
  assert.equal(providerState(null, null).label, "Ready, not used yet");
  assert.equal(
    providerState(null, row({ status: "failed" })).label,
    "Last dictation failed",
  );
  assert.equal(providerState(null, row({})).label, "Last dictation worked");
  const rows = [
    row({ id: "a", provider: "groq" }),
    row({ id: "b", provider: "openai", status: "transcribing" }),
    row({ id: "c", provider: "openai", status: "failed" }),
  ];
  assert.equal(latestFor(rows, "openai")?.id, "c");
  assert.equal(latestFor(rows, "deepgram"), null);
});

test("the privacy summary follows the settings, never claiming audio stays on the Mac with a cloud provider", () => {
  const flows = (patch: Partial<Settings> & Record<string, unknown>) =>
    Object.fromEntries(
      privacyFlows({
        ...DEFAULT_SETTINGS,
        ...patch,
      } as Settings).map((f) => [f.label, f.value]),
    );
  const cloud = flows({});
  assert.match(cloud.Audio, /Sent to OpenAI/);
  assert.doesNotMatch(cloud.Audio, /doesn't leave/);
  assert.match(cloud.Transcripts, /Not sent anywhere/);
  assert.match(cloud["Dictionary words"], /sent to OpenAI/);

  const local = flows({
    speech: { ...DEFAULT_SETTINGS.speech, provider: "whisper.cpp" },
  });
  assert.match(local.Audio, /doesn't leave the Mac/);
  const remote = flows({
    speech: {
      ...DEFAULT_SETTINGS.speech,
      provider: "whisper.cpp",
      localServerUrl: "http://10.0.0.5:8178",
    },
  });
  assert.match(remote.Audio, /at http:\/\/10\.0\.0\.5:8178/);

  const ai = flows({
    cleanup: {
      ...DEFAULT_SETTINGS.cleanup,
      mode: "ai",
      aiProvider: "anthropic",
    },
  });
  assert.match(ai.Transcripts, /sent to Anthropic/);
  const noHints = flows({
    dictionary: { enabled: true, useAsVocabulary: false },
  });
  assert.equal(noHints["Dictionary words"], "Not sent.");
  const noHistory = flows({
    history: { ...DEFAULT_SETTINGS.history, enabled: false },
  });
  assert.match(noHistory["Stays on this Mac"], /History is off/);
});

test("the provider's 'Open Settings' hint is dropped inside Settings", () => {
  assert.equal(
    providerState(
      "OpenAI API key is not set. Open Settings → Transcription.",
      null,
    ).detail,
    "OpenAI API key is not set.",
  );
});

test("readiness messages read naturally inside Settings", () => {
  assert.equal(
    inSettings("groq API key is not set. Open Settings → AI cleanup.", {
      groq: "Groq",
    }),
    "Groq API key is not set.",
  );
  assert.equal(
    inSettings("whisper-server not reachable"),
    "whisper-server not reachable",
  );
});

test("Deepgram (nova-3) offers the languages its documentation lists, except Uzbek (Stage 7 review)", () => {
  const deepgram = languagesFor("deepgram").map((l) => l.code);
  assert.deepEqual([...deepgram].sort(), [
    "ar",
    "de",
    "en",
    "es",
    "fr",
    "hi",
    "it",
    "ja",
    "kk",
    "ko",
    "pt",
    "ru",
    "tr",
    "uk",
    "zh",
  ]);
  assert.equal(languageUnsupported("uz", "deepgram"), true);
  assert.equal(languageUnsupported("kk", "deepgram"), false);
});
