// Notetaker meetings: local meeting notes in the History database (Stage 9D-1), and a recording
// the person starts, its transcript and an on-request summary (Stage 9D-2). Transcript and summary
// are only ever filled from a real recording and a real AI reply, never with sample content.
import { z } from "zod";

/**
 * "notes": not recorded. "recording" while audio is captured (paused included), "processing"
 * while transcribing, "ready" once the transcript is saved, "failed" when recording or
 * transcription stopped short (the saved audio is kept so it can be transcribed again).
 */
export const MEETING_STATUSES = [
  "notes",
  "recording",
  "processing",
  "ready",
  "failed",
] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export interface Meeting {
  id: string;
  title: string;
  notes: string;
  status: MeetingStatus;
  /** When the meeting took place (you can edit it); null for "not set". */
  startedAt: number | null;
  endedAt: number | null;
  createdAt: number;
  updatedAt: number;
  /** Increases on every notes save; a save based on an older copy is refused. */
  revision: number;
  hasTranscript: boolean;
  hasSummary: boolean;
  transcript: string;
  summary: string;
  /** Recorded time, pauses excluded. */
  recordedMs: number;
  /** Encrypted audio parts kept for transcription (0 once the transcript is saved). */
  audioParts: number;
  /** Whether your Mac's sound was recorded along with the microphone. */
  systemAudio: boolean;
  /** Why recording or transcription stopped short (no transcript or notes text). */
  error: string | null;
  /**
   * Stage 9D-3: the language to transcribe in. null = the dictation language, "" = detect
   * automatically, otherwise a language code.
   */
  language: string | null;
  /** "split": your microphone and your Mac's sound kept apart, for You / Others labels. */
  audioLayout: AudioLayout;
  /** Five-minute batches already transcribed (a retry continues after them). */
  doneBatches: number;
}

export type AudioLayout = "mixed" | "split";

export interface MeetingSummary {
  id: string;
  title: string;
  status: MeetingStatus;
  startedAt: number | null;
  endedAt: number | null;
  createdAt: number;
  updatedAt: number;
  /** The first lines of your notes, for the list. */
  preview: string;
  hasTranscript: boolean;
  hasSummary: boolean;
  recordedMs: number;
}

export const MEETING_TITLE_MAX = 120;
export const MEETING_NOTES_MAX = 500_000;
export const MEETING_SORTS = ["newest", "oldest", "title"] as const;
export type MeetingSort = (typeof MEETING_SORTS)[number];

/** The meeting's time: its start if set, else when it was created. */
export const meetingTime = (m: Pick<Meeting, "startedAt" | "createdAt">) =>
  m.startedAt ?? m.createdAt;

export function meetingDurationMs(
  m: Pick<Meeting, "startedAt" | "endedAt">,
): number | null {
  if (m.startedAt === null || m.endedAt === null) return null;
  return m.endedAt > m.startedAt ? m.endedAt - m.startedAt : null;
}

/** "45 min", "1 h 20 min". */
export function formatMeetingDuration(ms: number | null): string {
  if (ms === null) return "";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

/** A title for a new meeting: "Meeting, Oct 19, 10:30". */
export function defaultMeetingTitle(at: number): string {
  const d = new Date(at);
  return `Meeting, ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

export function meetingPreview(notes: string): string {
  const text = notes
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ");
  return text.length > 140 ? `${text.slice(0, 139).trimEnd()}…` : text;
}

/** Same local calendar day as `now`. */
export function isToday(ts: number, now: Date): boolean {
  return new Date(ts).toDateString() === now.toDateString();
}

/** Markdown for Export: the title, its times, your notes, and the summary and transcript if any. */
export function meetingMarkdown(m: Meeting): string {
  const when = new Date(meetingTime(m));
  const lines = [
    `# ${m.title}`,
    "",
    `${when.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}${
      m.startedAt !== null
        ? `, ${when.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`
        : ""
    }${meetingDurationMs(m) !== null ? ` (${formatMeetingDuration(meetingDurationMs(m))})` : ""}`,
    "",
    "## Notes",
    "",
    m.notes.trim() || "_No notes._",
    "",
  ];
  if (m.hasSummary && m.summary.trim())
    lines.push("## Summary", "", m.summary.trim(), "");
  if (m.hasTranscript)
    lines.push(
      "## Transcript",
      "",
      m.transcript.trim().replace(/^(You|Others): /gm, "**$1:** ") ||
        "_The recording was silent._",
      "",
    );
  return lines.join("\n");
}

/** A file name for Export, without characters file systems reject. */
export function meetingFileName(m: Pick<Meeting, "title">): string {
  const base = m.title
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${base || "Meeting"}.md`;
}

// ---- IPC payloads (validated in the main process) ------------------------------------------------

const Id = z.string().min(1).max(64);
const Time = z.number().int().min(0).max(8_640_000_000_000).nullable();

export const MeetingListSchema = z.object({
  search: z.string().max(200).optional(),
  sort: z.enum(MEETING_SORTS).optional(),
});
export const MeetingCreateSchema = z.object({
  title: z.string().trim().max(MEETING_TITLE_MAX).optional(),
  startedAt: Time.optional(),
});
export const MeetingUpdateSchema = z
  .object({
    id: Id,
    title: z
      .string()
      .trim()
      .min(1, "Give it a title.")
      .max(MEETING_TITLE_MAX)
      .optional(),
    startedAt: Time.optional(),
    endedAt: Time.optional(),
    /** null = the dictation language, "" = detect automatically. */
    language: z
      .string()
      .regex(
        /^([a-z]{2,3}(-[A-Za-z]{2,4})?)?$/,
        "Choose a language from the list.",
      )
      .nullable()
      .optional(),
  })
  .refine(
    (m) =>
      m.startedAt === undefined ||
      m.endedAt === undefined ||
      m.startedAt === null ||
      m.endedAt === null ||
      m.endedAt > m.startedAt,
    { message: "The end has to be after the start." },
  );
export const MeetingNotesSchema = z.object({
  id: Id,
  notes: z.string().max(MEETING_NOTES_MAX),
  revision: z.number().int().min(1),
});
export const MeetingIdSchema = z.object({ id: Id });
export const MeetingDeleteSchema = z.object({
  id: Id,
  confirm: z.literal(true),
});

export type MeetingSaveResult =
  | { ok: true; meeting: Meeting }
  | { ok: false; reason: "conflict"; meeting: Meeting }
  | { ok: false; reason: "missing" };

/** What Set up Notetaker checks (no permission is requested by reading this). */
export interface NotetakerReadiness {
  microphone:
    "granted" | "denied" | "not-determined" | "restricted" | "unknown";
  transcription: { service: string; ready: string | null };
  summary: { service: string; ready: string | null };
  /** Stage 9D-2: whether this app can record your Mac's sound ("available" or why not). */
  systemAudio: string;
}

// ---- Recording (Stage 9D-2) -----------------------------------------------------------------------

/** Maximum recording length choices, in minutes (reference: “Maximum recording length”). */
export const MAX_RECORDING_MINUTES = [30, 60, 120, 240] as const;
export type MaxRecordingMinutes = (typeof MAX_RECORDING_MINUTES)[number];

/** Murmur's side of system audio: on, off in Settings, or unavailable (with why). */
export type SystemAudioState =
  { state: "on" } | { state: "off" } | { state: "unavailable"; reason: string };

/** What the recorder is doing now. Broadcast to the Hub, the Capsule and the menu bar. */
export interface RecordingState {
  meetingId: string | null;
  phase: "idle" | "starting" | "recording" | "paused" | "stopping";
  /** Recorded time so far, pauses excluded. */
  elapsedMs: number;
  maxMs: number;
  systemAudio: SystemAudioState;
  /** Recent levels (RMS, 0–1) for the meters. */
  micLevel: number;
  systemLevel: number;
  /** “Stopping in 1 minute” and similar. */
  warning: string | null;
}

export const IDLE_RECORDING: RecordingState = {
  meetingId: null,
  phase: "idle",
  elapsedMs: 0,
  maxMs: 0,
  systemAudio: { state: "off" },
  micLevel: 0,
  systemLevel: 0,
  warning: null,
};

/** Transcription progress for one meeting (batches of up to five minutes). */
export interface TranscriptionProgress {
  meetingId: string;
  done: number;
  total: number;
}

/** Why your Mac's sound can't be recorded, for the person (support from the native addon). */
export function systemAudioReason(support: string): string {
  if (support === "unsupported-os")
    return "Recording your Mac's sound needs macOS 14.2 or later.";
  if (support === "missing-usage-description")
    return "This build of Murmur can't ask macOS to record your Mac's sound.";
  return "Your Mac's sound can't be recorded here.";
}

/** 12:05 or 1:02:05. */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export const MeetingRecordSchema = z.object({ id: Id });
export const MeetingSummarizeSchema = z.object({
  id: Id,
  requestId: z.string().min(1).max(64),
});
