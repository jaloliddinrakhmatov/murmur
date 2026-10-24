// First-run setup support (main + renderer). API for the setup screens:
//
// SETTINGS (patch with `hub.updateSettings`, validated by parseSettingsPatch)
//   settings.profile   the survey answers, kept on this Mac only: nothing is sent anywhere.
//                      { heardFrom, uses, work, typingPlaces, meetingTools, meetingPains,
//                        completedAt }  (option ids and labels: the *_OPTIONS lists below).
//                      Arrays are replaced whole by a patch. Stamp `completedAt: Date.now()`
//                      when the survey is finished.
//   settings.speech.languages  the languages you speak (codes). One = transcribe with it; none or
//                      several = automatic detection (the list is passed as a hint where the
//                      service supports one). `speech.language` mirrors it (set either; main keeps
//                      them in step). See shared/languages.ts (effectiveLanguage).
//
// PURE HELPERS (this file): profileSuggestions, showNotetakerSetup, speakingSpeed,
//   speedComparison, weeklyTimeSaved; shared/languages.ts: effectiveLanguage.
//
// HUB CHANNELS (window.hub, Hub-only; see HubApi in ipc.ts)
//   setPracticeFocus({ active, fieldId })  tell main a practice field has / lost focus. While one
//       has focus, a dictation is delivered straight into it (no paste, no clipboard, no
//       keystroke) as the event onPracticeText.  Send active:false on blur and on unmount.
//   onPracticeText(cb)     { fieldId, text, words, durationMs }: insert `text` at the field's
//       cursor. `words` and `durationMs` (recording length) feed speakingSpeed().
//   watchShortcut(on)      while on, holding the real dictation shortcut only emits
//       onShortcutState; it does NOT open the microphone or record. Turn it off when leaving the
//       "test your shortcut" step (it also ends if the window reloads or after 2 minutes).
//   onShortcutState(cb)    { down: boolean }.
//   systemAudioStatus()    { support, access } for "Your Mac's sound". Asks nothing.
//   requestSystemAudio()   the only call that can show macOS's permission prompt; send it from
//       the Allow button. Briefly opens and closes the sound tap; nothing is recorded.
//   Existing: requestMicrophone, getStatus (permissions.accessibility), requestAccessibility,
//       openSystemSettings("accessibility" | "microphone"), calendarStatus / connectCalendar.
//
// PRACTICE DICTATIONS are saved in History like any other (strategy "direct") and count in Home
// and Insights: they are real dictations, and excluding them would need a stored flag.
import { z } from "zod";

export interface Option<Id extends string = string> {
  id: Id;
  label: string;
}

export const HEARD_FROM_OPTIONS = [
  { id: "friend", label: "A friend or colleague" },
  { id: "social", label: "Social media" },
  { id: "search", label: "A web search" },
  { id: "video", label: "A video or podcast" },
  { id: "newsletter", label: "A newsletter or article" },
  { id: "work", label: "My workplace" },
  { id: "other", label: "Somewhere else" },
] as const satisfies readonly Option[];

export const USE_OPTIONS = [
  { id: "dictation", label: "Dictating text anywhere" },
  { id: "notetaker", label: "Notes from my meetings" },
] as const satisfies readonly Option[];

export const WORK_OPTIONS = [
  { id: "developer", label: "Software development" },
  { id: "design", label: "Design" },
  { id: "writing", label: "Writing or editing" },
  { id: "marketing", label: "Marketing" },
  { id: "sales", label: "Sales" },
  { id: "support", label: "Customer support" },
  { id: "management", label: "Management" },
  { id: "founder", label: "Running a company" },
  { id: "research", label: "Research" },
  { id: "student", label: "Studying" },
  { id: "other", label: "Something else" },
] as const satisfies readonly Option[];

export const TYPING_PLACE_OPTIONS = [
  { id: "email", label: "Email" },
  { id: "messages", label: "Chat and messages" },
  { id: "docs", label: "Documents" },
  { id: "notes", label: "Notes" },
  { id: "coding", label: "Code editors" },
  { id: "browser", label: "The browser" },
  { id: "social", label: "Social media" },
  { id: "other", label: "Other places" },
] as const satisfies readonly Option[];

export const MEETING_TOOL_OPTIONS = [
  { id: "zoom", label: "Zoom" },
  { id: "meet", label: "Google Meet" },
  { id: "teams", label: "Microsoft Teams" },
  { id: "slack", label: "Slack huddles" },
  { id: "webex", label: "Webex" },
  { id: "inPerson", label: "In person" },
  { id: "other", label: "Something else" },
] as const satisfies readonly Option[];

export const MEETING_PAIN_OPTIONS = [
  { id: "takingNotes", label: "Taking notes while I listen" },
  { id: "remembering", label: "Remembering what was said" },
  { id: "actionItems", label: "Tracking who does what" },
  { id: "sharing", label: "Sharing notes afterwards" },
  { id: "focus", label: "Staying focused" },
  { id: "languages", label: "Meetings in several languages" },
] as const satisfies readonly Option[];

type Ids<T extends readonly Option[]> = [T[number]["id"], ...T[number]["id"][]];
const ids = <T extends readonly Option[]>(list: T) =>
  list.map((o) => o.id) as Ids<T>;

export const HEARD_FROM_IDS = ids(HEARD_FROM_OPTIONS);
export const USE_IDS = ids(USE_OPTIONS);
export const WORK_IDS = ids(WORK_OPTIONS);
export const TYPING_PLACE_IDS = ids(TYPING_PLACE_OPTIONS);
export const MEETING_TOOL_IDS = ids(MEETING_TOOL_OPTIONS);
export const MEETING_PAIN_IDS = ids(MEETING_PAIN_OPTIONS);

/** A list of option ids without repeats (the order given is kept). */
const idList = <T extends [string, ...string[]]>(list: T) =>
  z
    .array(z.enum(list))
    .max(32)
    .default([])
    .transform((a) => [...new Set(a)]);

/** The survey answers, kept in settings.json on this Mac and never sent anywhere. */
export const ProfileSchema = z.object({
  heardFrom: z.enum(HEARD_FROM_IDS).nullable().default(null),
  uses: idList(USE_IDS),
  work: z.enum(WORK_IDS).nullable().default(null),
  typingPlaces: idList(TYPING_PLACE_IDS),
  meetingTools: idList(MEETING_TOOL_IDS),
  meetingPains: idList(MEETING_PAIN_IDS),
  /** When the survey was finished; null until then. */
  completedAt: z.number().int().nonnegative().nullable().default(null),
});
export type Profile = z.infer<typeof ProfileSchema>;

export interface ProfileSuggestions {
  /** Offer Vibe coding (a suggestion only: it reads code near the cursor, so it stays off). */
  vibeCoding: boolean;
  /** Offer the Style page (writing styles for email and messages). */
  styles: boolean;
}

/** What to point the person to; nothing here turns anything on. */
export function profileSuggestions(profile: {
  work: string | null;
  typingPlaces: readonly string[];
}): ProfileSuggestions {
  return {
    vibeCoding:
      profile.work === "developer" || profile.typingPlaces.includes("coding"),
    styles:
      profile.typingPlaces.includes("email") ||
      profile.typingPlaces.includes("messages"),
  };
}

/**
 * The "Set up Notetaker" card shows unless the survey was finished and meetings weren't chosen.
 * An unanswered survey (or a skipped question) keeps the card, as before.
 */
export function showNotetakerSetup(
  profile: Pick<Profile, "uses" | "completedAt">,
): boolean {
  if (profile.completedAt === null || profile.uses.length === 0) return true;
  return profile.uses.includes("notetaker");
}

// ---- Speed result -----------------------------------------------------------------------------

/** An assumed typing speed, not a measurement of the person: used for comparisons only. */
export const ASSUMED_TYPING_WPM = 40;
/** Fewer words or less speech than this is too little to call a speed. */
export const MIN_SPEED_WORDS = 5;
export const MIN_SPEED_SECONDS = 3;

export interface PracticeSample {
  words: number;
  /** Recording length in seconds. */
  seconds: number;
}

export interface SpeakingSpeed {
  /** Words per minute over all samples, rounded; null when there isn't enough to say. */
  wpm: number | null;
  words: number;
  seconds: number;
}

/** Words per minute of speech: total words over total recording time. */
export function speakingSpeed(
  samples: readonly PracticeSample[],
): SpeakingSpeed {
  let words = 0;
  let seconds = 0;
  for (const s of samples) {
    if (!(s.words > 0) || !(s.seconds > 0)) continue;
    words += s.words;
    seconds += s.seconds;
  }
  const enough = words >= MIN_SPEED_WORDS && seconds >= MIN_SPEED_SECONDS;
  return {
    wpm: enough ? Math.round((words / seconds) * 60) : null,
    words,
    seconds,
  };
}

export interface SpeedComparison {
  typingWpm: number;
  speakingWpm: number;
  /** How many times faster speaking is than the assumed typing speed (one decimal). */
  times: number;
}

export function speedComparison(
  speakingWpm: number,
  typingWpm = ASSUMED_TYPING_WPM,
): SpeedComparison {
  return {
    typingWpm,
    speakingWpm,
    times: Math.round((speakingWpm / typingWpm) * 10) / 10,
  };
}

export const MAX_TYPING_HOURS_PER_DAY = 12;
export const WORK_DAYS_PER_WEEK = 5;

export interface TimeSaved {
  /** An estimate: the same words, spoken instead of typed, over a five-day week. */
  hoursPerWeek: number;
  minutesPerWeek: number;
  estimate: true;
}

/**
 * Typing time that speaking would save in a week, from hours of typing per day. The words
 * typed in that time are assumed to be spoken at `speakingWpm`; the result never goes below 0.
 */
export function weeklyTimeSaved(input: {
  typingHoursPerDay: number;
  speakingWpm: number;
  typingWpm?: number;
}): TimeSaved {
  const typingWpm = input.typingWpm ?? ASSUMED_TYPING_WPM;
  const hours = Math.min(
    MAX_TYPING_HOURS_PER_DAY,
    Math.max(
      0,
      Number.isFinite(input.typingHoursPerDay) ? input.typingHoursPerDay : 0,
    ),
  );
  const fraction =
    input.speakingWpm > typingWpm ? 1 - typingWpm / input.speakingWpm : 0;
  const saved = hours * WORK_DAYS_PER_WEEK * fraction;
  return {
    hoursPerWeek: Math.round(saved * 10) / 10,
    minutesPerWeek: Math.round(saved * 60),
    estimate: true,
  };
}

// ---- Hub channels -----------------------------------------------------------------------------

const FieldId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const PracticeFocusSchema = z.object({
  active: z.boolean(),
  fieldId: FieldId,
});
export const WatchShortcutSchema = z.object({ on: z.boolean() });

export interface PracticeTextEvent {
  fieldId: string;
  text: string;
  words: number;
  durationMs: number;
}
export interface ShortcutStateEvent {
  down: boolean;
}

/** What Murmur can say about recording "Your Mac's sound" (used for meeting audio). */
export interface SystemAudioStatus {
  /** "available", "unsupported-os" (needs macOS 14.2) or "missing-usage-description". */
  support: string;
  /** The last Allow attempt on this Mac: macOS offers no way to read it without asking. */
  access: "unknown" | "allowed" | "denied";
  /** Plain-language reason when `access` is "denied" or nothing could be tried. */
  message: string | null;
}
