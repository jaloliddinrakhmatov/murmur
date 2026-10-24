// Settings → Connectors → Calendar: reads events from macOS Calendar (EventKit), so the Google,
// Outlook/Exchange and iCloud calendars the person added there work without any OAuth app.
//
// Privacy: events stay in this process's memory (a short cache); only counts are logged; nothing
// is sent anywhere. Reading happens only while Calendar is connected and a page or a reminder
// needs it. macOS permission is asked for only in `connect()`, which runs on the person's click.
// A reminder never starts a recording: it only says a meeting is starting.
import type {
  NativeCalendarEvent,
  NativeCalendarInfo,
} from "../native/addon.ts";
import type { Meeting } from "../../shared/meetings.ts";
import type { Settings } from "../../shared/settings.ts";
import {
  classifyAccount,
  detectMeetingUrl,
  dueReminders,
  eventKey,
  isMeetingSource,
  meetingTitleFromEvent,
  reminderText,
  StartFromEventSchema,
  toUpcoming,
  upcomingMeetings,
  upcomingWindow,
  UPCOMING_MAX,
  type CalendarAccess,
  type CalendarAccountInfo,
  type CalendarEventRecord,
  type CalendarStatus,
  type CalendarSupport,
  type UpcomingMeeting,
} from "../../shared/calendar.ts";

/** The part of the native addon this service uses. */
/** A reminder only matters near the start; a day later the entry can go. */
const REMINDED_KEEP_MS = 24 * 60 * 60_000;

export interface NativeCalendar {
  calendarAccess(): string;
  calendarSupport(): string;
  requestCalendarAccess(): Promise<string>;
  listUpcomingEvents(
    fromMs: number,
    toMs: number,
    max: number,
  ): Promise<NativeCalendarEvent[]>;
  listCalendars(): Promise<NativeCalendarInfo[]>;
}

export interface CalendarDeps {
  native: NativeCalendar;
  settings: {
    get(): Settings;
    update(patch: unknown): Settings;
  };
  /** Starts a recorded meeting through NotetakerService (its setup and consent checks apply). */
  startNotetaker: (input: { title: string }) => Promise<Meeting>;
  /** A meeting recording is running: no reminder then. */
  recording: () => boolean;
  /** Shows the reminder (Murmur bar and a notification). Must not start anything. */
  notify: (n: { title: string; body: string }) => void;
  log: (event: string, data?: Record<string, unknown>) => void;
  now?: () => number;
  /** Poll interval of the reminder timer. */
  reminderPollMs?: number;
}

const CACHE_MS = 20_000;
const ACCESS_VALUES: readonly string[] = [
  "authorized",
  "not-determined",
  "denied",
  "restricted",
  "write-only",
  "unsupported-os",
];

export class CalendarService {
  private readonly d: CalendarDeps;
  private cache: { at: number; events: CalendarEventRecord[] } | null = null;
  private inflight: Promise<CalendarEventRecord[]> | null = null;
  /** Event keys already reminded about, with when; forgotten after a day (see REMINDED_KEEP_MS). */
  private readonly reminded = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: CalendarDeps) {
    this.d = deps;
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private access(): CalendarAccess {
    const a = this.d.native.calendarAccess();
    return (ACCESS_VALUES.includes(a) ? a : "denied") as CalendarAccess;
  }

  private support(): CalendarSupport {
    return this.d.native.calendarSupport() as CalendarSupport;
  }

  /** Murmur is set to read and macOS allows it. */
  private connected(): boolean {
    return (
      this.d.settings.get().connectors.calendar.enabled &&
      this.access() === "authorized"
    );
  }

  async status(): Promise<CalendarStatus> {
    const c = this.d.settings.get().connectors.calendar;
    const access = this.access();
    const connected = c.enabled && access === "authorized";
    return {
      support: this.support(),
      access,
      connected,
      enabled: c.enabled,
      reminders: c.reminders,
      accounts: connected ? await this.accounts() : [],
    };
  }

  private async accounts(): Promise<CalendarAccountInfo[]> {
    try {
      const calendars = await this.d.native.listCalendars();
      const byName = new Map<string, CalendarAccountInfo>();
      for (const c of calendars) {
        if (!isMeetingSource(c.sourceType)) continue;
        const name = c.account || "Calendar";
        const known = byName.get(name);
        if (known) known.calendars++;
        else
          byName.set(name, {
            name,
            kind: classifyAccount(c.sourceType, c.account, c.title),
            calendars: 1,
          });
      }
      return [...byName.values()];
    } catch {
      return [];
    }
  }

  /**
   * Connect: asks macOS for access when it hasn't been asked (the person's click), then turns
   * reading on only if access was granted. Never prompts where the app can't (dev builds).
   */
  async connect(): Promise<CalendarStatus> {
    let access = this.access();
    if (access === "not-determined" && this.support() === "available") {
      try {
        const answered = await this.d.native.requestCalendarAccess();
        access = (
          ACCESS_VALUES.includes(answered) ? answered : this.access()
        ) as CalendarAccess;
      } catch (err) {
        this.d.log("calendar.connect.refused", {
          error: (err as Error).message,
        });
      }
    }
    if (access === "authorized") {
      this.d.settings.update({ connectors: { calendar: { enabled: true } } });
      this.d.log("calendar.connected");
    } else this.d.log("calendar.connect.unavailable", { access });
    this.sync();
    return this.status();
  }

  /** Murmur stops reading. macOS's permission stays; only System Settings can revoke it. */
  async disconnect(): Promise<CalendarStatus> {
    this.d.settings.update({ connectors: { calendar: { enabled: false } } });
    this.cache = null;
    this.reminded.clear();
    this.d.log("calendar.disconnected");
    this.sync();
    return this.status();
  }

  /** Events of the next seven days, loaded when connected (a short cache and one request at a time). */
  private async events(fresh = false): Promise<CalendarEventRecord[]> {
    if (!this.connected()) return [];
    const now = this.now();
    if (!fresh && this.cache && now - this.cache.at < CACHE_MS)
      return this.cache.events;
    this.inflight ??= (async () => {
      try {
        const { fromMs, toMs } = upcomingWindow(now);
        const raw = await this.d.native.listUpcomingEvents(
          fromMs,
          toMs,
          UPCOMING_MAX * 4,
        );
        const events = upcomingMeetings(
          raw.filter((e) => isMeetingSource(e.sourceType)).map(toRecord),
          now,
        );
        this.cache = { at: this.now(), events };
        this.d.log("calendar.events", { count: events.length });
        return events;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  async upcoming(fresh = false): Promise<UpcomingMeeting[]> {
    try {
      return (await this.events(fresh)).map(toUpcoming);
    } catch (err) {
      this.d.log("calendar.events.failed", { error: (err as Error).message });
      throw new Error("Couldn't read your calendars. Try again.");
    }
  }

  /** “Start Notetaker” on an event: a meeting titled from it, through the normal start path. */
  async startFromEvent(input: unknown): Promise<Meeting> {
    const { key } = StartFromEventSchema.parse(input);
    const event = (await this.events(true)).find((e) => e.key === key);
    if (!event) throw new Error("That event is no longer on your calendar.");
    return this.d.startNotetaker({
      title: meetingTitleFromEvent(event.title, event.startMs),
    });
  }

  // ---- Reminders -------------------------------------------------------------------------------

  /** Starts or stops the reminder timer to match the settings (call after any settings change). */
  sync(): void {
    const c = this.d.settings.get().connectors.calendar;
    const want = c.enabled && c.reminders;
    if (want && !this.timer) {
      this.timer = setInterval(
        () => void this.checkReminders(),
        this.d.reminderPollMs ?? 15_000,
      );
      this.timer.unref?.();
    } else if (!want && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One reminder pass (the timer's tick; exposed for tests). Returns how many were shown. */
  async checkReminders(): Promise<number> {
    const c = this.d.settings.get().connectors.calendar;
    if (!c.reminders || this.d.recording()) return 0;
    let events: CalendarEventRecord[];
    try {
      events = await this.events();
    } catch {
      return 0;
    }
    const now = this.now();
    for (const [key, at] of this.reminded)
      if (now - at > REMINDED_KEEP_MS) this.reminded.delete(key);
    const due = dueReminders(events, now, this.reminded);
    for (const e of due) {
      this.reminded.set(e.key, now);
      this.d.notify(reminderText(e.title));
    }
    if (due.length) this.d.log("calendar.reminder", { count: due.length });
    return due.length;
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

function toRecord(e: NativeCalendarEvent): CalendarEventRecord {
  const link = detectMeetingUrl({
    url: e.url,
    location: e.location,
    notes: e.notes,
  });
  return {
    key: eventKey(e.id, e.startMs),
    title: e.title.trim() || "Untitled event",
    startMs: e.startMs,
    endMs: e.endMs,
    allDay: e.allDay,
    calendar: e.calendar,
    account: e.account,
    accountKind: classifyAccount(e.sourceType, e.account, e.calendar),
    location: e.location?.trim() || null,
    service: link?.service ?? null,
    meetingUrl: link?.url ?? null,
  };
}
