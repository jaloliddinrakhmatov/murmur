// First-run setup (pure; unit-tested in test/onboarding-model.test.ts): the step sequence with and
// without Notetaker, when Continue is enabled, how the survey answers become a settings patch, and
// the speed and time-saved estimates. Estimates are labelled as such wherever they are shown.

import { MAX_LANGUAGES } from "../../../shared/languages.ts";
import {
  ASSUMED_TYPING_WPM,
  ProfileSchema,
  speedComparison,
  WORK_DAYS_PER_WEEK,
  type Profile,
} from "../../../shared/onboarding.ts";

export type Stage =
  "get-started" | "permissions" | "set-up" | "learn" | "personalize";

export const STAGES: { id: Stage; label: string }[] = [
  { id: "get-started", label: "Get started" },
  { id: "permissions", label: "Permissions" },
  { id: "set-up", label: "Set up" },
  { id: "learn", label: "Learn" },
  { id: "personalize", label: "Personalize" },
];

export type StepId =
  | "account"
  | "heard"
  | "help"
  | "work"
  | "typing"
  | "meetingTools"
  | "meetingPain"
  | "data"
  | "permissions"
  | "calendar"
  | "transcription"
  | "mic"
  | "languages"
  | "shortcut"
  | "learnChat"
  | "learnEmail"
  | "learnList"
  | "speed"
  | "savings"
  | "referral";

export const STEP_STAGE: Record<StepId, Stage> = {
  account: "get-started",
  heard: "get-started",
  help: "get-started",
  work: "get-started",
  typing: "get-started",
  meetingTools: "get-started",
  meetingPain: "get-started",
  data: "get-started",
  permissions: "permissions",
  calendar: "permissions",
  transcription: "set-up",
  mic: "set-up",
  languages: "set-up",
  shortcut: "set-up",
  learnChat: "learn",
  learnEmail: "learn",
  learnList: "learn",
  speed: "personalize",
  savings: "personalize",
  referral: "personalize",
};

/** Practice screens can be skipped. */
export const SKIPPABLE: ReadonlySet<StepId> = new Set([
  "learnChat",
  "learnEmail",
  "learnList",
]);

export {
  HEARD_FROM_OPTIONS,
  MEETING_PAIN_OPTIONS,
  MEETING_TOOL_OPTIONS,
  TYPING_PLACE_OPTIONS,
  USE_OPTIONS,
  WORK_OPTIONS,
  type Option,
} from "../../../shared/onboarding.ts";

/** The survey answers while the person is still answering (single choices are null until picked). */
export interface Answers {
  heardFrom: string | null;
  uses: string[];
  work: string | null;
  typingPlaces: string[];
  meetingTools: string[];
  meetingPains: string[];
}

export const EMPTY_ANSWERS: Answers = {
  heardFrom: null,
  uses: [],
  work: null,
  typingPlaces: [],
  meetingTools: [],
  meetingPains: [],
};

export const wantsNotetaker = (a: Answers) => a.uses.includes("notetaker");

export interface SequenceContext {
  notetaker: boolean;
  /** At least one practice dictation produced text (speed and time saved need it). */
  practiced: boolean;
}

/** The steps in order. Notetaker screens appear only for people who picked Notetaker. */
export function stepSequence(ctx: SequenceContext): StepId[] {
  const steps: StepId[] = ["account", "heard", "help", "work", "typing"];
  if (ctx.notetaker) steps.push("meetingTools", "meetingPain");
  steps.push("data", "permissions");
  if (ctx.notetaker) steps.push("calendar");
  steps.push(
    "transcription",
    "mic",
    "languages",
    "shortcut",
    "learnChat",
    "learnEmail",
    "learnList",
  );
  if (ctx.practiced) steps.push("speed");
  steps.push("savings", "referral");
  return steps;
}

/** Toggles one id in a multi-choice answer, keeping the list order stable. */
export function toggle(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

/** Whether Continue is enabled: survey questions need an answer, everything else never blocks. */
export function canContinue(step: StepId, a: Answers): boolean {
  switch (step) {
    case "heard":
      return a.heardFrom !== null;
    case "help":
      return a.uses.length > 0;
    case "work":
      return a.work !== null;
    case "typing":
      return a.typingPlaces.length > 0;
    case "meetingTools":
      return a.meetingTools.length > 0;
    case "meetingPain":
      return a.meetingPains.length > 0;
    default:
      return true;
  }
}

/** The five stages' state for the stepper. */
export function stageStates(
  seq: StepId[],
  step: StepId,
): { id: Stage; label: string; state: "done" | "current" | "todo" }[] {
  const current = STAGES.findIndex((s) => s.id === STEP_STAGE[step]);
  return STAGES.map((s, i) => ({
    ...s,
    state: i < current ? "done" : i === current ? "current" : "todo",
  }));
}

/** 0–1, for the thin line under the stepper. */
export function progressFraction(seq: StepId[], step: StepId): number {
  const i = seq.indexOf(step);
  return i < 0 ? 0 : (i + 1) / seq.length;
}

// ---- Survey answers → settings --------------------------------------------------------------

/** The `settings.profile` patch (arrays replace whole). Notetaker answers are dropped when Notetaker wasn't picked. */
export function profilePatch(a: Answers, now: number): Profile {
  const notetaker = wantsNotetaker(a);
  return ProfileSchema.parse({
    heardFrom: a.heardFrom,
    uses: a.uses,
    work: a.work,
    typingPlaces: a.typingPlaces,
    meetingTools: notetaker ? a.meetingTools : [],
    meetingPains: notetaker ? a.meetingPains : [],
    completedAt: now,
  });
}

/** The reverse, for a person who opens setup again. */
export function answersFromProfile(p: Profile | undefined): Answers {
  if (!p) return EMPTY_ANSWERS;
  return {
    heardFrom: p.heardFrom,
    uses: p.uses,
    work: p.work,
    typingPlaces: p.typingPlaces,
    meetingTools: p.meetingTools,
    meetingPains: p.meetingPains,
  };
}

// ---- Languages ------------------------------------------------------------------------------

/** Adds a language (no duplicates, at most MAX_LANGUAGES). */
export function addLanguage(codes: string[], code: string): string[] {
  return codes.includes(code) || codes.length >= MAX_LANGUAGES
    ? codes
    : [...codes, code];
}

/** Removes one. No languages at all means automatic detection. */
export function removeLanguage(codes: string[], code: string): string[] {
  return codes.filter((c) => c !== code);
}

// ---- Speed and time saved (estimates; the arithmetic is in shared/onboarding.ts) ------------

export const TYPING_HOURS_RANGE = { min: 0.5, max: 8, step: 0.5, initial: 2 };

/** Spoken speed used when practice was skipped: a typical conversational pace, said as such. */
export const TYPICAL_SPEAKING_WPM = 130;

export function speedText(wpm: number): { headline: string; detail: string } {
  const { times } = speedComparison(wpm);
  return {
    headline:
      times > 1
        ? `${times.toLocaleString("en-US", { minimumFractionDigits: 1 })}× faster than typing`
        : "About as fast as typing",
    detail: `You spoke at about ${wpm} words per minute in your practice. Typing averages about ${ASSUMED_TYPING_WPM} (an estimate, not your own typing speed).`,
  };
}

/** "3 hours", "1.5 hours", "1 hour". */
export function hoursText(hours: number): string {
  const n = Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
  return `${n} ${hours === 1 ? "hour" : "hours"}`;
}

export function savingsMethod(wpm: number, measured: boolean): string {
  return `An estimate: typing at about ${ASSUMED_TYPING_WPM} words per minute against speaking at ${wpm} (${measured ? "from your practice" : "a typical pace, since you skipped practice"}), ${WORK_DAYS_PER_WEEK} days a week.`;
}
