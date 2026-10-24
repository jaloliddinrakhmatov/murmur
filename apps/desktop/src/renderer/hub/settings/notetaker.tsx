// Settings → Notetaker (references 24–28). Only rows with real behaviour: the setup (reference
// “Start tutorial”), recording your Mac's sound, the maximum recording length and whether a
// recording is running now (Stage 9D-2), how long meetings are kept, and importing your meeting
// notes. Meeting detection, calendars and sharing in the reference are not shown.
import { useEffect, useState } from "react";
import {
  MAX_RECORDING_MINUTES,
  systemAudioReason,
} from "../../../shared/meetings.ts";
import { useRecording } from "../pages/notetaker-recording.tsx";
import { NotebookPen, Upload } from "lucide-react";
import type { Settings } from "../../../shared/settings.ts";
import { hub } from "../bridge.ts";
import {
  Button,
  ConfirmDialog,
  describedBy,
  Select,
  SettingsGroup,
  SettingsRow,
  Switch,
  useToast,
} from "../ui/index.ts";
import { ipcErrorMessage } from "../model/errors.ts";
import {
  isRetentionDays,
  meetingsPastRetention,
  RETENTION_OPTIONS,
  type RetentionDays,
} from "../model/notetaker.ts";
import { StatusText, useSave, type Update } from "./common.tsx";

export function NotetakerSection({
  settings,
  update,
  navigate,
}: {
  settings: Settings;
  update: Update;
  /** Closes Settings and opens a route. */
  navigate: (route: string) => void;
}) {
  const toast = useToast();
  const save = useSave(update);
  const n = settings.notetaker;
  const [pending, setPending] = useState<{
    days: RetentionDays;
    count: number;
  } | null>(null);
  const [importing, setImporting] = useState(false);
  const [systemAudio, setSystemAudio] = useState<string | null>(null);
  const recording = useRecording();
  useEffect(() => {
    void hub
      .notetakerReadiness()
      .then((r) => setSystemAudio(r.systemAudio))
      .catch(() => {});
  }, []);

  const chooseRetention = async (days: RetentionDays) => {
    try {
      const count = meetingsPastRetention(
        await hub.meetings({}),
        days,
        Date.now(),
      );
      if (count) setPending({ days, count });
      else void save({ notetaker: { retentionDays: days } });
    } catch (e) {
      toast({
        title: "Couldn't check your meetings",
        description: ipcErrorMessage(e),
        tone: "error",
      });
    }
  };

  const runImport = async () => {
    setImporting(true);
    try {
      const r = await hub.importMeetings();
      if (r.imported || r.skipped.length)
        toast({
          title: r.imported
            ? `Imported ${r.imported} ${r.imported === 1 ? "meeting" : "meetings"}`
            : "Nothing imported",
          description: r.skipped.length
            ? `Skipped: ${r.skipped.slice(0, 3).join(", ")}${r.skipped.length > 3 ? ` and ${r.skipped.length - 3} more` : ""} (only .txt and .md files up to 500 KB).`
            : undefined,
          tone: r.imported ? "success" : "error",
        });
    } catch (e) {
      toast({
        title: "Couldn't import",
        description: ipcErrorMessage(e),
        tone: "error",
      });
    } finally {
      setImporting(false);
    }
  };

  return (
    <>
      <SettingsGroup>
        <SettingsRow
          label="Set up Notetaker"
          description={
            n.setupCompleted
              ? "Done. Go through it again to review what Notetaker can hear, where meetings are kept and the services it uses."
              : "What Notetaker can hear, where meetings are kept and the services it uses. About 2 minutes."
          }
          control={
            <Button
              variant="outline"
              icon={<NotebookPen className="size-3.5" aria-hidden />}
              onClick={() => navigate("notetaker/setup")}
            >
              {n.setupCompleted ? "Review setup" : "Start setup"}
            </Button>
          }
        />
      </SettingsGroup>
      <SettingsGroup title="Recording">
        <SettingsRow
          label="Record your Mac's sound"
          htmlFor="meeting-system-audio"
          description={
            systemAudio === null || systemAudio === "available"
              ? "Records all sound playing on your Mac (the other people in a call, but also music, videos and any other app) along with your microphone. macOS asks the first time you record with this on."
              : `${systemAudioReason(systemAudio)} Meetings record your microphone only.`
          }
          control={
            <Switch
              id="meeting-system-audio"
              label="Record your Mac's sound"
              describedBy={describedBy("meeting-system-audio")}
              checked={n.systemAudio}
              onCheckedChange={(v) =>
                void save({ notetaker: { systemAudio: v } })
              }
            />
          }
        />
        <SettingsRow
          label="Label speakers (You and Others)"
          htmlFor="meeting-speaker-labels"
          description={
            n.systemAudio
              ? "Keeps your microphone and your Mac's sound apart so the transcript says who spoke. Each is transcribed separately (about twice the requests). Without headphones some of your lines can repeat others; Murmur removes most repeats."
              : "Needs “Record your Mac's sound”: without it, everything recorded is you."
          }
          control={
            <Switch
              id="meeting-speaker-labels"
              label="Label speakers (You and Others)"
              describedBy={describedBy("meeting-speaker-labels")}
              checked={n.speakerLabels}
              disabled={!n.systemAudio}
              onCheckedChange={(v) =>
                void save({ notetaker: { speakerLabels: v } })
              }
            />
          }
        />
        <SettingsRow
          label="Maximum recording length"
          htmlFor="meeting-max-length"
          description="Recording stops by itself at this length, with a warning a minute before."
          control={
            <Select
              id="meeting-max-length"
              aria-describedby={describedBy("meeting-max-length")}
              className="w-48"
              value={String(n.maxRecordingMinutes)}
              onChange={(e) => {
                const m = Number(e.target.value);
                if (isMaxRecordingMinutes(m))
                  void save({ notetaker: { maxRecordingMinutes: m } });
              }}
            >
              <option value="30">30 minutes</option>
              <option value="60">1 hour</option>
              <option value="120">2 hours</option>
              <option value="240">4 hours</option>
            </Select>
          }
        />
        <SettingsRow
          label="Recording now"
          description="Recording starts only when you press Start. While it runs, the menu bar shows the time."
          control={
            recording.phase === "idle" ? (
              <StatusText tone="neutral">Off</StatusText>
            ) : (
              <StatusText tone="danger" live>
                {recording.phase === "paused" ? "Paused" : "Recording"}
              </StatusText>
            )
          }
        />
      </SettingsGroup>
      <SettingsGroup title="Meetings">
        <SettingsRow
          label="Keep meetings for"
          htmlFor="meeting-retention"
          description="Meetings are stored on this Mac only. Older ones are deleted at launch and every 6 hours."
          control={
            <Select
              id="meeting-retention"
              aria-describedby={describedBy("meeting-retention")}
              className="w-48"
              value={String(n.retentionDays)}
              onChange={(e) => {
                const days = Number(e.target.value);
                if (isRetentionDays(days)) void chooseRetention(days);
              }}
            >
              {RETENTION_OPTIONS.map((o) => (
                <option key={o.days} value={o.days}>
                  {o.label}
                </option>
              ))}
            </Select>
          }
        />
        <SettingsRow
          label="Import your meeting notes"
          description="Text or Markdown files (.txt, .md) become meetings, with the file's text as your notes."
          control={
            <Button
              icon={<Upload className="size-3.5" aria-hidden />}
              loading={importing}
              onClick={() => void runImport()}
            >
              Import…
            </Button>
          }
        />
      </SettingsGroup>
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(o) => !o && setPending(null)}
        title={`Delete ${pending?.count ?? 0} older ${pending?.count === 1 ? "meeting" : "meetings"}?`}
        description="They're older than the time you chose, so they're deleted from this Mac now. This can't be undone."
        confirmLabel="Delete older meetings"
        destructive
        onConfirm={async () => {
          if (pending)
            await update({ notetaker: { retentionDays: pending.days } });
        }}
      />
    </>
  );
}

const isMaxRecordingMinutes = (
  n: number,
): n is (typeof MAX_RECORDING_MINUTES)[number] =>
  (MAX_RECORDING_MINUTES as readonly number[]).includes(n);
