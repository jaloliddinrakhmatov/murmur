// Upcoming meetings on the Notetaker page (Connectors → Calendar connected): the next seven
// days from the calendars in macOS Calendar, each with Start Notetaker. Starting goes through
// the same path as the page's Start button (setup and consent come first); nothing records
// until the person presses it.
import { useCallback, useEffect, useState } from "react";
import { CircleDot } from "lucide-react";
import {
  dayLabel,
  MEETING_SERVICE_LABEL,
  timeRangeLabel,
  type UpcomingMeeting,
} from "../../../shared/calendar.ts";
import type { Meeting } from "../../../shared/meetings.ts";
import type { Settings } from "../../../shared/settings.ts";
import { hub } from "../bridge.ts";
import { Badge, Button, MicroLabel, useToast } from "../ui/index.ts";
import { ipcErrorMessage } from "../model/errors.ts";
import { recordingReady } from "./notetaker-recording.tsx";

const REFRESH_MS = 60_000;

export function UpcomingMeetings({
  settings,
  recordingMeetingId,
  onNeedSetup,
  onStarted,
  openSettings,
}: {
  settings: Settings;
  /** A recording is running: Start is replaced by opening it. */
  recordingMeetingId: string | null;
  onNeedSetup: () => void;
  onStarted: (meeting: Meeting) => void;
  openSettings: (target: "connectors") => void;
}) {
  const toast = useToast();
  const on = settings.connectors.calendar.enabled;
  const [meetings, setMeetings] = useState<UpcomingMeeting[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setMeetings(await hub.upcomingMeetings());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    if (!on) {
      setMeetings(null);
      return;
    }
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    window.addEventListener("focus", load);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [on, load]);

  if (!on) return null;

  const start = async (m: UpcomingMeeting) => {
    if (!recordingReady(settings)) {
      onNeedSetup();
      return;
    }
    setStarting(m.key);
    try {
      onStarted(await hub.startNotetakerFromEvent(m.key));
    } catch (e) {
      toast({
        title: "Couldn't start recording",
        description: ipcErrorMessage(e),
        tone: "error",
      });
    } finally {
      setStarting(null);
    }
  };

  const now = Date.now();
  let lastDay = "";
  return (
    <section
      aria-labelledby="upcoming-title"
      data-upcoming-meetings
      className="mt-6 rounded-card bg-surface px-5 pb-4 pt-3"
    >
      <h2 id="upcoming-title">
        <MicroLabel className="text-fg">Upcoming</MicroLabel>
      </h2>
      {failed ? (
        <p className="py-4 text-ui text-fg-secondary">
          Couldn't read your calendars.{" "}
          <Button variant="ghost" size="sm" onClick={() => void load()}>
            Try again
          </Button>{" "}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => openSettings("connectors")}
          >
            Connectors settings
          </Button>
        </p>
      ) : meetings === null ? null : meetings.length === 0 ? (
        <p className="py-4 text-center text-ui text-fg-secondary">
          Nothing on your calendars in the next 7 days
        </p>
      ) : (
        <ul aria-label="Upcoming meetings" className="mt-1 space-y-1">
          {meetings.map((m) => {
            const day = dayLabel(m.startMs, now);
            const heading = day !== lastDay;
            lastDay = day;
            return (
              <li key={m.key}>
                {heading && (
                  <p className="pb-1 pt-3 text-caption font-medium text-fg-secondary">
                    {day}
                  </p>
                )}
                <div className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-surface-hover">
                  <span className="w-40 shrink-0 text-caption text-fg-secondary">
                    {timeRangeLabel(m.startMs, m.endMs)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ui font-medium text-fg">
                      {m.title}
                    </span>
                    <span className="block truncate text-caption text-fg-secondary">
                      {m.calendar}
                      {m.account && m.account !== m.calendar
                        ? ` · ${m.account}`
                        : ""}
                    </span>
                  </span>
                  {m.service && (
                    <Badge>{MEETING_SERVICE_LABEL[m.service]}</Badge>
                  )}
                  <Button
                    variant="soft"
                    size="sm"
                    icon={<CircleDot className="size-3.5" aria-hidden />}
                    loading={starting === m.key}
                    disabled={Boolean(recordingMeetingId)}
                    aria-label={`Start Notetaker for ${m.title}`}
                    onClick={() => void start(m)}
                  >
                    Start Notetaker
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
