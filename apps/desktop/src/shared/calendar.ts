// Calendar connection (Settings → Connectors → Calendar): pure logic shared by the main process
// and the Hub. Events come from macOS Calendar through EventKit (Google, Outlook/Exchange and
// iCloud accounts the person added there); they stay on this Mac and are never logged or sent
// anywhere. Unit-tested in test/calendar.test.ts.
import { z } from "zod";
import { defaultMeetingTitle, MEETING_TITLE_MAX } from "./meetings.ts";

/** How far ahead Notetaker lists meetings. */
export const UPCOMING_DAYS = 7;
export const UPCOMING_MAX = 40;
const DAY_MS = 86_400_000;
/** The reminder appears this long before a meeting starts. */
export const REMINDER_LEAD_MS = 60_000;
/** A meeting that started up to this long ago still gets its reminder (a late poll). */
export const REMINDER_GRACE_MS = 30_000;

/** What the Connect row can say (the `calendarSupport` and `calendarAccess` answers combined). */
export type CalendarAccess =
  | "authorized"
  | "not-determined"
  | "denied"
  | "restricted"
  | "write-only"
  | "unsupported-os";
export type CalendarSupport =
  "available" | "unsupported-os" | "missing-usage-description";

export type CalendarAccountKind =
  "google" | "outlook" | "icloud" | "local" | "other";

export const MEETING_SERVICES = ["zoom", "meet", "teams"] as const;
export type MeetingService = (typeof MEETING_SERVICES)[number];
export const MEETING_SERVICE_LABEL: Record<MeetingService, string> = {
  zoom: "Zoom",
  meet: "Google Meet",
  teams: "Microsoft Teams",
};

export const ACCOUNT_KIND_LABEL: Record<CalendarAccountKind, string> = {
  google: "Google",
  outlook: "Outlook / Exchange",
  icloud: "iCloud",
  local: "On this Mac",
  other: "Other",
};

/** One account macOS Calendar shows and how many of its calendars Murmur can read. */
export interface CalendarAccountInfo {
  name: string;
  kind: CalendarAccountKind;
  calendars: number;
}

export interface CalendarStatus {
  support: CalendarSupport;
  access: CalendarAccess;
  /** The person connected Calendar (and macOS still allows it): Murmur reads events. */
  connected: boolean;
  /** Murmur is set to read, whatever macOS says now (shows "needs access again"). */
  enabled: boolean;
  reminders: boolean;
  accounts: CalendarAccountInfo[];
}

/** A meeting as the Hub sees it: no notes, no links, nothing beyond what the list shows. */
export interface UpcomingMeeting {
  /** Identifies this occurrence for “Start Notetaker”. */
  key: string;
  title: string;
  startMs: number;
  endMs: number;
  calendar: string;
  account: string;
  accountKind: CalendarAccountKind;
  location: string | null;
  /** The service of the meeting link in the event, if it has one. */
  service: MeetingService | null;
}

/** An event as the main process holds it (notes and links stay here). */
export interface CalendarEventRecord extends UpcomingMeeting {
  allDay: boolean;
  meetingUrl: string | null;
}

export const StartFromEventSchema = z.object({
  key: z.string().min(1).max(600),
});

/** EventKit's source type and the source's name → the account kind shown in the list. */
export function classifyAccount(
  sourceType: number,
  name: string,
  calendar = "",
): CalendarAccountKind {
  switch (sourceType) {
    case 0:
      return "local";
    case 1:
      return "outlook";
    case 3:
      return "icloud";
    case 2:
      return /google|gmail|googlemail/i.test(`${name} ${calendar}`)
        ? "google"
        : /icloud/i.test(name)
          ? "icloud"
          : "other";
    default:
      return "other";
  }
}

/** Subscribed calendars (holidays, sports) and birthdays are never meetings. */
export function isMeetingSource(sourceType: number): boolean {
  return sourceType !== 4 && sourceType !== 5;
}

export function eventKey(id: string, startMs: number): string {
  return `${id}@${Math.round(startMs)}`;
}

const END = String.raw`[^\s<>"'\])}]+`;
const MEETING_PATTERNS: [MeetingService, RegExp][] = [
  [
    "zoom",
    new RegExp(
      String.raw`https://(?:[a-z0-9-]+\.)*(?:zoom\.us|zoomgov\.com)/(?:j|my|wc/join|s)/${END}`,
      "i",
    ),
  ],
  [
    "meet",
    new RegExp(
      String.raw`https://meet\.google\.com/(?:[a-z]{3}-[a-z]{4}-[a-z]{3}|lookup/${END})(?:\?${END})?`,
      "i",
    ),
  ],
  [
    "teams",
    new RegExp(
      String.raw`https://(?:teams\.microsoft\.com/l/meetup-join/|teams\.live\.com/meet/|teams\.microsoft\.com/meet/)${END}`,
      "i",
    ),
  ],
];

function findMeetingUrl(
  text: string,
): { url: string; service: MeetingService } | null {
  for (const [service, pattern] of MEETING_PATTERNS) {
    const m = pattern.exec(text);
    if (m) return { url: m[0].replace(/[.,;:!?]+$/, ""), service };
  }
  return null;
}

/**
 * The Zoom, Google Meet or Microsoft Teams link of an event: its URL field first, then the
 * location, then the notes (where invitations put it). Links wrapped by a mail scanner
 * (percent-encoded inside another URL) are found too. Only https links count.
 */
export function detectMeetingUrl(fields: {
  url?: string | null;
  location?: string | null;
  notes?: string | null;
}): { url: string; service: MeetingService } | null {
  for (const text of [fields.url, fields.location, fields.notes]) {
    if (!text) continue;
    const direct = findMeetingUrl(text);
    if (direct) return direct;
    if (/%3A%2F%2F/i.test(text)) {
      let decoded: string | null = null;
      try {
        decoded = decodeURIComponent(text);
      } catch {
        decoded = null;
      }
      const wrapped = decoded && findMeetingUrl(decoded);
      if (wrapped) return wrapped;
    }
  }
  return null;
}

/** The meeting's title in Notetaker: the event's title, tidied, or a dated default. */
export function meetingTitleFromEvent(title: string, startMs: number): string {
  const clean = title
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MEETING_TITLE_MAX)
    .trim();
  return clean || defaultMeetingTitle(startMs);
}

/** The time range to read from EventKit for the upcoming list. */
export function upcomingWindow(nowMs: number): {
  fromMs: number;
  toMs: number;
} {
  return { fromMs: nowMs, toMs: nowMs + UPCOMING_DAYS * DAY_MS };
}

/**
 * Meetings still to come in the next seven days (including one that is on now), earliest first:
 * all-day entries (holidays, reminders) and anything that already ended are left out.
 */
export function upcomingMeetings<
  T extends Pick<CalendarEventRecord, "startMs" | "endMs" | "allDay">,
>(events: T[], nowMs: number, max = UPCOMING_MAX): T[] {
  const { toMs } = upcomingWindow(nowMs);
  return events
    .filter((e) => !e.allDay && e.endMs > nowMs && e.startMs <= toMs)
    .sort((a, b) => a.startMs - b.startMs)
    .slice(0, max);
}

/** The Hub's view of an event: the same fields minus anything private to the main process. */
export function toUpcoming(e: CalendarEventRecord): UpcomingMeeting {
  return {
    key: e.key,
    title: e.title,
    startMs: e.startMs,
    endMs: e.endMs,
    calendar: e.calendar,
    account: e.account,
    accountKind: e.accountKind,
    location: e.location,
    service: e.service,
  };
}

/**
 * Meetings with a link whose reminder is due: they start within a minute (or started up to
 * half a minute ago) and weren't reminded about already. Never starts anything.
 */
export function dueReminders<
  T extends Pick<
    CalendarEventRecord,
    "key" | "startMs" | "allDay" | "meetingUrl"
  >,
>(events: T[], nowMs: number, reminded: { has(key: string): boolean }): T[] {
  return events.filter((e) => {
    if (e.allDay || !e.meetingUrl || reminded.has(e.key)) return false;
    const until = e.startMs - nowMs;
    return until <= REMINDER_LEAD_MS && until > -REMINDER_GRACE_MS;
  });
}

/** The reminder's text: the notification title and its question. */
export function reminderText(title: string): { title: string; body: string } {
  return { title: `Meeting starting: ${title}`, body: "Start Notetaker?" };
}

/** The Murmur bar's short line (the Capsule keeps messages short). */
export const REMINDER_BAR_MESSAGE = "Meeting soon — open Notetaker";

/** Short time label for the list: “2:30 PM – 3:00 PM”. */
export function timeRangeLabel(startMs: number, endMs: number): string {
  const t = (ms: number) =>
    new Date(ms).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
  return `${t(startMs)} – ${t(endMs)}`;
}

/** “Today”, “Tomorrow” or a weekday and date, for grouping the list. */
export function dayLabel(ms: number, nowMs: number): string {
  const day = (v: number) => {
    const d = new Date(v);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const diff = Math.round((day(ms) - day(nowMs)) / DAY_MS);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return new Date(ms).toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

/** What Connect can do in each state, in words (the Connectors row shows it). */
export function calendarStateText(s: CalendarStatus): string {
  if (s.connected) return "Connected";
  if (s.support === "unsupported-os")
    return "Needs macOS 14 or later to read your calendars.";
  if (s.enabled && s.access !== "authorized")
    return "macOS no longer lets Murmur read your calendars.";
  if (s.access === "denied" || s.access === "restricted")
    return "Calendar access is off for Murmur in macOS.";
  if (s.access === "write-only")
    return "macOS only lets Murmur add events. Allow full access in System Settings.";
  return "Not connected";
}
