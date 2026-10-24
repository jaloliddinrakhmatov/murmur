// The Hub's Connectors channels (calendar). Only the Hub page may call them; connecting is the
// one call that can show a macOS prompt and the page sends it only from the Connect button.
import { ipcMain } from "electron";
import type { CalendarService } from "../connectors/calendar.ts";
import { fromHub } from "./hub.ts";

export function registerConnectorsIpc(calendar: CalendarService): void {
  const handle = (channel: string, fn: (input: unknown) => unknown) =>
    ipcMain.handle(channel, (e, input: unknown) => {
      if (!fromHub(e)) throw new Error("not allowed");
      return fn(input);
    });
  handle("hub:calendarStatus", () => calendar.status());
  handle("hub:connectCalendar", () => calendar.connect());
  handle("hub:disconnectCalendar", () => calendar.disconnect());
  handle("hub:upcomingMeetings", (input) =>
    calendar.upcoming(
      Boolean((input as { fresh?: unknown } | null | undefined)?.fresh),
    ),
  );
  handle("hub:startNotetakerFromEvent", (input) =>
    calendar.startFromEvent(input),
  );
}
