// Notetaker recording UI (Stage 9D-2): the live recording panel in a meeting (state, time, real
// microphone and system-audio levels, Pause / Resume / Stop), a banner on the Notetaker page
// while a meeting records, and the Transcript and Summary sections. Nothing here starts a
// recording except the person pressing Start; a recording is shown as running only while the
// recorder in the main process says it is.
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertCircle,
  AudioLines,
  CircleDot,
  Copy,
  Pause,
  Play,
  Sparkles,
  Square,
} from "lucide-react";
import {
  formatClock,
  formatMeetingDuration,
  IDLE_RECORDING,
  type Meeting,
  type RecordingState,
  type TranscriptionProgress,
} from "../../../shared/meetings.ts";
import type { Settings } from "../../../shared/settings.ts";
import { hub } from "../bridge.ts";
import { Button, cn, InlineAlert, useToast } from "../ui/index.ts";
import { ipcErrorMessage } from "../model/errors.ts";
import type { SettingsTarget } from "../model/settings-sections.ts";
import { speakerLines } from "../model/notetaker.ts";

/** The recorder's state, kept current from the main process. */
export function useRecording(): RecordingState {
  const [state, setState] = useState<RecordingState>(IDLE_RECORDING);
  useEffect(() => {
    let live = true;
    void hub
      .recordingState()
      .then((s) => live && setState(s))
      .catch(() => {});
    const off = hub.onRecordingChanged((s) => setState(s));
    return () => {
      live = false;
      off();
    };
  }, []);
  return state;
}

/** Transcription progress per meeting. */
export function useTranscriptionProgress(): Record<
  string,
  TranscriptionProgress
> {
  const [progress, setProgress] = useState<
    Record<string, TranscriptionProgress>
  >({});
  useEffect(
    () =>
      hub.onTranscriptionProgress((p) =>
        setProgress((cur) => ({ ...cur, [p.meetingId]: p })),
      ),
    [],
  );
  return progress;
}

export const recordingReady = (s: Settings) =>
  s.notetaker.setupCompleted && s.notetaker.consentAcknowledged;

const PHASE_LABEL: Record<RecordingState["phase"], string> = {
  idle: "",
  starting: "Starting…",
  recording: "Recording",
  paused: "Paused",
  stopping: "Saving…",
};

function Meter({ label, level }: { label: string; level: number }) {
  const pct = Math.round(Math.min(1, level * 8) * 100);
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className="h-1.5 w-28 overflow-hidden rounded-full bg-surface-strong"
    >
      <div
        className="h-full rounded-full bg-fg transition-[width] duration-150"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/** A meeting's recording: Start (never recorded), the live panel, or what was recorded. */
export function RecordingPanel({
  meeting,
  rec,
  settings,
  onNeedSetup,
}: {
  meeting: Meeting;
  rec: RecordingState;
  settings: Settings;
  onNeedSetup: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(ipcErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (rec.meetingId === meeting.id && rec.phase !== "idle") {
    const live = rec.phase === "recording";
    const sys = rec.systemAudio;
    return (
      <section
        aria-label="Recording"
        data-recording-panel={rec.phase}
        className="mt-6 rounded-card bg-surface px-5 py-4"
      >
        <div className="flex flex-wrap items-center gap-3">
          <span
            aria-hidden
            className={cn(
              "size-2.5 rounded-full",
              live ? "bg-danger motion-safe:animate-pulse" : "bg-fg-tertiary",
            )}
          />
          <span role="status" className="text-ui font-semibold text-fg">
            {PHASE_LABEL[rec.phase]}
          </span>
          <span className="font-mono text-ui tabular-nums text-fg">
            {formatClock(rec.elapsedMs)}
          </span>
          <span className="text-caption text-fg-secondary">
            of {formatMeetingDuration(rec.maxMs)}
          </span>
          <span className="ml-auto flex gap-2">
            {rec.phase === "paused" ? (
              <Button
                icon={<Play className="size-3.5" aria-hidden />}
                disabled={busy}
                onClick={() => void run(() => hub.resumeRecording())}
              >
                Resume
              </Button>
            ) : (
              <Button
                icon={<Pause className="size-3.5" aria-hidden />}
                disabled={busy || !live}
                onClick={() => void run(() => hub.pauseRecording())}
              >
                Pause
              </Button>
            )}
            <Button
              variant="primary"
              icon={<Square className="size-3.5" aria-hidden />}
              disabled={
                busy || rec.phase === "stopping" || rec.phase === "starting"
              }
              onClick={() => void run(() => hub.stopRecording())}
            >
              Stop
            </Button>
          </span>
        </div>
        <div className="mt-3 grid gap-2 text-caption text-fg-secondary sm:grid-cols-2">
          <div className="flex items-center gap-2">
            <span className="w-28">Microphone</span>
            <Meter label="Microphone level" level={rec.micLevel} />
          </div>
          <div className="flex items-center gap-2">
            <span className="w-28">Your Mac's sound</span>
            {sys.state === "on" ? (
              <Meter label="Your Mac's sound level" level={rec.systemLevel} />
            ) : (
              <span>
                {sys.state === "off"
                  ? "Off (Settings → Notetaker)"
                  : `Not recorded: ${sys.reason}`}
              </span>
            )}
          </div>
        </div>
        {rec.phase === "starting" && (
          <p className="mt-2 text-caption text-fg-secondary">
            If macOS asks whether Murmur may record your Mac's sound, answer it
            to continue. Recording starts once it's answered.
          </p>
        )}
        {rec.warning && (
          <p role="alert" className="mt-2 text-caption text-warning">
            {rec.warning}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-2 text-caption text-danger">
            {error}
          </p>
        )}
      </section>
    );
  }

  if (meeting.status !== "notes")
    return meeting.recordedMs ? (
      <p className="mt-6 text-caption text-fg-secondary">
        Recorded {formatMeetingDuration(meeting.recordedMs) || "under a minute"}
        {meeting.systemAudio
          ? ", microphone and your Mac's sound"
          : ", microphone only"}
        .
      </p>
    ) : null;

  const other = rec.phase !== "idle";
  return (
    <section
      aria-label="Recording"
      className="mt-6 flex flex-wrap items-center gap-3 rounded-card bg-surface px-5 py-4"
    >
      <Button
        variant="primary"
        icon={<CircleDot className="size-4" aria-hidden />}
        disabled={busy || other}
        loading={busy}
        onClick={() =>
          recordingReady(settings)
            ? void run(() => hub.startRecording(meeting.id))
            : onNeedSetup()
        }
      >
        Start recording
      </Button>
      <span className="min-w-0 flex-1 text-caption text-fg-secondary">
        {other
          ? "Another meeting is being recorded."
          : !recordingReady(settings)
            ? "Set up Notetaker first: it explains what is recorded."
            : settings.notetaker.systemAudio
              ? settings.notetaker.speakerLabels
                ? "Records your microphone and all sound playing on your Mac (not only the meeting app) until you stop, labelled You and Others. Tell people before you start."
                : "Records your microphone and all sound playing on your Mac (not only the meeting app) until you stop. Tell people before you start."
              : "Records your microphone until you stop. Tell people before you start."}
      </span>
      {error && (
        <p role="alert" className="w-full text-caption text-danger">
          {error}
        </p>
      )}
    </section>
  );
}

/** On the Notetaker page while a meeting records. */
export function RecordingBanner({
  rec,
  title,
  onOpen,
}: {
  rec: RecordingState;
  title: string;
  onOpen: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  if (rec.phase === "idle" || !rec.meetingId) return null;
  return (
    <section
      aria-label="Meeting recording"
      data-recording-banner
      className="-mt-6 mb-[30px] flex flex-wrap items-center gap-3 rounded-card bg-danger-soft px-5 py-3"
    >
      <span
        aria-hidden
        className={cn(
          "size-2.5 rounded-full",
          rec.phase === "recording"
            ? "bg-danger motion-safe:animate-pulse"
            : "bg-fg-tertiary",
        )}
      />
      <span className="min-w-0 flex-1 truncate text-ui text-fg">
        <span className="font-semibold">{PHASE_LABEL[rec.phase]}</span> {title}{" "}
        · {formatClock(rec.elapsedMs)}
      </span>
      <Button size="sm" onClick={onOpen}>
        Open
      </Button>
      <Button
        size="sm"
        variant="primary"
        disabled={rec.phase === "stopping" || rec.phase === "starting"}
        onClick={() =>
          void hub.stopRecording().catch((e) => setError(ipcErrorMessage(e)))
        }
      >
        Stop
      </Button>
      {error && (
        <p role="alert" className="w-full text-caption text-danger">
          {error}
        </p>
      )}
    </section>
  );
}

function Section({
  icon,
  title,
  name,
  actions,
  children,
}: {
  icon: ReactNode;
  title: string;
  name: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      data-meeting-section={name}
      className="mt-6 rounded-card bg-surface px-5 py-4"
    >
      <div className="flex items-center gap-3">
        <span className="text-fg-secondary">{icon}</span>
        <h2 className="flex-1 text-ui font-semibold text-fg">{title}</h2>
        {actions}
      </div>
      <div className="mt-2 text-ui text-fg">{children}</div>
    </section>
  );
}

export function TranscriptSection({
  meeting,
  progress,
}: {
  meeting: Meeting;
  progress: TranscriptionProgress | undefined;
}) {
  const toast = useToast();
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    setRetrying(true);
    try {
      await hub.transcribeMeeting(meeting.id);
    } catch (e) {
      toast({
        title: "Couldn't start transcribing",
        description: ipcErrorMessage(e),
        tone: "error",
      });
    } finally {
      setRetrying(false);
    }
  };
  const muted = (t: string) => <p className="text-fg-secondary">{t}</p>;
  let body: ReactNode;
  let actions: ReactNode = null;
  if (meeting.hasTranscript) {
    const lines = speakerLines(meeting.transcript);
    body = !meeting.transcript.trim() ? (
      muted(
        "The recording was silent: neither the microphone nor your Mac's sound picked anything up.",
      )
    ) : lines ? (
      <ul
        data-speaker-transcript
        className="max-h-[420px] select-text space-y-2 overflow-y-auto leading-relaxed"
      >
        {lines.map((l, i) => (
          <li key={i}>
            <span
              className={
                l.speaker === "You"
                  ? "font-semibold text-fg"
                  : "font-semibold text-accent-text"
              }
            >
              {l.speaker}:
            </span>{" "}
            {l.text}
          </li>
        ))}
      </ul>
    ) : (
      <div className="max-h-[420px] select-text overflow-y-auto whitespace-pre-wrap leading-relaxed">
        {meeting.transcript}
      </div>
    );

    if (meeting.transcript.trim())
      actions = (
        <Button
          size="sm"
          icon={<Copy className="size-3.5" aria-hidden />}
          onClick={async () => {
            try {
              await hub.copyText(meeting.transcript);
              toast({ title: "Transcript copied", tone: "success" });
            } catch (e) {
              toast({
                title: "Couldn't copy the transcript",
                description: ipcErrorMessage(e),
                tone: "error",
              });
            }
          }}
        >
          Copy
        </Button>
      );
  } else if (meeting.status === "processing")
    body = (
      <p role="status" className="text-fg-secondary">
        Transcribing
        {progress && progress.total > 1
          ? ` (${progress.done} of ${progress.total})`
          : ""}
        … The recording is deleted once the transcript is saved.
      </p>
    );
  else if (meeting.status === "failed")
    body = (
      <InlineAlert
        tone="danger"
        icon={<AlertCircle />}
        action={
          meeting.audioParts > 0 ? (
            <Button size="sm" loading={retrying} onClick={() => void retry()}>
              Transcribe again
            </Button>
          ) : undefined
        }
      >
        {meeting.error ?? "Transcription failed."}
        {meeting.doneBatches > 0 &&
          // Five-minute sections: 10 parts of 30 s each (PARTS_PER_BATCH in the main process).
          ` ${meeting.doneBatches} of ${Math.ceil(meeting.audioParts / 10)} five-minute sections are already transcribed; transcribing again continues from there.`}
      </InlineAlert>
    );
  else if (meeting.status === "recording")
    body = muted("The transcript appears here after you stop recording.");
  else
    body = muted(
      "No recording yet. Start recording above; the transcript appears here when you stop.",
    );
  return (
    <Section
      icon={<AudioLines className="size-4" aria-hidden />}
      title="Transcript"
      name="transcript"
      actions={actions}
    >
      {body}
    </Section>
  );
}

type AiStatus = Awaited<ReturnType<typeof hub.transformsAiStatus>>;

export function SummarySection({
  meeting,
  openSettings,
}: {
  meeting: Meeting;
  openSettings: (target: SettingsTarget) => void;
}) {
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<string | null>(null);
  const hasText = meeting.hasTranscript && meeting.transcript.trim() !== "";
  useEffect(() => {
    if (!hasText) return;
    void hub
      .transformsAiStatus()
      .then(setAi)
      .catch(() => {});
    return hub.onTransformsChanged(
      () =>
        void hub
          .transformsAiStatus()
          .then(setAi)
          .catch(() => {}),
    );
  }, [hasText]);
  useEffect(
    () => () => {
      if (request.current) void hub.cancelSummary(request.current);
    },
    [],
  );

  const summarize = async () => {
    const id = crypto.randomUUID();
    request.current = id;
    setRunning(true);
    setError(null);
    try {
      await hub.summarizeMeeting(meeting.id, id);
    } catch (e) {
      if (request.current === id) setError(ipcErrorMessage(e));
    } finally {
      if (request.current === id) {
        request.current = null;
        setRunning(false);
      }
    }
  };

  let body: ReactNode;
  let actions: ReactNode = null;
  if (!hasText)
    body = (
      <p className="text-fg-secondary">
        {meeting.hasTranscript
          ? "There's nothing to summarize."
          : "A summary can be made once there's a transcript."}
      </p>
    );
  else if (running)
    body = (
      <p role="status" className="flex items-center gap-3 text-fg-secondary">
        Summarizing with {ai?.service ?? "the AI service"}…
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            if (request.current) void hub.cancelSummary(request.current);
            request.current = null;
            setRunning(false);
          }}
        >
          Cancel
        </Button>
      </p>
    );
  else {
    const notReady = ai?.ready ?? null;
    const consent = ai && !ai.summaryConsented && !notReady;
    body = (
      <>
        {meeting.hasSummary && <SummaryText text={meeting.summary} />}
        {notReady ? (
          <p className="mt-2 text-fg-secondary">
            Summaries use {ai?.service}: {notReady}{" "}
            <button
              type="button"
              className="underline"
              onClick={() => openSettings("ai")}
            >
              Open AI cleanup settings
            </button>
          </p>
        ) : consent ? (
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <p className="min-w-0 flex-1 text-fg-secondary">
              A summary sends this meeting's transcript and notes, including
              what other people said, to {ai.service}. Nothing is sent until you
              allow it.
            </p>
            <Button
              size="sm"
              variant="primary"
              onClick={async () => {
                try {
                  await hub.allowSummaryAi(ai.provider);
                  setAi(await hub.transformsAiStatus());
                } catch (e) {
                  setError(ipcErrorMessage(e));
                  void hub
                    .transformsAiStatus()
                    .then(setAi)
                    .catch(() => {});
                  return;
                }
                await summarize();
              }}
            >
              Allow and summarize
            </Button>
          </div>
        ) : (
          !meeting.hasSummary && (
            <p className="text-fg-secondary">
              Ask for a summary: decisions, action items and open questions,
              written by {ai?.service ?? "the AI service"} from the transcript.
            </p>
          )
        )}
        {error && (
          <p role="alert" className="mt-2 text-caption text-danger">
            {error}
          </p>
        )}
      </>
    );
    if (ai && !notReady && !consent)
      actions = (
        <Button
          size="sm"
          icon={<Sparkles className="size-3.5" aria-hidden />}
          onClick={() => void summarize()}
        >
          {meeting.hasSummary ? "Summarize again" : "Summarize"}
        </Button>
      );
  }
  return (
    <Section
      icon={<Sparkles className="size-4" aria-hidden />}
      title="Summary"
      name="summary"
      actions={actions}
    >
      {body}
    </Section>
  );
}

/** The summary's Markdown sections and bullets, as text (no HTML from the AI reply). */
function SummaryText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let items: string[] = [];
  const flush = () => {
    if (items.length)
      blocks.push(
        <ul key={blocks.length} className="ml-5 list-disc space-y-1">
          {items.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>,
      );
    items = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/\*\*/g, "");
    if (!line) {
      flush();
      continue;
    }
    const heading = /^#{1,4}\s+(.*)$/.exec(line);
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push(
        <h3 key={blocks.length} className="mt-3 font-semibold first:mt-0">
          {heading[1]}
        </h3>,
      );
    } else if (bullet) items.push(bullet[1]);
    else {
      flush();
      blocks.push(<p key={blocks.length}>{line}</p>);
    }
  }
  flush();
  return (
    <div data-summary className="select-text space-y-2 leading-relaxed">
      {blocks}
    </div>
  );
}
