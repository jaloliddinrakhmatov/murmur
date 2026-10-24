import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyPatch,
  DEFAULT_SETTINGS,
  parseSettingsPatch,
  type Settings,
} from "../src/shared/settings.ts";
import {
  calendarStateText,
  classifyAccount,
  detectMeetingUrl,
  dueReminders,
  eventKey,
  meetingTitleFromEvent,
  REMINDER_BAR_MESSAGE,
  reminderText,
  toUpcoming,
  upcomingMeetings,
  UPCOMING_DAYS,
  type CalendarEventRecord,
  type CalendarStatus,
} from "../src/shared/calendar.ts";
import { calendarRowView } from "../src/renderer/hub/model/connectors.ts";
import { CalendarService } from "../src/main/connectors/calendar.ts";
import type { NativeCalendarEvent } from "../src/main/native/addon.ts";
import { CAPSULE_MESSAGE_MAX } from "../src/main/core/controller.ts";

const MIN = 60_000;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);

test("connectors are off by default", () => {
  assert.deepEqual(DEFAULT_SETTINGS.connectors, {
    calendar: { enabled: false, reminders: false },
  });
});

test("a connectors patch keeps its sibling fields", () => {
  const on: Settings = applyPatch(
    DEFAULT_SETTINGS,
    parseSettingsPatch({ connectors: { calendar: { enabled: true } } }),
  );
  const next = applyPatch(
    on,
    parseSettingsPatch({ connectors: { calendar: { reminders: true } } }),
  );
  assert.deepEqual(next.connectors.calendar, {
    enabled: true,
    reminders: true,
  });
  assert.deepEqual(
    parseSettingsPatch({ connectors: { calendar: { reminders: true } } }),
    { connectors: { calendar: { reminders: true } } },
  );
});

test("detects Zoom, Meet and Teams links", () => {
  assert.deepEqual(
    detectMeetingUrl({
      notes: "Join: https://acme.zoom.us/j/123456789?pwd=abc.",
    }),
    { url: "https://acme.zoom.us/j/123456789?pwd=abc", service: "zoom" },
  );
  assert.equal(
    detectMeetingUrl({ location: "https://meet.google.com/abc-defg-hij" })
      ?.service,
    "meet",
  );
  assert.equal(
    detectMeetingUrl({
      notes:
        "<https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0?context=1>",
    })?.service,
    "teams",
  );
  // The URL field wins over the notes.
  assert.equal(
    detectMeetingUrl({
      url: "https://meet.google.com/abc-defg-hij",
      notes: "https://zoom.us/j/1",
    })?.service,
    "meet",
  );
});

test("finds a link wrapped by a mail scanner and ignores look-alikes", () => {
  const wrapped =
    "https://nam.safelinks.protection.outlook.com/?url=https%3A%2F%2Fteams.microsoft.com%2Fl%2Fmeetup-join%2Fabc&data=1";
  assert.equal(detectMeetingUrl({ notes: wrapped })?.service, "teams");
  assert.equal(detectMeetingUrl({ notes: "http://zoom.us/j/1" }), null);
  assert.equal(
    detectMeetingUrl({ notes: "https://notzoom.us.evil.example/j/1" }),
    null,
  );
  assert.equal(detectMeetingUrl({ notes: "Room 4, bring snacks" }), null);
  assert.equal(detectMeetingUrl({}), null);
});

test("account kinds follow EventKit's source", () => {
  assert.equal(classifyAccount(1, "Exchange"), "outlook");
  assert.equal(classifyAccount(3, "iCloud"), "icloud");
  assert.equal(classifyAccount(2, "Google"), "google");
  assert.equal(classifyAccount(2, "a@gmail.com"), "google");
  assert.equal(classifyAccount(2, "Fastmail"), "other");
  assert.equal(classifyAccount(0, "On My Mac"), "local");
});

test("the meeting title comes from the event, tidied", () => {
  assert.equal(
    meetingTitleFromEvent("  Weekly\n sync\t\u0007 ", NOW),
    "Weekly sync",
  );
  assert.equal(meetingTitleFromEvent("x".repeat(500), NOW).length, 120);
  assert.match(meetingTitleFromEvent("   ", NOW), /^Meeting, /);
});

const record = (
  id: string,
  startMs: number,
  extra: Partial<CalendarEventRecord> = {},
): CalendarEventRecord => ({
  key: eventKey(id, startMs),
  title: id,
  startMs,
  endMs: startMs + 30 * MIN,
  allDay: false,
  calendar: "Work",
  account: "Google",
  accountKind: "google",
  location: null,
  service: null,
  meetingUrl: null,
  ...extra,
});

test("the upcoming list holds the next seven days, earliest first", () => {
  const list = upcomingMeetings(
    [
      record("later", NOW + 2 * DAY),
      record("ended", NOW - 2 * 60 * MIN),
      record("now", NOW - 10 * MIN),
      record("allday", NOW, { allDay: true }),
      record("too-far", NOW + (UPCOMING_DAYS + 1) * DAY),
      record("soon", NOW + 5 * MIN),
    ],
    NOW,
  );
  assert.deepEqual(
    list.map((e) => e.title),
    ["now", "soon", "later"],
  );
  assert.equal(upcomingMeetings(list, NOW, 2).length, 2);
});

test("the Hub's view of an event has no link", () => {
  const e = record("a", NOW, {
    service: "zoom",
    meetingUrl: "https://zoom.us/j/1",
  });
  assert.equal("meetingUrl" in toUpcoming(e), false);
  assert.equal("allDay" in toUpcoming(e), false);
});

test("reminders are due a minute before, once, and only for meetings with a link", () => {
  const linked = (id: string, startMs: number) =>
    record(id, startMs, { meetingUrl: "https://zoom.us/j/1", service: "zoom" });
  const events = [
    linked("far", NOW + 5 * MIN),
    linked("soon", NOW + 45_000),
    linked("started", NOW - 10_000),
    linked("long-ago", NOW - 2 * MIN),
    record("no-link", NOW + 30_000),
  ];
  const due = dueReminders(events, NOW, new Set());
  assert.deepEqual(
    due.map((e) => e.title),
    ["soon", "started"],
  );
  assert.deepEqual(
    dueReminders(events, NOW, new Set([events[1].key])).map((e) => e.title),
    ["started"],
  );
});

test("the reminder asks a question and the bar line fits the Capsule", () => {
  assert.deepEqual(reminderText("Design review"), {
    title: "Meeting starting: Design review",
    body: "Start Notetaker?",
  });
  assert.ok([...REMINDER_BAR_MESSAGE].length <= CAPSULE_MESSAGE_MAX);
});

const status = (over: Partial<CalendarStatus> = {}): CalendarStatus => ({
  support: "available",
  access: "not-determined",
  connected: false,
  enabled: false,
  reminders: false,
  accounts: [],
  ...over,
});

test("the Calendar row offers what each state allows", () => {
  assert.equal(calendarRowView(status()).action, "connect");
  const connected = calendarRowView(
    status({ access: "authorized", enabled: true, connected: true }),
  );
  assert.equal(connected.action, "disconnect");
  assert.match(connected.note ?? "", /can't take back/);
  const dev = calendarRowView(status({ support: "missing-usage-description" }));
  assert.equal(dev.action, "none");
  assert.match(dev.text, /installed/);
  const denied = calendarRowView(status({ access: "denied" }));
  assert.equal(denied.action, "connect");
  assert.equal(denied.showSystemSettings, true);
  assert.equal(
    calendarRowView(
      status({ support: "unsupported-os", access: "unsupported-os" }),
    ).action,
    "none",
  );
  assert.match(
    calendarStateText(status({ access: "authorized", enabled: true })),
    /Not connected|no longer/,
  );
});

// ---- The service with a fake EventKit --------------------------------------------------------

function nativeEvent(
  id: string,
  startMs: number,
  extra: Partial<NativeCalendarEvent> = {},
): NativeCalendarEvent {
  return {
    id,
    title: id,
    startMs,
    endMs: startMs + 30 * MIN,
    allDay: false,
    calendar: "Work",
    account: "Google",
    sourceType: 2,
    ...extra,
  };
}

function harness(opts: {
  access?: string;
  support?: string;
  events?: NativeCalendarEvent[];
  recording?: boolean;
}) {
  let settings: Settings = DEFAULT_SETTINGS;
  let access = opts.access ?? "not-determined";
  const calls = {
    request: 0,
    list: 0,
    started: [] as string[],
    notices: [] as string[],
  };
  let now = NOW;
  const service = new CalendarService({
    native: {
      calendarAccess: () => access,
      calendarSupport: () => opts.support ?? "available",
      requestCalendarAccess: async () => {
        calls.request++;
        access = "authorized";
        return access;
      },
      listUpcomingEvents: async () => {
        calls.list++;
        return opts.events ?? [];
      },
      listCalendars: async () => [
        { title: "Work", account: "Google", sourceType: 2 },
        { title: "Home", account: "Google", sourceType: 2 },
        { title: "Holidays", account: "Subscribed", sourceType: 4 },
        { title: "Personal", account: "iCloud", sourceType: 3 },
      ],
    },
    settings: {
      get: () => settings,
      update: (p) => (settings = applyPatch(settings, parseSettingsPatch(p))),
    },
    startNotetaker: async ({ title }) => {
      calls.started.push(title);
      return { id: "m1", title } as never;
    },
    recording: () => opts.recording ?? false,
    notify: (n) => calls.notices.push(n.title),
    log: () => {},
    now: () => now,
  });
  return {
    service,
    calls,
    settings: () => settings,
    setNow: (v: number) => (now = v),
  };
}

test("reading stays off until Connect, and nothing is listed before", async () => {
  const h = harness({
    access: "authorized",
    events: [nativeEvent("a", NOW + MIN)],
  });
  assert.deepEqual(await h.service.upcoming(), []);
  assert.equal(h.calls.list, 0);
  assert.equal((await h.service.status()).connected, false);
});

test("Connect asks macOS only when it hasn't been asked, then turns reading on", async () => {
  const h = harness({
    events: [
      nativeEvent("Standup", NOW + 10 * MIN, { notes: "https://zoom.us/j/9" }),
    ],
  });
  const s = await h.service.connect();
  assert.equal(h.calls.request, 1);
  assert.equal(s.connected, true);
  assert.deepEqual(
    s.accounts.map((a) => [a.name, a.kind, a.calendars]),
    [
      ["Google", "google", 2],
      ["iCloud", "icloud", 1],
    ],
  );
  const up = await h.service.upcoming();
  assert.equal(up.length, 1);
  assert.equal(up[0].service, "zoom");
});

test("Connect never prompts in a build without the usage description", async () => {
  const h = harness({ support: "missing-usage-description" });
  const s = await h.service.connect();
  assert.equal(h.calls.request, 0);
  assert.equal(s.connected, false);
  assert.equal(h.settings().connectors.calendar.enabled, false);
});

test("Connect does not turn reading on when macOS says no", async () => {
  const h = harness({ access: "denied" });
  const s = await h.service.connect();
  assert.equal(h.calls.request, 0);
  assert.equal(s.connected, false);
  assert.equal(h.settings().connectors.calendar.enabled, false);
});

test("Disconnect stops reading and keeps the rest of the settings", async () => {
  const h = harness({
    access: "authorized",
    events: [nativeEvent("a", NOW + MIN)],
  });
  await h.service.connect();
  await h.service.upcoming();
  const listed = h.calls.list;
  const s = await h.service.disconnect();
  assert.equal(s.connected, false);
  assert.deepEqual(await h.service.upcoming(), []);
  assert.equal(h.calls.list, listed);
  h.service.dispose();
});

test("subscribed calendars and all-day events are left out", async () => {
  const h = harness({
    access: "authorized",
    events: [
      nativeEvent("holiday", NOW + MIN, { sourceType: 4 }),
      nativeEvent("allday", NOW + MIN, { allDay: true }),
      nativeEvent("real", NOW + 2 * MIN),
    ],
  });
  await h.service.connect();
  assert.deepEqual(
    (await h.service.upcoming()).map((m) => m.title),
    ["real"],
  );
});

test("Start Notetaker on an event uses its title, and only for a known event", async () => {
  const h = harness({
    access: "authorized",
    events: [nativeEvent("Design review", NOW + 5 * MIN)],
  });
  await h.service.connect();
  const [m] = await h.service.upcoming();
  await h.service.startFromEvent({ key: m.key });
  assert.deepEqual(h.calls.started, ["Design review"]);
  await assert.rejects(
    h.service.startFromEvent({ key: "nope@1" }),
    /no longer/,
  );
  await assert.rejects(h.service.startFromEvent({}));
});

test("a reminder is shown once, never starts a recording, and waits for the setting", async () => {
  const h = harness({
    access: "authorized",
    events: [
      nativeEvent("Sync", NOW + 40_000, {
        notes: "https://meet.google.com/abc-defg-hij",
      }),
      nativeEvent("No link", NOW + 40_000),
    ],
  });
  await h.service.connect();
  assert.equal(
    await h.service.checkReminders(),
    0,
    "reminders are off by default",
  );
  h.service["d"].settings.update({
    connectors: { calendar: { reminders: true } },
  });
  assert.equal(await h.service.checkReminders(), 1);
  assert.deepEqual(h.calls.notices, ["Meeting starting: Sync"]);
  assert.equal(await h.service.checkReminders(), 0, "only once");
  assert.deepEqual(h.calls.started, []);
  h.service.dispose();
});

test("reminded entries are forgotten after a day, so the set doesn't grow forever", async () => {
  const h = harness({
    access: "authorized",
    events: [nativeEvent("Sync", NOW + 40_000, { url: "https://zoom.us/j/1" })],
  });
  await h.service.connect();
  h.service["d"].settings.update({
    connectors: { calendar: { reminders: true } },
  });
  assert.equal(await h.service.checkReminders(), 1);
  assert.equal(h.service["reminded"].size, 1);
  h.setNow(NOW + 25 * 60 * MIN);
  await h.service.checkReminders();
  assert.equal(h.service["reminded"].size, 0);
  h.service.dispose();
});

test("no reminder while a meeting is being recorded", async () => {
  const h = harness({
    access: "authorized",
    recording: true,
    events: [nativeEvent("Sync", NOW + 40_000, { url: "https://zoom.us/j/1" })],
  });
  await h.service.connect();
  h.service["d"].settings.update({
    connectors: { calendar: { reminders: true } },
  });
  assert.equal(await h.service.checkReminders(), 0);
  h.service.dispose();
});
