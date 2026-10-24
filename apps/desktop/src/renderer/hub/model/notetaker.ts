// Notetaker page logic (Stage 9D-1), kept out of the components so it can be unit-tested: the
// Today split, list times, the meeting-time fields, the setup steps and the sidebar card, the
// retention preview, and the notes autosave (the Scratchpad Autosaver over a meeting).
import {
  isToday,
  meetingTime,
  type Meeting,
  type MeetingSaveResult,
  type MeetingSummary,
} from "../../../shared/meetings.ts";
import type { Note } from "../../../shared/notes.ts";
import type { NoteStore } from "./scratchpad.ts";
import type { Settings } from "../../../shared/settings.ts";
import { languageName, languagesFor } from "./languages.ts";

/** Today's meetings (for the Today card), oldest first like an agenda. */
export function todaysMeetings(
  meetings: MeetingSummary[],
  now: Date,
): MeetingSummary[] {
  return meetings
    .filter((m) => isToday(meetingTime(m), now))
    .sort((a, b) => meetingTime(a) - meetingTime(b));
}

const time = (d: Date) =>
  d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** "10:30", "Yesterday, 10:30", "Oct 3, 10:30", "Oct 3, 2025" (no time when it isn't set). */
export function meetingWhen(
  m: Pick<MeetingSummary, "startedAt" | "createdAt">,
  now: Date,
): string {
  const d = new Date(meetingTime(m));
  const withTime = m.startedAt !== null;
  if (d.toDateString() === now.toDateString())
    return withTime ? time(d) : "Today";
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString())
    return withTime ? `Yesterday, ${time(d)}` : "Yesterday";
  const date = d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
  return withTime ? `${date}, ${time(d)}` : date;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A timestamp as the value of an <input type="datetime-local"> (local time); "" for none. */
export function toLocalInput(ts: number | null): string {
  if (ts === null) return "";
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The value of a datetime-local input as a timestamp; null when empty or invalid. */
export function fromLocalInput(value: string): number | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const d = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
  );
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/** Problem with an edited start and end, or null when they can be saved. */
export function meetingTimesIssue(
  startedAt: number | null,
  endedAt: number | null,
): string | null {
  if (endedAt !== null && startedAt === null)
    return "Set when it started first.";
  if (startedAt !== null && endedAt !== null && endedAt <= startedAt)
    return "The end has to be after the start.";
  return null;
}

/** How many meetings "Keep meetings for" would delete now (0 = keep until you delete them). */
export function meetingsPastRetention(
  meetings: Pick<MeetingSummary, "startedAt" | "createdAt">[],
  days: number,
  now: number,
): number {
  if (!days) return 0;
  const before = now - days * 86_400_000;
  return meetings.filter((m) => meetingTime(m) < before).length;
}

export const RETENTION_OPTIONS = [
  { days: 0, label: "Until I delete them" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "1 year" },
] as const;
export type RetentionDays = (typeof RETENTION_OPTIONS)[number]["days"];

export const isRetentionDays = (n: number): n is RetentionDays =>
  RETENTION_OPTIONS.some((o) => o.days === n);

/** Set up Notetaker, in order. */
export const SETUP_STEPS = [
  { id: "about", title: "Meet Notetaker" },
  { id: "audio", title: "What Notetaker can hear" },
  { id: "microphone", title: "Microphone" },
  { id: "storage", title: "Where meetings are kept" },
  { id: "services", title: "Transcripts and summaries" },
  { id: "privacy", title: "Recording other people" },
] as const;
export type SetupStepId = (typeof SETUP_STEPS)[number]["id"];

/** The sidebar card: setup, then a first meeting note; hidden when both are done or dismissed. */
export function notetakerChecklist(
  notetaker: { setupCompleted: boolean; setupCardDismissed: boolean },
  meetingCount: number,
): {
  visible: boolean;
  done: number;
  steps: { key: "setup" | "note"; label: string; done: boolean }[];
} {
  const steps = [
    {
      key: "setup" as const,
      label: "Set up Notetaker",
      done: notetaker.setupCompleted,
    },
    {
      key: "note" as const,
      label: "Write your first meeting note",
      done: meetingCount > 0,
    },
  ];
  const done = steps.filter((s) => s.done).length;
  return {
    visible: !notetaker.setupCardDismissed && done < steps.length,
    done,
    steps,
  };
}

/** A meeting in the Note shape the Scratchpad Autosaver works with (body = your notes). */
export function meetingAsNote(m: Meeting): Note {
  return {
    id: m.id,
    title: m.title,
    body: m.notes,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    openedAt: m.updatedAt,
    revision: m.revision,
  };
}

/**
 * Autosave storage for one meeting's notes. A meeting always exists before its notes are
 * edited, so `create` is never used; the latest saved meeting is passed to `onSaved`.
 */
export function meetingNotesStore(
  save: (
    id: string,
    notes: string,
    revision: number,
  ) => Promise<MeetingSaveResult>,
  onSaved: (m: Meeting) => void,
): NoteStore {
  return {
    create: () => Promise.reject(new Error("This meeting no longer exists.")),
    save: async (id, body, revision) => {
      const r = await save(id, body, revision);
      if (r.ok) {
        onSaved(r.meeting);
        return { ok: true, note: meetingAsNote(r.meeting) };
      }
      if (r.reason === "conflict")
        return {
          ok: false,
          reason: "conflict",
          note: meetingAsNote(r.meeting),
        };
      return { ok: false, reason: "missing" };
    },
  };
}

/**
 * The Language menu of a meeting (Stage 9D-3): the dictation language (null), automatic
 * detection (""), or a language the transcription service accepts. A code no longer offered
 * (the service was changed) stays listed so the menu always shows the meeting's choice.
 */
export function meetingLanguageOptions(
  provider: Settings["speech"]["provider"],
  dictationLanguage: string,
  current: string | null,
): { value: string; label: string }[] {
  const offered = languagesFor(provider);
  const options = [
    {
      value: LANGUAGE_DICTATION,
      label: `Same as dictation (${languageName(dictationLanguage)})`,
    },
    { value: LANGUAGE_AUTO, label: "Detect automatically" },
    ...offered.map((l) => ({ value: l.code, label: l.name })),
  ];
  if (current && !offered.some((l) => l.code === current))
    options.push({ value: current, label: languageName(current) });
  return options;
}

const LANGUAGE_DICTATION = "dictation";
const LANGUAGE_AUTO = "auto";

/** A meeting's language as the menu's value, and back. */
export const languageToOption = (language: string | null): string =>
  language === null ? LANGUAGE_DICTATION : language || LANGUAGE_AUTO;
export const optionToLanguage = (value: string): string | null =>
  value === LANGUAGE_DICTATION ? null : value === LANGUAGE_AUTO ? "" : value;

/** A labelled transcript's lines (“You: …”, “Others: …”), or null for a plain one. */
export function speakerLines(
  transcript: string,
): { speaker: "You" | "Others"; text: string }[] | null {
  const lines = transcript.split("\n").filter((l) => l.trim());
  const parsed = lines.map((l) => /^(You|Others): (.*)$/.exec(l));
  if (!parsed.length || parsed.some((p) => !p)) return null;
  return parsed.map((p) => ({
    speaker: p![1] as "You" | "Others",
    text: p![2],
  }));
}

/**
 * Savers with notes still waiting for their autosave timer. On quit the main process asks the
 * page to store them all; a failing saver never stops the others.
 */
export class PendingSaves {
  private readonly savers = new Set<() => Promise<void>>();

  add(flush: () => Promise<void>): () => void {
    this.savers.add(flush);
    return () => void this.savers.delete(flush);
  }

  async flushAll(): Promise<void> {
    await Promise.allSettled([...this.savers].map((flush) => flush()));
  }
}

export const pendingSaves = new PendingSaves();
