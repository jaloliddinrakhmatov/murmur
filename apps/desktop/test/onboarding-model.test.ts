// First-run setup logic: the step sequence with and without Notetaker, when Continue is enabled,
// survey answers to profile, languages, and the speed and time-saved estimates.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addLanguage,
  answersFromProfile,
  canContinue,
  EMPTY_ANSWERS,
  hoursText,
  profilePatch,
  progressFraction,
  removeLanguage,
  savingsMethod,
  speedText,
  stageStates,
  stepSequence,
  STEP_STAGE,
  toggle,
  wantsNotetaker,
} from "../src/renderer/hub/model/onboarding.ts";
import { speakingSpeed, weeklyTimeSaved } from "../src/shared/onboarding.ts";
import { SettingsSchema, parseSettingsPatch } from "../src/shared/settings.ts";

test("without Notetaker the meeting questions, calendar and (unpracticed) speed are left out", () => {
  const seq = stepSequence({ notetaker: false, practiced: false });
  assert.ok(!seq.includes("meetingTools"));
  assert.ok(!seq.includes("meetingPain"));
  assert.ok(!seq.includes("calendar"));
  assert.ok(!seq.includes("speed"));
  assert.equal(seq[0], "account");
  assert.equal(seq.at(-1), "referral");
});

test("with Notetaker the meeting questions follow the typing question and the calendar follows permissions", () => {
  const seq = stepSequence({ notetaker: true, practiced: true });
  const at = (s: (typeof seq)[number]) => seq.indexOf(s);
  assert.equal(at("meetingTools"), at("typing") + 1);
  assert.equal(at("meetingPain"), at("typing") + 2);
  assert.equal(at("calendar"), at("permissions") + 1);
  assert.ok(at("speed") > at("learnList"));
});

test("stages never go backwards along the sequence", () => {
  const order = [
    "get-started",
    "permissions",
    "set-up",
    "learn",
    "personalize",
  ];
  for (const notetaker of [true, false]) {
    const seq = stepSequence({ notetaker, practiced: true });
    const idx = seq.map((s) => order.indexOf(STEP_STAGE[s]));
    assert.deepEqual(
      idx,
      [...idx].sort((a, b) => a - b),
    );
  }
});

test("Continue is disabled until a survey question has an answer", () => {
  assert.equal(canContinue("heard", EMPTY_ANSWERS), false);
  assert.equal(
    canContinue("heard", { ...EMPTY_ANSWERS, heardFrom: "friend" }),
    true,
  );
  assert.equal(canContinue("help", EMPTY_ANSWERS), false);
  assert.equal(
    canContinue("help", { ...EMPTY_ANSWERS, uses: ["dictation"] }),
    true,
  );
  assert.equal(canContinue("work", EMPTY_ANSWERS), false);
  assert.equal(canContinue("typing", EMPTY_ANSWERS), false);
  assert.equal(canContinue("meetingTools", EMPTY_ANSWERS), false);
  assert.equal(
    canContinue("meetingPain", { ...EMPTY_ANSWERS, meetingPains: ["focus"] }),
    true,
  );
  for (const s of [
    "account",
    "data",
    "permissions",
    "mic",
    "shortcut",
    "savings",
  ] as const)
    assert.equal(canContinue(s, EMPTY_ANSWERS), true, s);
});

test("toggle adds and removes without reordering", () => {
  assert.deepEqual(toggle(["a", "b"], "c"), ["a", "b", "c"]);
  assert.deepEqual(toggle(["a", "b", "c"], "b"), ["a", "c"]);
});

test("the profile patch drops Notetaker answers when Notetaker wasn't picked, and round-trips", () => {
  const a = {
    heardFrom: "search",
    uses: ["dictation"],
    work: "design",
    typingPlaces: ["email", "notes"],
    meetingTools: ["zoom"],
    meetingPains: ["focus"],
  };
  assert.equal(wantsNotetaker(a), false);
  const p = profilePatch(a, 1234);
  assert.deepEqual(p.meetingTools, []);
  assert.deepEqual(p.meetingPains, []);
  assert.equal(p.heardFrom, "search");
  assert.equal(p.completedAt, 1234);
  const b = { ...a, uses: ["dictation", "notetaker"] };
  assert.deepEqual(answersFromProfile(profilePatch(b, 1)), b);
  assert.deepEqual(answersFromProfile(undefined), EMPTY_ANSWERS);
});

test("the profile patch is accepted by the settings patch parser and keeps other settings", () => {
  const defaults = SettingsSchema.parse({});
  const a = {
    ...EMPTY_ANSWERS,
    heardFrom: "friend",
    uses: ["notetaker"],
    work: "other",
    typingPlaces: ["email"],
    meetingTools: ["meet"],
    meetingPains: ["sharing"],
  };
  const patch = parseSettingsPatch({
    profile: profilePatch(a, 5),
    speech: { languages: ["en", "uz"] },
  });
  assert.deepEqual(patch.profile?.meetingTools, ["meet"]);
  assert.deepEqual(patch.speech?.languages, ["en", "uz"]);
  assert.equal(patch.shortcut, undefined);
  assert.equal(defaults.profile.completedAt, null);
});

test("languages: no duplicates, a cap, and none means automatic", () => {
  assert.deepEqual(addLanguage(["en"], "en"), ["en"]);
  assert.deepEqual(addLanguage(["en"], "uz"), ["en", "uz"]);
  const eight = ["a", "b", "c", "d", "e", "f", "g", "h"].map((c) => c + c);
  assert.deepEqual(addLanguage(eight, "zz"), eight);
  assert.deepEqual(removeLanguage(["en"], "en"), []);
  assert.deepEqual(removeLanguage(["en", "uz"], "en"), ["uz"]);
});

test("speed text says it is an estimate and shows the multiple", () => {
  const wpm = speakingSpeed([
    { words: 30, seconds: 12 },
    { words: 20, seconds: 8 },
  ]).wpm;
  assert.equal(wpm, 150);
  const t = speedText(150);
  assert.match(t.headline, /3\.8× faster/);
  assert.match(t.detail, /150 words per minute/);
  assert.match(t.detail, /estimate/);
  assert.equal(speedText(38).headline, "About as fast as typing");
});

test("time saved and its method text", () => {
  assert.equal(
    weeklyTimeSaved({ typingHoursPerDay: 2, speakingWpm: 160 }).hoursPerWeek,
    7.5,
  );
  assert.equal(hoursText(1), "1 hour");
  assert.equal(hoursText(7.5), "7.5 hours");
  assert.equal(hoursText(3), "3 hours");
  assert.match(savingsMethod(150, true), /estimate.*from your practice/i);
  assert.match(savingsMethod(130, false), /typical pace/);
});

test("stepper states and progress", () => {
  const seq = stepSequence({ notetaker: false, practiced: false });
  const states = stageStates(seq, "mic").map((s) => s.state);
  assert.deepEqual(states, ["done", "done", "current", "todo", "todo"]);
  assert.ok(
    progressFraction(seq, "account") < progressFraction(seq, "referral"),
  );
  assert.equal(progressFraction(seq, "referral"), 1);
  assert.equal(progressFraction(seq, "speed"), 0);
});

test("transcription is part of setup, before the microphone test", () => {
  const seq = stepSequence({ notetaker: false, practiced: false });
  assert.equal(seq.indexOf("transcription") + 1, seq.indexOf("mic"));
});
