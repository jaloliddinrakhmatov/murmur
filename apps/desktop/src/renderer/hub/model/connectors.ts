// What the Connectors → Calendar row shows and does for each state (pure; unit-tested in
// test/calendar.test.ts).
import {
  calendarStateText,
  type CalendarStatus,
} from "../../../shared/calendar.ts";

export interface CalendarRowView {
  /** The row's main button: Connect, Disconnect or nothing. */
  action: "connect" | "disconnect" | "none";
  /** Whether the status line is a problem (macOS refuses) rather than a plain state. */
  tone: "success" | "neutral" | "warning";
  text: string;
  /** Extra explanation under the row, or null. */
  note: string | null;
  /** A link to System Settings → Privacy → Calendars helps here. */
  showSystemSettings: boolean;
}

export const DISCONNECT_NOTE =
  "Disconnect stops Murmur reading your calendars. It can't take back the access macOS gave Murmur: to do that, turn Murmur off under Privacy & Security → Calendars in System Settings.";

export function calendarRowView(s: CalendarStatus): CalendarRowView {
  const text = calendarStateText(s);
  if (s.connected)
    return {
      action: "disconnect",
      tone: "success",
      text,
      note: DISCONNECT_NOTE,
      showSystemSettings: true,
    };
  if (s.support === "unsupported-os")
    return {
      action: "none",
      tone: "neutral",
      text,
      note: null,
      showSystemSettings: false,
    };
  if (
    s.access === "denied" ||
    s.access === "restricted" ||
    s.access === "write-only" ||
    (s.enabled && s.access !== "authorized")
  )
    return {
      action: "connect",
      tone: "warning",
      text,
      note: "Turn Murmur on under Privacy & Security → Calendars in System Settings, then press Connect.",
      showSystemSettings: true,
    };
  if (
    s.access === "not-determined" &&
    s.support === "missing-usage-description"
  )
    return {
      action: "none",
      tone: "neutral",
      text: "Works in the installed Murmur app",
      note: "This development build can't ask macOS for calendar access. The installed app can.",
      showSystemSettings: false,
    };
  return {
    action: "connect",
    tone: "neutral",
    text,
    note: null,
    showSystemSettings: false,
  };
}

/** Authorized by macOS before (say, by an earlier install) but not connected in Murmur: Connect needs no prompt. */
export function connectAsksMacOS(s: CalendarStatus): boolean {
  return s.access === "not-determined";
}
