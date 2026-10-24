// Settings → Connectors. Calendar is real: it reads the calendars the person added to macOS
// Calendar (Google, Outlook/Exchange, iCloud) through EventKit, so no OAuth app is involved.
// Direct Google/Outlook/Slack connections need app registrations by the Murmur team and are
// shown as unavailable rather than as buttons that do nothing.
import { useCallback, useEffect, useState } from "react";
import { CalendarDays, Plug } from "lucide-react";
import {
  ACCOUNT_KIND_LABEL,
  type CalendarStatus,
} from "../../../shared/calendar.ts";
import type { Settings } from "../../../shared/settings.ts";
import { SETTINGS_SECTION_IDS } from "../model/settings-sections.ts";
import type { SettingsSectionId } from "../model/settings-sections.ts";
import { calendarRowView } from "../model/connectors.ts";
import { ipcErrorMessage } from "../model/errors.ts";
import { hub } from "../bridge.ts";
import {
  Badge,
  Button,
  describedBy,
  SettingsGroup,
  SettingsRow,
  Switch,
  useToast,
} from "../ui/index.ts";
import { StatusText, useSave, type Update } from "./common.tsx";

export function ConnectorsSection({
  settings,
  update,
  onSection,
}: {
  settings: Settings;
  update: Update;
  onSection: (s: SettingsSectionId) => void;
}) {
  const toast = useToast();
  const save = useSave(update);
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await hub.calendarStatus());
    } catch {
      setStatus(null);
    }
  }, []);
  useEffect(() => {
    void refresh();
    // Back from System Settings after changing the permission.
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh, settings.connectors.calendar.enabled]);

  const run = async (call: () => Promise<CalendarStatus>) => {
    setBusy(true);
    try {
      setStatus(await call());
    } catch (e) {
      toast({
        title: "Couldn't change Calendar",
        description: ipcErrorMessage(e),
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  const view = status ? calendarRowView(status) : null;
  const hasMcp = (SETTINGS_SECTION_IDS as readonly string[]).includes("mcp");

  return (
    <>
      <SettingsGroup title="Calendar">
        <SettingsRow
          label="Calendar (via macOS Calendar)"
          align="start"
          description={
            <>
              Uses the Google, Outlook/Exchange and iCloud calendars you added
              to the Calendar app on this Mac, so there is nothing to sign in
              to. Events are read on this Mac and never leave it.
              {view?.note && <span className="mt-2 block">{view.note}</span>}
              {view?.showSystemSettings && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void hub.openSystemSettings("calendars")}
                >
                  Open Calendars in System Settings
                </Button>
              )}
            </>
          }
          control={
            <div className="flex items-center gap-3">
              {view && (
                <StatusText tone={view.tone} live>
                  {view.text}
                </StatusText>
              )}
              {view?.action === "connect" && (
                <Button
                  variant="outline"
                  icon={<CalendarDays className="size-3.5" aria-hidden />}
                  loading={busy}
                  onClick={() => void run(() => hub.connectCalendar())}
                >
                  Connect
                </Button>
              )}
              {view?.action === "disconnect" && (
                <Button
                  variant="outline"
                  loading={busy}
                  onClick={() => void run(() => hub.disconnectCalendar())}
                >
                  Disconnect
                </Button>
              )}
            </div>
          }
        />
        {status?.connected && (
          <>
            <SettingsRow
              label="Calendars Murmur can see"
              description={
                status.accounts.length
                  ? undefined
                  : "No calendars found. Add an account in the Calendar app."
              }
              control={
                <ul className="flex flex-wrap justify-end gap-2">
                  {status.accounts.map((a) => (
                    <li key={a.name}>
                      <Badge>
                        {ACCOUNT_KIND_LABEL[a.kind]} · {a.name} ({a.calendars})
                      </Badge>
                    </li>
                  ))}
                </ul>
              }
            />
            <SettingsRow
              label="Remind me when a meeting starts"
              htmlFor="calendar-reminders"
              description="A notice a minute before a meeting that has a Zoom, Google Meet or Teams link: “Meeting starting: … Start Notetaker?”. It never starts recording by itself."
              control={
                <Switch
                  id="calendar-reminders"
                  label="Remind me when a meeting starts"
                  describedBy={describedBy("calendar-reminders")}
                  checked={settings.connectors.calendar.reminders}
                  onCheckedChange={(v) =>
                    void save({ connectors: { calendar: { reminders: v } } })
                  }
                />
              }
            />
          </>
        )}
      </SettingsGroup>
      <SettingsGroup title="Direct connections">
        {(
          [
            ["Google Calendar", "Sign in with Google"],
            ["Outlook Calendar", "Sign in with Microsoft"],
            ["Slack", "Share notes to Slack"],
          ] as const
        ).map(([name, what]) => (
          <SettingsRow
            key={name}
            label={name}
            description={`${what} directly. Needs setup by the Murmur team (an app registration with the service) before it can be offered. ${
              name === "Slack"
                ? ""
                : "Until then, add the account to the Calendar app and use the row above."
            }`}
            control={<Badge>Needs setup by the Murmur team</Badge>}
          />
        ))}
      </SettingsGroup>
      {hasMcp && (
        <SettingsGroup title="AI apps">
          <SettingsRow
            label="Give your AI apps access to your meeting notes"
            description="Let Claude, ChatGPT and other AI apps read your notes on this Mac."
            control={
              <Button
                variant="outline"
                icon={<Plug className="size-3.5" aria-hidden />}
                onClick={() => onSection("mcp" as SettingsSectionId)}
              >
                Go to MCP
              </Button>
            }
          />
        </SettingsGroup>
      )}
    </>
  );
}
