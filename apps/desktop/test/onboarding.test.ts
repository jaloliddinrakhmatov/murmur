import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ASSUMED_TYPING_WPM,
  ProfileSchema,
  profileSuggestions,
  showNotetakerSetup,
  speakingSpeed,
  speedComparison,
  weeklyTimeSaved,
} from "../src/shared/onboarding.ts";
import {
  effectiveLanguage,
  migrateLanguages,
  normalizeLanguages,
} from "../src/shared/languages.ts";
import {
  applyPatch,
  DEFAULT_SETTINGS,
  parseSettingsPatch,
} from "../src/shared/settings.ts";
import { plainCodec, SettingsStore } from "../src/main/settings/store.ts";
import { controllerConfig } from "../src/main/settings/controller-config.ts";
import {
  OnboardingSupport,
  PracticeAwareInserter,
  PROBE_TIMEOUT_MS,
  WATCH_TTL_MS,
  type OnboardingPorts,
  type SoundTapProbe,
} from "../src/main/onboarding/service.ts";
import type {
  Inserter,
  InsertMeta,
  TargetSnapshot,
} from "../src/main/core/types.ts";

// ---- Profile ----------------------------------------------------------------------------------

test("profile: defaults are empty, unknown ids are refused, lists lose repeats", () => {
  const empty = ProfileSchema.parse({});
  assert.deepEqual(empty, {
    heardFrom: null,
    uses: [],
    work: null,
    typingPlaces: [],
    meetingTools: [],
    meetingPains: [],
    completedAt: null,
  });
  assert.deepEqual(
    ProfileSchema.parse({ uses: ["notetaker", "notetaker", "dictation"] }).uses,
    ["notetaker", "dictation"],
  );
  assert.throws(() => ProfileSchema.parse({ work: "astronaut" }));
  assert.throws(() => ProfileSchema.parse({ typingPlaces: ["nowhere"] }));
  assert.deepEqual(DEFAULT_SETTINGS.profile, empty);
});

test("profile: a settings patch keeps the other answers and settings", () => {
  const patch = parseSettingsPatch({
    profile: { work: "developer", typingPlaces: ["coding", "email"] },
  });
  assert.deepEqual(Object.keys(patch), ["profile"]);
  const first = applyPatch(DEFAULT_SETTINGS, patch);
  const second = applyPatch(
    first,
    parseSettingsPatch({ profile: { uses: ["dictation"], completedAt: 5 } }),
  );
  assert.equal(second.profile.work, "developer");
  assert.deepEqual(second.profile.typingPlaces, ["coding", "email"]);
  assert.deepEqual(second.profile.uses, ["dictation"]);
  assert.equal(second.profile.completedAt, 5);
  assert.equal(second.shortcut, DEFAULT_SETTINGS.shortcut);
});

test("suggestions: developers and code editors suggest Vibe coding, email and chat suggest Styles", () => {
  const none: { work: null; typingPlaces: string[] } = {
    work: null,
    typingPlaces: [],
  };
  assert.deepEqual(profileSuggestions(none), {
    vibeCoding: false,
    styles: false,
  });
  assert.equal(
    profileSuggestions({ work: "developer", typingPlaces: [] }).vibeCoding,
    true,
  );
  assert.equal(
    profileSuggestions({ work: "sales", typingPlaces: ["coding"] }).vibeCoding,
    true,
  );
  assert.equal(
    profileSuggestions({ work: "sales", typingPlaces: ["email"] }).styles,
    true,
  );
  assert.equal(
    profileSuggestions({ work: "sales", typingPlaces: ["messages"] }).styles,
    true,
  );
  assert.equal(
    profileSuggestions({ work: "sales", typingPlaces: ["docs"] }).styles,
    false,
  );
});

test("Notetaker setup card: hidden only when a finished survey left meetings out", () => {
  assert.equal(showNotetakerSetup({ uses: [], completedAt: null }), true);
  assert.equal(
    showNotetakerSetup({ uses: ["dictation"], completedAt: null }),
    true,
  );
  assert.equal(showNotetakerSetup({ uses: [], completedAt: 1 }), true);
  assert.equal(
    showNotetakerSetup({ uses: ["dictation"], completedAt: 1 }),
    false,
  );
  assert.equal(
    showNotetakerSetup({ uses: ["dictation", "notetaker"], completedAt: 1 }),
    true,
  );
});

// ---- Languages --------------------------------------------------------------------------------

test("effectiveLanguage: one language is used, none or several detect automatically", () => {
  const of = (language: string, languages: string[]) =>
    effectiveLanguage({ speech: { language, languages } });
  assert.deepEqual(of("", []), { language: "", hints: [] });
  assert.deepEqual(of("", ["uz"]), { language: "uz", hints: [] });
  assert.deepEqual(of("uz", []), { language: "uz", hints: [] });
  assert.deepEqual(of("", ["uz", "ru"]), { language: "", hints: ["uz", "ru"] });
  assert.deepEqual(of("en", ["uz", "uz"]), { language: "uz", hints: [] });
  assert.deepEqual(normalizeLanguages(["EN", "en", "x", "pt-BR"]), [
    "en",
    "pt-br",
  ]);
});

test("languages: a patch keeps language and languages in step", () => {
  const several = applyPatch(
    DEFAULT_SETTINGS,
    parseSettingsPatch({ speech: { languages: ["uz", "ru"] } }),
  );
  assert.deepEqual(several.speech.languages, ["uz", "ru"]);
  assert.equal(several.speech.language, "");
  const one = applyPatch(
    several,
    parseSettingsPatch({ speech: { languages: ["en"] } }),
  );
  assert.equal(one.speech.language, "en");
  // The older single-language patch still works.
  const legacy = applyPatch(
    one,
    parseSettingsPatch({ speech: { language: "de" } }),
  );
  assert.deepEqual(legacy.speech.languages, ["de"]);
  const auto = applyPatch(
    legacy,
    parseSettingsPatch({ speech: { language: "" } }),
  );
  assert.deepEqual(auto.speech.languages, []);
  assert.throws(() =>
    parseSettingsPatch({ speech: { languages: ["not a code"] } }),
  );
  assert.equal(auto.speech.provider, DEFAULT_SETTINGS.speech.provider);
});

test("languages: settings saved with only `language` migrate to the list", () => {
  assert.deepEqual(migrateLanguages({ language: "uz", languages: [] }), {
    language: "uz",
    languages: ["uz"],
  });
  const dir = mkdtempSync(join(tmpdir(), "murmur-lang-"));
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ speech: { language: "uz" } }),
  );
  const store = new SettingsStore(dir, plainCodec);
  assert.deepEqual(store.get().speech.languages, ["uz"]);
  assert.equal(store.get().speech.language, "uz");
  store.update({ onboardingCompleted: true });
  const saved = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  assert.deepEqual(saved.speech.languages, ["uz"]);
});

test("controller config: one language is sent, several become hints", () => {
  const cfg = (languages: string[]) =>
    controllerConfig(
      applyPatch(
        DEFAULT_SETTINGS,
        parseSettingsPatch({ speech: { languages } }),
      ),
    );
  assert.equal(cfg(["uz"]).language, "uz");
  assert.deepEqual(cfg(["uz"]).languageHints, []);
  assert.equal(cfg(["uz", "ru"]).language, "");
  assert.deepEqual(cfg(["uz", "ru"]).languageHints, ["uz", "ru"]);
});

// ---- Speed ------------------------------------------------------------------------------------

test("speakingSpeed: total words over total seconds, and nothing for too little speech", () => {
  assert.equal(speakingSpeed([]).wpm, null);
  assert.equal(speakingSpeed([{ words: 3, seconds: 2 }]).wpm, null);
  const r = speakingSpeed([
    { words: 30, seconds: 12 },
    { words: 30, seconds: 18 },
    { words: 0, seconds: 5 },
    { words: 10, seconds: 0 },
  ]);
  assert.deepEqual(r, { wpm: 120, words: 60, seconds: 30 });
});

test("speedComparison and weeklyTimeSaved are labelled estimates against 40 wpm", () => {
  assert.equal(ASSUMED_TYPING_WPM, 40);
  assert.deepEqual(speedComparison(130), {
    typingWpm: 40,
    speakingWpm: 130,
    times: 3.3,
  });
  // 2 h/day at 40 wpm = 4800 words/day; spoken at 160 wpm that is 30 min: 1.5 h saved a day.
  const t = weeklyTimeSaved({ typingHoursPerDay: 2, speakingWpm: 160 });
  assert.deepEqual(t, {
    hoursPerWeek: 7.5,
    minutesPerWeek: 450,
    estimate: true,
  });
  assert.equal(
    weeklyTimeSaved({ typingHoursPerDay: 2, speakingWpm: 30 }).minutesPerWeek,
    0,
  );
  assert.equal(
    weeklyTimeSaved({ typingHoursPerDay: -3, speakingWpm: 160 }).minutesPerWeek,
    0,
  );
  assert.equal(
    weeklyTimeSaved({ typingHoursPerDay: Number.NaN, speakingWpm: 160 })
      .minutesPerWeek,
    0,
  );
  assert.equal(
    weeklyTimeSaved({ typingHoursPerDay: 99, speakingWpm: 160 }).hoursPerWeek,
    weeklyTimeSaved({ typingHoursPerDay: 12, speakingWpm: 160 }).hoursPerWeek,
  );
});

// ---- OnboardingSupport ------------------------------------------------------------------------

function setup(over: Partial<OnboardingPorts> = {}) {
  const sent: { channel: string; payload: unknown }[] = [];
  const clock = { t: 1000 };
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  let access: "unknown" | "allowed" | "denied" = "unknown";
  const ports: OnboardingPorts = {
    send: ((channel: string, payload: unknown) => {
      sent.push({ channel, payload });
      return true;
    }) as OnboardingPorts["send"],
    hubFocused: () => true,
    soundTap: null,
    audioBusy: () => false,
    access: { read: () => access, write: (v) => (access = v) },
    now: () => clock.t,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      (t as { cleared: boolean }).cleared = true;
    },
    ...over,
  };
  return {
    s: new OnboardingSupport(ports),
    sent,
    clock,
    timers,
    getAccess: () => access,
  };
}

test("practice: delivered only to a field that has had focus since release", () => {
  const { s, sent, clock } = setup();
  assert.equal(s.acceptsDictation(2000), false);
  clock.t = 1500;
  s.setPracticeFocus({ active: true, fieldId: "learn-1" });
  assert.equal(s.acceptsDictation(1400), false, "focus came after release");
  assert.equal(s.acceptsDictation(1600), true);
  assert.equal(s.insert("hello there friend", 4321.4), true);
  assert.deepEqual(sent.at(-1), {
    channel: "hub:practiceText",
    payload: {
      fieldId: "learn-1",
      text: "hello there friend",
      words: 3,
      durationMs: 4321,
    },
  });
  // Refocusing the same field keeps the original time; blur of another field changes nothing.
  clock.t = 1700;
  s.setPracticeFocus({ active: true, fieldId: "learn-1" });
  assert.equal(s.acceptsDictation(1600), true);
  s.setPracticeFocus({ active: false, fieldId: "other" });
  assert.equal(s.acceptsDictation(2000), true);
  s.setPracticeFocus({ active: false, fieldId: "learn-1" });
  assert.equal(s.acceptsDictation(2000), false);
  assert.equal(s.insert("x", 1), false);
  assert.throws(() => s.setPracticeFocus({ active: true, fieldId: "bad id!" }));
});

test("practice: a Hub window that lost the keyboard is not a target; releaseAll clears focus", () => {
  let focused = true;
  const { s } = setup({ hubFocused: () => focused });
  s.setPracticeFocus({ active: true, fieldId: "a" });
  focused = false;
  assert.equal(s.acceptsDictation(Date.now() + 10), false);
  focused = true;
  assert.equal(s.acceptsDictation(Date.now() + 10), true);
  s.releaseAll();
  assert.equal(s.acceptsDictation(Date.now() + 10), false);
});

const target = (over: Partial<TargetSnapshot> = {}): TargetSnapshot => ({
  appBundleId: "com.murmur",
  appName: "Murmur",
  pid: 77,
  secure: false,
  takenAt: 2000,
  ...over,
});

test("PracticeAwareInserter: direct into the field; everything else goes to the next inserter", async () => {
  const calls: { text: string; meta?: InsertMeta }[] = [];
  const inner: Inserter = {
    insert: async (text, _t, meta) => {
      calls.push({ text, meta });
      return { strategy: "clipboard-only", reason: "self-target" };
    },
  };
  let accepts = true;
  let delivers = true;
  const delivered: [string, number][] = [];
  const practice = {
    acceptsDictation: () => accepts,
    insert: (text: string, ms: number) => {
      delivered.push([text, ms]);
      return delivers;
    },
  };
  let secure = false;
  const ins = new PracticeAwareInserter(
    inner,
    practice,
    () => {},
    () => secure,
    77,
  );
  assert.deepEqual(await ins.insert("hi", target(), { durationMs: 900 }), {
    strategy: "direct",
  });
  assert.deepEqual(delivered, [["hi", 900]]);
  assert.equal(calls.length, 0);

  // Another app, secure input, secure field, lost focus, failed delivery: normal inserter.
  assert.equal(
    (await ins.insert("a", target({ pid: 5 }))).strategy,
    "clipboard-only",
  );
  secure = true;
  assert.equal((await ins.insert("b", target())).strategy, "clipboard-only");
  secure = false;
  assert.equal(
    (await ins.insert("c", target({ secure: true }))).strategy,
    "clipboard-only",
  );
  accepts = false;
  assert.equal((await ins.insert("d", target())).strategy, "clipboard-only");
  accepts = true;
  delivers = false;
  const last = await ins.insert("e", target(), { durationMs: 5 });
  assert.equal(last.strategy, "clipboard-only");
  assert.deepEqual(
    calls.map((c) => c.text),
    ["a", "b", "c", "d", "e"],
  );
  assert.deepEqual(calls.at(-1)?.meta, { durationMs: 5 });
});

test("shortcut test: key state is reported and nothing is passed on while watching", () => {
  const { s, sent, timers } = setup();
  assert.equal(
    s.shortcutEvent("down"),
    false,
    "not watching: the controller gets it",
  );
  assert.equal(s.shortcutEvent("up"), false);
  assert.equal(s.watchShortcut({ on: true }), true);
  assert.equal(timers.at(-1)?.ms, WATCH_TTL_MS);
  assert.equal(s.shortcutEvent("down"), true);
  assert.equal(s.shortcutEvent("up"), true);
  assert.deepEqual(
    sent.map((e) => e.payload),
    [{ down: true }, { down: false }],
  );
  s.watchShortcut({ on: false });
  assert.equal(s.shortcutEvent("down"), false);
  assert.equal(timers.at(-1)?.cleared, true);
});

test("shortcut test: ending it while the key is held releases the display and swallows the release", () => {
  const { s, sent } = setup();
  s.watchShortcut({ on: true });
  s.shortcutEvent("down");
  s.watchShortcut({ on: false });
  assert.deepEqual(sent.at(-1)?.payload, { down: false });
  const before = sent.length;
  assert.equal(
    s.shortcutEvent("up"),
    true,
    "the controller never saw the press",
  );
  assert.equal(sent.length, before);
});

test("shortcut test: a press the controller already has is released to it", () => {
  const { s } = setup();
  assert.equal(s.shortcutEvent("down"), false);
  s.watchShortcut({ on: true });
  assert.equal(s.shortcutEvent("up"), false);
});

test("shortcut test: expires by itself and when the window goes away", () => {
  const a = setup();
  a.s.watchShortcut({ on: true });
  a.timers.at(-1)!.fn();
  assert.equal(a.s.shortcutEvent("down"), false);
  const b = setup();
  b.s.watchShortcut({ on: true });
  b.s.releaseAll();
  assert.equal(b.s.shortcutEvent("down"), false);
});

function fakeTap(
  start: () => Promise<void>,
  support = "available",
): SoundTapProbe & { starts: number; stops: number } {
  const tap = {
    starts: 0,
    stops: 0,
    support: () => support,
    start: () => {
      tap.starts++;
      return start();
    },
    stop: () => {
      tap.stops++;
    },
  };
  return tap;
}

test("sound permission: Allow starts and stops the tap once, never reads audio, and remembers the answer", async () => {
  const tap = fakeTap(async () => {});
  const { s, getAccess } = setup({ soundTap: tap });
  assert.equal(s.systemAudioStatus().access, "unknown");
  assert.equal(tap.starts, 0, "status asks nothing");
  const r = await s.requestSystemAudio();
  assert.equal(r.access, "allowed");
  assert.equal(getAccess(), "allowed");
  assert.deepEqual([tap.starts, tap.stops], [1, 1]);
});

test("sound permission: a refusal is 'denied' with a way forward; the tap is released", async () => {
  const tap = fakeTap(async () => {
    throw new Error("denied");
  });
  const { s } = setup({ soundTap: tap });
  const r = await s.requestSystemAudio();
  assert.equal(r.access, "denied");
  assert.match(r.message ?? "", /System Settings/);
  assert.equal(tap.stops, 1);
});

test("sound permission: never asked in automated runs, on old macOS, or while audio is busy", async () => {
  const none = setup({ soundTap: null });
  assert.equal((await none.s.requestSystemAudio()).access, "unknown");
  const old = fakeTap(async () => {}, "unsupported-os");
  const o = setup({ soundTap: old });
  const r = await o.s.requestSystemAudio();
  assert.equal(old.starts, 0);
  assert.match(r.message ?? "", /macOS 14\.2/);
  const busyTap = fakeTap(async () => {});
  const b = setup({ soundTap: busyTap, audioBusy: () => true });
  const rb = await b.s.requestSystemAudio();
  assert.equal(busyTap.starts, 0);
  assert.equal(rb.access, "unknown");
  assert.ok(rb.message);
});

test("sound permission: clicks while a prompt is open share one probe; an unanswered prompt times out and stops", async () => {
  let release!: () => void;
  const tap = fakeTap(() => new Promise<void>((r) => (release = r)));
  const { s, timers } = setup({ soundTap: tap });
  const p1 = s.requestSystemAudio();
  const p2 = s.requestSystemAudio();
  assert.equal(p1, p2);
  assert.equal(tap.starts, 1);
  const timeout = timers.find((t) => t.ms === PROBE_TIMEOUT_MS)!;
  timeout.fn();
  const r = await p1;
  assert.equal(r.access, "unknown");
  assert.match(r.message ?? "", /waiting/);
  assert.equal(tap.stops, 1);
  release();
});
