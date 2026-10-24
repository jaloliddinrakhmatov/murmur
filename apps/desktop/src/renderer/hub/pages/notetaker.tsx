// Notetaker page (reference 02): the header with its settings gear and Start Notetaker, the Today
// card (Set up Notetaker, today's meetings), and Past notes with search and sort (Stage 9D-1).
// A meeting opens in place: its title, times, your notes (saved as you type), its recording
// (started only by the person, Stage 9D-2), and the Transcript and Summary sections.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AlertCircle,
  ArrowLeft,
  Download,
  FileText,
  MoreHorizontal,
  NotebookPen,
  Plus,
  RefreshCw,
  Settings as SettingsIcon,
  CircleDot,
  Trash2,
} from "lucide-react";
import {
  formatMeetingDuration,
  MEETING_SORTS,
  MEETING_TITLE_MAX,
  meetingDurationMs,
  type Meeting,
  type MeetingSort,
  type MeetingSummary,
} from "../../../shared/meetings.ts";
import type { Settings } from "../../../shared/settings.ts";
import { hub } from "../bridge.ts";
import {
  Button,
  ConfirmDialog,
  IconButton,
  InlineAlert,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  MicroLabel,
  SearchToggle,
  Select,
  Skeleton,
  SortMenu,
  Textarea,
  UnderlineTabs,
  useStoredChoice,
  useToast,
} from "../ui/index.ts";
import { PageHeader } from "../shell/shell.tsx";
import { ipcErrorMessage } from "../model/errors.ts";
import {
  fromLocalInput,
  languageToOption,
  meetingLanguageOptions,
  optionToLanguage,
  meetingNotesStore,
  meetingAsNote,
  pendingSaves,
  meetingTimesIssue,
  meetingWhen,
  todaysMeetings,
  toLocalInput,
} from "../model/notetaker.ts";
import {
  Autosaver,
  saveErrorText,
  saveStateLabel,
  type SaveState,
} from "../model/scratchpad.ts";
import type { SettingsTarget } from "../model/settings-sections.ts";
import { NotetakerSetupDialog } from "./notetaker-setup.tsx";
import { UpcomingMeetings } from "./notetaker-upcoming.tsx";
import {
  RecordingBanner,
  RecordingPanel,
  recordingReady,
  SummarySection,
  TranscriptSection,
  useRecording,
  useTranscriptionProgress,
} from "./notetaker-recording.tsx";
import {
  formatClock,
  type RecordingState,
  type TranscriptionProgress,
} from "../../../shared/meetings.ts";

const SORTS: { id: MeetingSort; label: string }[] = [
  { id: "newest", label: "Newest first" },
  { id: "oldest", label: "Oldest first" },
  { id: "title", label: "Title (A–Z)" },
];

export function NotetakerPage({
  settings,
  update,
  openSettings,
  focusId,
  onFocusHandled,
}: {
  settings: Settings;
  update: (p: unknown) => Promise<void>;
  openSettings: (target: SettingsTarget) => void;
  /** From a link: "setup" opens Set up Notetaker, "new" starts a note, else a meeting id. */
  focusId?: string;
  onFocusHandled: () => void;
}) {
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useStoredChoice<MeetingSort>(
    "murmur.notetaker.sort",
    MEETING_SORTS,
    "newest",
  );
  const [all, setAll] = useState<MeetingSummary[] | null>(null);
  const [found, setFound] = useState<MeetingSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [starting, setStarting] = useState(false);
  const newRef = useRef<HTMLButtonElement>(null);
  const rec = useRecording();
  const progress = useTranscriptionProgress();

  const load = useCallback(async () => {
    try {
      const everything = await hub.meetings({ sort });
      setAll(everything);
      setFound(search.trim() ? await hub.meetings({ search, sort }) : null);
      setError(null);
    } catch (e) {
      setError(ipcErrorMessage(e));
    }
  }, [search, sort]);
  useEffect(() => {
    void load();
    return hub.onMeetingsChanged(() => void load());
  }, [load]);

  const create = useCallback(async () => {
    setCreating(true);
    try {
      const m = await hub.createMeeting();
      setOpenId(m.id);
    } catch (e) {
      toast({
        title: "Couldn't create the meeting",
        description: ipcErrorMessage(e),
        tone: "error",
      });
    } finally {
      setCreating(false);
    }
  }, [toast]);

  /** Start Notetaker: a new meeting, recording at once (setup and consent first). */
  const startNotetaker = async () => {
    if (rec.meetingId) {
      setOpenId(rec.meetingId);
      return;
    }
    if (!recordingReady(settings)) {
      setSetupOpen(true);
      return;
    }
    setStarting(true);
    try {
      const m = await hub.startNotetaker();
      setOpenId(m.id);
    } catch (e) {
      toast({
        title: "Couldn't start recording",
        description: ipcErrorMessage(e),
        tone: "error",
      });
    } finally {
      setStarting(false);
    }
  };

  useEffect(() => {
    if (!focusId) return;
    if (focusId === "setup") setSetupOpen(true);
    else if (focusId === "new") void create();
    else setOpenId(focusId);
    onFocusHandled();
  }, [focusId, onFocusHandled, create]);

  const n = settings.notetaker;
  const now = new Date();
  const today = all ? todaysMeetings(all, now) : [];
  const list = found ?? all;
  const showTour = !n.setupCompleted && !n.setupCardDismissed;

  const layout = (content: ReactNode) => (
    <NotetakerLayout
      openSettings={openSettings}
      count={all?.length ?? null}
      rec={rec}
    >
      {content}
      <NotetakerSetupDialog
        open={setupOpen}
        onOpenChange={setSetupOpen}
        settings={settings}
        update={update}
      />
    </NotetakerLayout>
  );

  if (openId)
    return layout(
      <MeetingDetail
        key={openId}
        id={openId}
        rec={rec}
        progress={progress[openId]}
        settings={settings}
        openSettings={openSettings}
        onNeedSetup={() => setSetupOpen(true)}
        onBack={() => setOpenId(null)}
        onDeleted={() => {
          setOpenId(null);
          toast({ title: "Meeting deleted", tone: "success" });
        }}
      />,
    );
  const recordingTitle =
    all?.find((m) => m.id === rec.meetingId)?.title ?? "Meeting";

  return layout(
    <div data-page="notetaker">
      <PageHeader
        title="Notetaker"
        actions={
          <>
            <IconButton
              label="Notetaker settings"
              icon={
                <SettingsIcon
                  className="size-[18px] stroke-[1.75]"
                  aria-hidden
                />
              }
              onClick={() => openSettings("notetaker")}
            />
            <Button
              variant="soft"
              size="sm"
              icon={<CircleDot className="size-4" aria-hidden />}
              loading={starting}
              onClick={() => void startNotetaker()}
            >
              {rec.meetingId ? "Open recording" : "Start Notetaker"}
            </Button>
          </>
        }
      />
      <RecordingBanner
        rec={rec}
        title={recordingTitle}
        onOpen={() => rec.meetingId && setOpenId(rec.meetingId)}
      />

      <section
        aria-labelledby="today-title"
        className="-mt-6 rounded-card bg-surface px-5 pb-6 pt-3"
      >
        <div className="flex items-center">
          <h2 id="today-title" className="flex-1">
            <MicroLabel className="text-fg">Today</MicroLabel>
          </h2>
          <IconButton
            size="sm"
            label="Refresh"
            icon={
              <RefreshCw
                className={
                  refreshing ? "size-4 motion-safe:animate-spin" : "size-4"
                }
                aria-hidden
              />
            }
            onClick={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
          />
        </div>
        {showTour && (
          <div
            data-notetaker-tour
            className="flex flex-wrap items-center gap-4 rounded-card bg-accent-faint px-5 py-[17px] shadow-[inset_0_0_0_1px_var(--m-accent)]"
          >
            <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-accent-soft text-fg">
              <NotebookPen className="size-5" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-body font-medium text-fg">
                Set up Notetaker
              </span>
              <span className="block text-ui text-fg-secondary">
                Privacy, storage and services, about 2 minutes
              </span>
            </span>
            <Button
              variant="ghost"
              onClick={() =>
                void update({ notetaker: { setupCardDismissed: true } })
              }
            >
              Skip
            </Button>
            <Button variant="primary" onClick={() => setSetupOpen(true)}>
              Start
            </Button>
          </div>
        )}
        {!all ? (
          <Skeleton className="mt-4 h-10 rounded-list" />
        ) : today.length === 0 ? (
          <p className="pt-[35px] text-center text-body text-fg">
            No meetings today
          </p>
        ) : (
          <ul aria-label="Today's meetings" className="mt-1 space-y-1">
            {today.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(m.id)}
                  className="no-drag flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-surface-hover"
                >
                  <span className="w-20 shrink-0 text-caption text-fg-secondary">
                    {meetingWhen(m, now)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-ui font-medium text-fg">
                    {m.title}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <UpcomingMeetings
        settings={settings}
        recordingMeetingId={rec.meetingId}
        onNeedSetup={() => setSetupOpen(true)}
        onStarted={(m) => setOpenId(m.id)}
        openSettings={openSettings}
      />

      <section aria-label="Past notes" className="mt-[31px]">
        <UnderlineTabs
          label="Meetings"
          options={[{ value: "past", label: "Past notes" }]}
          value="past"
          onChange={() => {}}
          tools={
            <div className="flex items-center gap-1 pb-1">
              <IconButton
                ref={newRef}
                label="New meeting note"
                icon={<Plus className="size-[18px]" aria-hidden />}
                disabled={creating}
                onClick={() => void create()}
              />
              <SearchToggle
                value={search}
                onValueChange={setSearch}
                label="Search meetings"
                placeholder="Search meetings"
              />
              <SortMenu
                label="Sort meetings"
                options={SORTS}
                value={sort}
                onChange={setSort}
              />
            </div>
          }
        />
        {error ? (
          <div className="mt-4">
            <InlineAlert
              tone="danger"
              icon={<AlertCircle />}
              action={
                <Button size="sm" onClick={() => void load()}>
                  Try again
                </Button>
              }
            >
              Couldn't load your meetings: {error}
            </InlineAlert>
          </div>
        ) : !list ? (
          <Skeleton className="mt-8 h-[84px] rounded-card" />
        ) : list.length === 0 ? (
          <div
            data-meetings-empty
            className="mt-[25px] flex items-center gap-4 rounded-card bg-surface px-4 py-[13px]"
          >
            <span className="flex size-[35px] shrink-0 items-center justify-center rounded-full bg-sheet shadow-[inset_0_0_0_1px_var(--m-hairline)]">
              <FileText className="size-[18px] text-fg-secondary" aria-hidden />
            </span>
            <span className="text-body text-fg-secondary">
              {search
                ? `No meetings match “${search}”`
                : "Your meetings will appear here"}
            </span>
          </div>
        ) : (
          <ul aria-label="Meetings" className="mt-2 divide-y divide-hairline">
            {list.map((m) => (
              <MeetingRow
                key={m.id}
                meeting={m}
                now={now}
                onOpen={() => setOpenId(m.id)}
              />
            ))}
          </ul>
        )}
      </section>
    </div>,
  );
}

/**
 * Reference layout: the main column (40 pt sides) and a 270 pt right column. The right column
 * says whether a meeting is being recorded (only while the recorder says so) and where
 * meetings are kept.
 */
function NotetakerLayout({
  children,
  openSettings,
  count,
  rec,
}: {
  children: ReactNode;
  openSettings: (target: SettingsTarget) => void;
  count: number | null;
  rec: RecordingState;
}) {
  const live = rec.phase !== "idle";
  return (
    <div className="flex min-h-full">
      <div className="min-w-0 flex-1 pb-12 pl-[30px] pr-[43px] pt-10 max-[900px]:px-3.5">
        {children}
      </div>
      <aside
        aria-label="Notetaker status"
        className="w-[270px] shrink-0 border-l border-hairline px-6 pt-10 max-[1100px]:hidden"
      >
        <div className="flex items-center gap-2 text-ui font-medium text-fg">
          <span
            aria-hidden
            className={
              live && rec.phase !== "paused"
                ? "size-2 rounded-full bg-danger"
                : "size-2 rounded-full bg-fg-tertiary"
            }
          />
          {live
            ? `${rec.phase === "paused" ? "Recording paused" : "Recording"} · ${formatClock(rec.elapsedMs)}`
            : "Recording off"}
        </div>
        <p className="mt-1.5 text-caption text-fg-secondary">
          {live
            ? "Shown in the menu bar and the Murmur bar too. The audio is deleted once the transcript is saved."
            : "Recording starts only when you press Start, and it's shown in the menu bar while it runs."}
        </p>
        <p className="mt-4 text-caption text-fg-secondary">
          {count === null
            ? "Meetings are stored on this Mac only."
            : `${count} ${count === 1 ? "meeting" : "meetings"}, stored on this Mac only.`}
        </p>
        <Button
          variant="ghost"
          size="sm"
          className="-ml-3 mt-3"
          onClick={() => openSettings("notetaker")}
        >
          Notetaker settings
        </Button>
      </aside>
    </div>
  );
}

function MeetingRow({
  meeting: m,
  now,
  onOpen,
}: {
  meeting: MeetingSummary;
  now: Date;
  onOpen: () => void;
}) {
  const toast = useToast();
  const [deleting, setDeleting] = useState(false);
  const duration = formatMeetingDuration(meetingDurationMs(m));
  return (
    <li id={`meeting-${m.id}`} className="group flex items-center gap-3">
      <button
        type="button"
        onClick={onOpen}
        className="no-drag min-w-0 flex-1 py-3.5 text-left"
      >
        <span className="flex items-baseline gap-3">
          <span className="min-w-0 flex-1 truncate text-ui font-medium text-fg">
            {m.title}
          </span>
          <span className="shrink-0 text-caption text-fg-secondary">
            {meetingWhen(m, now)}
            {duration && ` · ${duration}`}
          </span>
        </span>
        <span className="mt-0.5 block truncate text-caption text-fg-secondary">
          {m.preview || "No notes yet"}
        </span>
      </button>
      <Menu>
        <MenuTrigger asChild>
          <IconButton
            size="sm"
            label={`More actions for ${m.title}`}
            icon={<MoreHorizontal className="size-4" aria-hidden />}
          />
        </MenuTrigger>
        <MenuContent>
          <MenuItem icon={<FileText className="size-3.5" />} onSelect={onOpen}>
            Open
          </MenuItem>
          <MenuItem
            icon={<Download className="size-3.5" />}
            onSelect={() => void exportMeeting(m.id, toast)}
          >
            Export…
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon={<Trash2 className="size-3.5" />}
            destructive
            onSelect={() => setDeleting(true)}
          >
            Delete…
          </MenuItem>
        </MenuContent>
      </Menu>
      <DeleteMeetingDialog
        meeting={deleting ? m : null}
        onClose={() => setDeleting(false)}
        onDeleted={() => toast({ title: "Meeting deleted", tone: "success" })}
      />
    </li>
  );
}

async function exportMeeting(id: string, toast: ReturnType<typeof useToast>) {
  try {
    const r = await hub.exportMeeting(id);
    if (r.saved)
      toast({ title: "Exported", description: r.path, tone: "success" });
  } catch (e) {
    toast({
      title: "Couldn't export the meeting",
      description: ipcErrorMessage(e),
      tone: "error",
    });
  }
}

function DeleteMeetingDialog({
  meeting,
  onClose,
  onDeleted,
}: {
  meeting: Pick<Meeting, "id" | "title"> | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  return (
    <ConfirmDialog
      open={meeting !== null}
      onOpenChange={(o) => !o && onClose()}
      title={`Delete “${meeting?.title ?? ""}”?`}
      description="The meeting and your notes are deleted from this Mac. This can't be undone."
      confirmLabel="Delete meeting"
      destructive
      onConfirm={async () => {
        if (!meeting) return;
        if (!(await hub.deleteMeeting(meeting.id)))
          throw new Error("This meeting was already deleted.");
        onDeleted();
      }}
    />
  );
}

/** One meeting: title, times, your notes (autosaved), and the sections recording will fill. */
function MeetingDetail({
  id,
  rec,
  progress,
  settings,
  openSettings,
  onNeedSetup,
  onBack,
  onDeleted,
}: {
  id: string;
  rec: RecordingState;
  progress: TranscriptionProgress | undefined;
  settings: Settings;
  openSettings: (target: SettingsTarget) => void;
  onNeedSetup: () => void;
  onBack: () => void;
  onDeleted: () => void;
}) {
  const toast = useToast();
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [missing, setMissing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const saver = useRef<Autosaver | null>(null);

  useEffect(() => {
    let live = true;
    let unregister = () => {};
    hub
      .meeting(id)
      .then((m) => {
        if (!live) return;
        if (!m) {
          setMissing(true);
          return;
        }
        setMeeting(m);
        setTitle(m.title);
        setStart(toLocalInput(m.startedAt));
        setEnd(toLocalInput(m.endedAt));
        setNotes(m.notes);
        saver.current = new Autosaver(
          meetingNotesStore(hub.saveMeetingNotes, (saved) => {
            if (live) setMeeting(saved);
          }),
          meetingAsNote(m),
          {
            onState: (state, detail) => {
              if (!live) return;
              setSaveState(state);
              setSaveError(detail.error ?? null);
            },
          },
        );
        const created = saver.current;
        unregister = pendingSaves.add(() => created.flush());
      })
      .catch((e) => live && setLoadError(ipcErrorMessage(e)));
    return () => {
      live = false;
      unregister();
      // Leaving the meeting saves what's typed (the saver lives on until that save ends).
      const s = saver.current;
      saver.current = null;
      if (s) void s.flush().finally(() => s.dispose());
    };
  }, [id]);

  // Recording, transcription and summaries change the meeting in the main process: show them,
  // keeping the notes being typed (their saves never conflict with these changes).
  const refresh = useCallback(() => {
    void hub
      .meeting(id)
      .then((m) => {
        if (!m) return;
        setMeeting((cur) => (cur ? { ...m, notes: cur.notes } : cur));
        const focused = document.activeElement as HTMLInputElement | null;
        if (focused?.type !== "datetime-local") {
          setStart(toLocalInput(m.startedAt));
          setEnd(toLocalInput(m.endedAt));
        }
      })
      .catch(() => {});
  }, [id]);
  useEffect(() => hub.onMeetingsChanged(refresh), [refresh]);
  const recordingThis = rec.meetingId === id;
  const recPhase = recordingThis ? rec.phase : "idle";
  useEffect(() => {
    refresh();
  }, [recPhase, refresh]);

  const back = async () => {
    await saver.current?.flush();
    onBack();
  };

  const saveFields = async (patch: {
    title?: string;
    startedAt?: number | null;
    endedAt?: number | null;
    language?: string | null;
  }) => {
    if (!meeting) return;
    try {
      const m = await hub.updateMeeting({ id: meeting.id, ...patch });
      setMeeting((cur) => (cur ? { ...m, notes: cur.notes } : m));
      setFieldError(null);
    } catch (e) {
      setFieldError(ipcErrorMessage(e));
    }
  };

  const commitTitle = () => {
    if (!meeting) return;
    const t = title.trim();
    if (!t) {
      setTitle(meeting.title);
      return;
    }
    if (t !== meeting.title) void saveFields({ title: t });
  };

  const commitTimes = (nextStart: string, nextEnd: string) => {
    if (!meeting) return;
    const s = fromLocalInput(nextStart);
    const e = fromLocalInput(nextEnd);
    const issue = meetingTimesIssue(s, e);
    if (issue) {
      setFieldError(issue);
      return;
    }
    if (s !== meeting.startedAt || e !== meeting.endedAt)
      void saveFields({ startedAt: s, endedAt: e });
    else setFieldError(null);
  };

  if (missing || loadError)
    return (
      <div>
        <BackButton onClick={onBack} />
        <InlineAlert tone="danger" icon={<AlertCircle />}>
          {missing
            ? "This meeting no longer exists."
            : `Couldn't open the meeting: ${loadError}`}
        </InlineAlert>
      </div>
    );
  if (!meeting)
    return (
      <div>
        <BackButton onClick={onBack} />
        <Skeleton className="h-64 rounded-card" />
      </div>
    );

  const duration = formatMeetingDuration(meetingDurationMs(meeting));
  return (
    <div data-meeting-detail={meeting.id}>
      <BackButton onClick={() => void back()} />
      <div className="flex items-start gap-3">
        <Input
          aria-label="Meeting title"
          value={title}
          maxLength={MEETING_TITLE_MAX}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              e.preventDefault();
              setTitle(meeting.title);
              e.currentTarget.blur();
            }
          }}
          className="h-auto flex-1 border-transparent bg-transparent px-0 text-title font-semibold shadow-none focus:bg-transparent"
        />
        <Button
          icon={<Download className="size-3.5" aria-hidden />}
          onClick={async () => {
            await saver.current?.flush();
            await exportMeeting(meeting.id, toast);
          }}
        >
          Export…
        </Button>
        <IconButton
          label="Delete meeting"
          icon={<Trash2 className="size-4" aria-hidden />}
          disabled={recordingThis}
          onClick={() => setDeleting(true)}
        />
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-caption text-fg-secondary">
          Started
          <Input
            type="datetime-local"
            value={start}
            disabled={recordingThis}
            onChange={(e) => setStart(e.target.value)}
            onBlur={() => commitTimes(start, end)}
            className="w-56"
          />
        </label>
        <label className="flex flex-col gap-1 text-caption text-fg-secondary">
          Ended
          <Input
            type="datetime-local"
            value={end}
            disabled={recordingThis}
            onChange={(e) => setEnd(e.target.value)}
            onBlur={() => commitTimes(start, end)}
            className="w-56"
          />
        </label>
        {duration && (
          <span className="pb-2 text-ui text-fg-secondary">{duration}</span>
        )}
        <label className="ml-auto flex flex-col gap-1 text-caption text-fg-secondary">
          Language
          <Select
            className="w-60"
            value={languageToOption(meeting.language)}
            disabled={
              recordingThis ||
              meeting.status === "recording" ||
              meeting.status === "processing"
            }
            onChange={(e) =>
              void saveFields({ language: optionToLanguage(e.target.value) })
            }
          >
            {meetingLanguageOptions(
              settings.speech.provider,
              settings.speech.language,
              meeting.language,
            ).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </label>
      </div>
      {fieldError && (
        <p role="alert" className="mt-2 text-caption text-danger">
          {fieldError}
        </p>
      )}

      <RecordingPanel
        meeting={meeting}
        rec={rec}
        settings={settings}
        onNeedSetup={onNeedSetup}
      />

      <section aria-labelledby="meeting-notes-title" className="mt-8">
        <div className="mb-2 flex items-baseline gap-3">
          <h2
            id="meeting-notes-title"
            className="flex-1 text-ui font-semibold text-fg"
          >
            Your notes
          </h2>
          <span
            role="status"
            className={
              saveState === "error" || saveState === "conflict"
                ? "text-caption text-danger"
                : "text-caption text-fg-secondary"
            }
          >
            {saveStateLabel(saveState)}
          </span>
        </div>
        {saveState === "conflict" && (
          <div className="mb-3">
            <InlineAlert
              tone="warning"
              icon={<AlertCircle />}
              action={
                <span className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={() => void saver.current?.keepMine()}
                  >
                    Keep mine
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => {
                      const s = saver.current;
                      if (s) setNotes(s.useSaved());
                    }}
                  >
                    Use saved
                  </Button>
                </span>
              }
            >
              These notes were changed somewhere else.
            </InlineAlert>
          </div>
        )}
        {saveState === "error" && saveError && (
          <p role="alert" className="mb-2 text-caption text-danger">
            {saveErrorText(saveError)}
          </p>
        )}
        <Textarea
          aria-labelledby="meeting-notes-title"
          value={notes}
          placeholder="Write your notes: agenda, decisions, action items…"
          onChange={(e) => {
            setNotes(e.target.value);
            saver.current?.change(e.target.value);
          }}
          className="min-h-[280px] w-full resize-y text-body leading-relaxed"
        />
      </section>

      <TranscriptSection meeting={meeting} progress={progress} />
      <SummarySection meeting={meeting} openSettings={openSettings} />

      <DeleteMeetingDialog
        meeting={deleting ? meeting : null}
        onClose={() => setDeleting(false)}
        onDeleted={() => {
          saver.current?.dispose();
          saver.current = null;
          onDeleted();
        }}
      />
    </div>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      icon={<ArrowLeft className="size-3.5" aria-hidden />}
      onClick={onClick}
      className="-ml-3 mb-4"
    >
      Notetaker
    </Button>
  );
}
