// History: every dictation stored on this Mac. Search and status filters run in SQLite (one page
// at a time, Unicode-aware); a row opens a side sheet with the full transcript, its versions,
// details and actions. Failed dictations keep their encrypted recording for retrying until the
// retention period ends.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  AlertCircle,
  Copy,
  Download,
  MoreHorizontal,
  PanelRightOpen,
  PowerOff,
  RotateCw,
  SearchX,
  Trash2,
  Wand2,
} from "lucide-react";
import type { DictationRow } from "../../../shared/ipc.ts";
import type { Settings } from "../../../shared/settings.ts";
import { hub } from "../bridge.ts";
import {
  Button,
  cn,
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  EmptyState,
  IconButton,
  InlineAlert,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
  SearchToggle,
  type SearchToggleHandle,
  SegmentedControl,
  SheetContent,
  StatusDot,
  ListGroup,
  UnderlineTabs,
  useToast,
  SortMenu,
  useStoredChoice,
} from "../ui/index.ts";
import { ipcErrorMessage } from "../model/errors.ts";
import type { SettingsTarget } from "../model/settings-sections.ts";
import {
  cleanupLabel,
  dayLabel,
  filterStatuses,
  formatSeconds,
  friendlyError,
  groupByDay,
  HISTORY_FILTERS,
  noRecordingNote,
  previewText,
  retryInfo,
  rowMeta,
  statusInfo,
  transcriptVersions,
  type HistoryFilter,
} from "../model/history.ts";
import { ListSkeleton, LoadError } from "./library.tsx";
import { useStatus } from "./shared.tsx";
import {
  PlaybackProgress,
  PlaybackReadout,
  PlayRecordingButton,
  useRecordingPlayback,
} from "./recording-playback.tsx";

const PAGE = 100;

/** History pages come from SQLite in this order (paging keeps it). */
const HISTORY_ORDERS = [
  { id: "newest", label: "Newest first" },
  { id: "oldest", label: "Oldest first" },
] as const;
type HistoryOrder = (typeof HISTORY_ORDERS)[number]["id"];

interface Page {
  rows: DictationRow[];
  total: number;
  /** Rows in History at all, to tell "nothing yet" from "nothing matches". */
  everything: number;
}

/**
 * The dictation history (Stage 4: part of the Dictation page): filters, search, day groups,
 * paging, row actions, details, retry, delete, export and delete-all, unchanged in behaviour.
 */
export function HistoryFeed({
  settings,
  update,
  openSettings,
  focusId,
  onFocusHandled,
  firstRun,
}: {
  settings: Settings;
  update: (p: unknown) => Promise<void>;
  openSettings: (target: SettingsTarget) => void;
  /** A dictation to scroll to and highlight (`history/<id>` deep links). */
  focusId?: string;
  onFocusHandled?: () => void;
  /** Shown instead of the list while History has no dictations at all. */
  firstRun: ReactNode;
}) {
  const toast = useToast();
  const { status } = useStatus();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const [order, setOrder] = useStoredChoice<HistoryOrder>(
    "murmur.sort.history",
    HISTORY_ORDERS.map((o) => o.id),
    "newest",
  );
  const [pages, setPages] = useState(1);
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<DictationRow | null>(null);
  const [clearing, setClearing] = useState(false);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const searchRef = useRef<SearchToggleHandle>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** Where focus goes once a deleted row is gone; decided before the list reloads. */
  const afterDelete = useRef<string | null>(null);

  // Typing settles for 150 ms before querying.
  useEffect(() => {
    const t = setTimeout(() => setSearch(query), 150);
    return () => clearTimeout(t);
  }, [query]);
  useEffect(() => setPages(1), [search, filter, order]);

  const load = useCallback(async () => {
    try {
      const [result, all] = await Promise.all([
        hub.queryHistory({
          search: search || undefined,
          statuses: filterStatuses(filter),
          order,
          limit: PAGE * pages,
        }),
        hub.queryHistory({ limit: 1 }),
      ]);
      setPage({ ...result, everything: all.total });
      setError(null);
    } catch (e) {
      setError(ipcErrorMessage(e));
    }
  }, [search, filter, pages, order]);
  useEffect(() => {
    void load();
    return hub.onHistoryChanged(() => void load());
  }, [load]);

  // Opened from Home: show everything, then scroll to and highlight that record. A record
  // beyond the loaded page opens directly in the detail sheet.
  useEffect(() => {
    if (!focusId) return;
    if (query || search || filter !== "all") {
      setQuery("");
      setSearch("");
      setFilter("all");
      return;
    }
    if (!page) return;
    onFocusHandled?.();
    const el = document.getElementById(`dictation-${focusId}`);
    if (el) {
      el.scrollIntoView({ block: "center" });
      setHighlighted(focusId);
      return;
    }
    void hub.getDictation(focusId).then((row) => {
      if (row) setSelected(row.id);
      else toast({ title: "That dictation is no longer in History." });
    });
  }, [focusId, page, query, search, filter, onFocusHandled, toast]);
  useEffect(() => {
    if (!highlighted) return;
    const t = setTimeout(() => setHighlighted(null), 2400);
    return () => clearTimeout(t);
  }, [highlighted]);

  const groups = useMemo(
    () => groupByDay(page?.rows ?? [], new Date()),
    [page],
  );

  const copy = async (row: DictationRow, which: "final" | "raw") => {
    try {
      const ok = await hub.copyDictation(row.id, which);
      toast(
        ok
          ? { title: "Copied to the clipboard", tone: "success" }
          : { title: "Nothing to copy", tone: "error" },
      );
    } catch (e) {
      toast({
        title: "Couldn't copy",
        description: ipcErrorMessage(e),
        tone: "error",
      });
    }
  };
  const exportAll = async () => {
    try {
      const r = await hub.exportData();
      if (r.saved)
        toast({
          title: "History exported",
          description: r.path,
          tone: "success",
        });
    } catch (e) {
      toast({
        title: "Export failed",
        description: ipcErrorMessage(e),
        tone: "error",
      });
    }
  };
  /** The row after (or before) a deleted one: where focus continues. */
  const neighbourOf = (id: string) => {
    const rows = page?.rows ?? [];
    const i = rows.findIndex((r) => r.id === id);
    const next = rows[i + 1] ?? rows[i - 1];
    return next ? `dictation-${next.id}` : "";
  };
  const restoreAfterDelete = (e: Event) => {
    const target = afterDelete.current;
    if (target === null) return;
    afterDelete.current = null;
    e.preventDefault();
    // The list reloads after the delete; focus once it has.
    setTimeout(() => {
      const row = target
        ? document.querySelector<HTMLElement>(`#${target} [data-row-button]`)
        : null;
      (row ?? searchRef.current)?.focus();
    }, 150);
  };

  const onListKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const buttons = [
      ...(listRef.current?.querySelectorAll<HTMLElement>("[data-row-button]") ??
        []),
    ];
    const i = buttons.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    e.preventDefault();
    buttons[e.key === "ArrowDown" ? i + 1 : i - 1]?.focus();
  };

  const filterLabel =
    HISTORY_FILTERS.find((f) => f.id === filter)?.label ?? "All";
  const historyMenu = (
    <Menu>
      <MenuTrigger asChild>
        <IconButton
          label="More history actions"
          icon={<MoreHorizontal className="size-[18px]" aria-hidden />}
        />
      </MenuTrigger>
      <MenuContent>
        <MenuItem icon={<Download className="size-3.5" />} onSelect={exportAll}>
          Export all as JSON…
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          icon={<Trash2 className="size-3.5" />}
          destructive
          disabled={!page?.everything}
          onSelect={() => setClearing(true)}
        >
          Delete all history…
        </MenuItem>
      </MenuContent>
    </Menu>
  );
  return (
    <div>
      {!settings.history.enabled && (
        <div className="mb-4">
          <InlineAlert
            tone="warning"
            icon={<PowerOff />}
            action={
              <Button
                size="sm"
                onClick={() => update({ history: { enabled: true } })}
              >
                Turn on
              </Button>
            }
          >
            History is off. New dictations aren't saved, so they can't be found
            or retried here.
          </InlineAlert>
        </div>
      )}

      {error ? (
        <LoadError message={error} what="history" onRetry={load} />
      ) : page === null ? (
        <ListSkeleton />
      ) : page.everything === 0 ? (
        firstRun
      ) : (
        <>
          <div className="mb-5">
            <UnderlineTabs
              label="Show"
              value={filter}
              onChange={setFilter}
              options={HISTORY_FILTERS.map((f) => ({
                value: f.id,
                label: f.label,
              }))}
              tools={
                <>
                  <span
                    className="mr-1 whitespace-nowrap text-caption text-fg-secondary"
                    aria-live="polite"
                  >
                    {page.total === page.everything
                      ? `${page.total.toLocaleString()} dictation${page.total === 1 ? "" : "s"}`
                      : `${page.total.toLocaleString()} of ${page.everything.toLocaleString()}`}
                  </span>
                  <SortMenu
                    label="Sort dictations"
                    options={HISTORY_ORDERS}
                    value={order}
                    onChange={setOrder}
                  />
                  <SearchToggle
                    ref={searchRef}
                    value={query}
                    onValueChange={setQuery}
                    placeholder="Search text or app"
                    label="Search history"
                  />
                  {historyMenu}
                </>
              }
            />
          </div>

          {page.rows.length === 0 ? (
            <section aria-label="No results" className="rounded-lg bg-surface">
              <EmptyState
                icon={<SearchX className="size-5" aria-hidden />}
                title={
                  query.trim()
                    ? `Nothing matches “${query.trim()}”`
                    : `No ${filterLabel.toLowerCase()} dictations`
                }
                description={
                  query.trim()
                    ? "Search looks at what you said, what was inserted, and the app name."
                    : "Dictations with this status will appear here."
                }
                action={
                  <div className="flex flex-wrap justify-center gap-2">
                    {query && (
                      <Button
                        onClick={() => {
                          setQuery("");
                          searchRef.current?.focus();
                        }}
                      >
                        Clear search
                      </Button>
                    )}
                    {filter !== "all" && (
                      <Button onClick={() => setFilter("all")}>Show all</Button>
                    )}
                  </div>
                }
              />
            </section>
          ) : (
            <div ref={listRef} onKeyDown={onListKey} className="space-y-6">
              {groups.map((g) => (
                <section key={g.label} aria-label={g.label}>
                  <h2 className="mb-2 px-0.5 text-micro font-medium uppercase text-fg-secondary">
                    {g.label}
                  </h2>
                  <ListGroup>
                    {g.rows.map((row) => (
                      <HistoryRow
                        key={row.id}
                        row={row}
                        highlighted={highlighted === row.id}
                        onOpen={() => setSelected(row.id)}
                        onCopy={(which) => void copy(row, which)}
                        onDelete={() => setDeleting(row)}
                      />
                    ))}
                  </ListGroup>
                </section>
              ))}
              {page.rows.length < page.total && (
                <div className="flex justify-center">
                  <Button onClick={() => setPages((p) => p + 1)}>
                    Show{" "}
                    {Math.min(
                      PAGE,
                      page.total - page.rows.length,
                    ).toLocaleString()}{" "}
                    more
                  </Button>
                </div>
              )}
            </div>
          )}
        </>
      )}

      <HistoryDetail
        id={selected}
        onClose={() => setSelected(null)}
        onCopy={(row, which) => void copy(row, which)}
        onDelete={(row) => setDeleting(row)}
        openSettings={openSettings}
        currentProvider={settings.speech.provider}
        settings={settings}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this dictation?"
        description={
          deleting?.hasAudio
            ? "Its transcript and the encrypted recording kept for retrying will be deleted from this Mac. This can't be undone."
            : "Its transcript will be deleted from this Mac. This can't be undone."
        }
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          const target = neighbourOf(deleting.id);
          await hub.deleteDictation(deleting.id);
          afterDelete.current = target;
          if (selected === deleting.id) setSelected(null);
          toast({ title: "Dictation deleted", tone: "success" });
        }}
        onCloseAutoFocus={restoreAfterDelete}
      />
      <ConfirmDialog
        open={clearing}
        onOpenChange={setClearing}
        title="Delete all history?"
        description={`All ${page?.everything.toLocaleString() ?? ""} dictations and any encrypted recordings kept for retrying will be deleted from this Mac. Your dictionary and snippets are kept. This can't be undone.`}
        confirmLabel="Delete all"
        destructive
        onConfirm={async () => {
          await hub.clearHistory();
          toast({ title: "History deleted", tone: "success" });
        }}
      />
    </div>
  );
}

function HistoryRow({
  row,
  highlighted,
  onOpen,
  onCopy,
  onDelete,
}: {
  row: DictationRow;
  highlighted: boolean;
  onOpen: () => void;
  onCopy: (which: "final" | "raw") => void;
  onDelete: () => void;
}) {
  const status = statusInfo(row);
  const preview = previewText(row);
  const versions = transcriptVersions(row);
  const time = new Date(row.startedAt).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  const playback = useRecordingPlayback(row.id, row.hasAudio);
  const playing = row.hasAudio && playback.state.phase !== "idle";
  // Reference row: 53 pt, time at +17 pt, text at +115 pt, one line. The status shows only
  // when it isn't the usual “Inserted”; details carry the app, length and versions.
  return (
    <li
      id={`dictation-${row.id}`}
      aria-current={highlighted || undefined}
      className={cn(
        "group relative flex min-h-[53px] items-center gap-1 pr-2 transition-[background-color,box-shadow] duration-[var(--m-duration-slow)] hover:bg-surface",
        highlighted && "shadow-[inset_0_0_0_2px_var(--m-focus)]",
      )}
    >
      <button
        type="button"
        data-row-button
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center self-stretch py-2 pl-[17px] text-left focus-visible:outline-offset-[-2px]"
      >
        <span className="w-[98px] shrink-0 text-caption tabular-nums text-fg-secondary">
          {time}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-ui",
            preview.muted ? "text-fg-secondary" : "text-fg",
          )}
        >
          {preview.text}
        </span>
        {row.status === "inserted" ? (
          <span className="sr-only">{`, ${status.label}`}</span>
        ) : (
          <StatusDot
            tone={status.tone}
            label={status.label}
            className="ml-3 shrink-0 group-focus-within:hidden group-hover:hidden"
          />
        )}
        <span className="sr-only">
          {rowMeta(row)
            .map((m) => `, ${m}`)
            .join("")}
        </span>
      </button>
      <div
        className={cn(
          "shrink-0 items-center gap-0.5 group-focus-within:flex group-hover:flex has-[[data-state=open]]:flex",
          playing ? "flex" : "hidden",
        )}
      >
        {row.hasAudio && (
          <PlayRecordingButton id={row.id} time={time} playback={playback} />
        )}
        {row.finalText && (
          <IconButton
            size="sm"
            label="Copy text"
            icon={<Copy className="size-3.5" aria-hidden />}
            onClick={() => onCopy("final")}
          />
        )}
        <Menu>
          <MenuTrigger asChild>
            <IconButton
              size="sm"
              label="More actions"
              icon={<MoreHorizontal className="size-3.5" aria-hidden />}
            />
          </MenuTrigger>
          <MenuContent>
            <MenuItem
              icon={<PanelRightOpen className="size-3.5" />}
              onSelect={onOpen}
            >
              Open details
            </MenuItem>
            {versions.differs && (
              <MenuItem
                icon={<Copy className="size-3.5" />}
                onSelect={() => onCopy("raw")}
              >
                Copy original transcript
              </MenuItem>
            )}
            {row.finalText && <TransformItems dictationId={row.id} />}
            <MenuSeparator />
            <MenuItem
              icon={<Trash2 className="size-3.5" />}
              destructive
              onSelect={onDelete}
            >
              Delete…
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
      {playing && (
        <PlaybackProgress
          state={playback.state}
          className="absolute inset-x-0 bottom-0"
        />
      )}
    </li>
  );
}

type View = "refined" | "original" | "both";

function HistoryDetail({
  id,
  onClose,
  onCopy,
  onDelete,
  openSettings,
  currentProvider,
  settings,
}: {
  id: string | null;
  onClose: () => void;
  onCopy: (row: DictationRow, which: "final" | "raw") => void;
  onDelete: (row: DictationRow) => void;
  openSettings: (target: SettingsTarget) => void;
  currentProvider: string;
  settings: Settings;
}) {
  const [row, setRow] = useState<DictationRow | null | undefined>(undefined);
  const [view, setView] = useState<View>("refined");
  const [retrying, setRetrying] = useState(false);
  /** Result of the last retry in this sheet; a failure is shown in the error block. */
  const [outcome, setOutcome] = useState<
    { ok: true } | { ok: false; message: string | null } | null
  >(null);

  const idRef = useRef(id);
  idRef.current = id;

  useEffect(() => {
    // A different dictation starts clean: no retry result or busy state carries over.
    setOutcome(null);
    setRetrying(false);
    if (!id) {
      setRow(undefined);
      setView("refined");
      return;
    }
    const load = () =>
      void hub
        .getDictation(id)
        .then((r) => idRef.current === id && setRow(r))
        .catch(() => idRef.current === id && setRow(null));
    load();
    return hub.onHistoryChanged(load);
  }, [id]);

  const retry = async () => {
    if (!row) return;
    const retryId = row.id;
    setRetrying(true);
    setOutcome(null);
    try {
      const after = await hub.retryDictation(retryId);
      // The sheet may have moved to another dictation while this one was running.
      if (idRef.current !== retryId) return;
      // Success is only claimed when the main process reports a transcript it copied.
      if (after?.status === "copied" && after.finalText) {
        setOutcome({ ok: true });
        setView("refined");
      } else setOutcome({ ok: false, message: null });
      if (after) setRow(after);
    } catch (e) {
      if (idRef.current === retryId)
        setOutcome({ ok: false, message: ipcErrorMessage(e) });
    } finally {
      if (idRef.current === retryId) setRetrying(false);
    }
  };

  const status = row ? statusInfo(row) : null;
  const versions = row ? transcriptVersions(row) : null;
  const error = row ? friendlyError(row) : null;
  const retryState = row ? retryInfo(row, currentProvider) : null;
  const when = row
    ? `${dayLabel(row.startedAt, new Date())}, ${new Date(row.startedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
    : "Dictation";
  const settingsLink =
    row?.error?.startsWith("not-configured:") ||
    row?.error?.startsWith("too-long:") ||
    /HTTP (401|403|404)\b/.test(row?.error ?? "");
  const copyWhich = view === "original" ? "raw" : "final";
  const playback = useRecordingPlayback(id ?? "", Boolean(row?.hasAudio));
  const clockTime = row
    ? new Date(row.startedAt).toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      })
    : "";

  return (
    <Dialog open={id !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        // Start on the sheet itself (announced by its title), not on the close button.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          document.querySelector<HTMLElement>('[role="dialog"]')?.focus();
        }}
      >
        <DialogHeader
          title={when}
          description={
            status ? (
              <StatusDot tone={status.tone} label={status.label} />
            ) : undefined
          }
          onCloseLabel="Close details"
        />
        <DialogBody className="space-y-5">
          {row === null && (
            <p className="text-ui text-fg-secondary">
              This dictation is no longer in History.
            </p>
          )}
          {row && (
            <>
              {outcome?.ok && (
                <p
                  role="status"
                  className="rounded-md bg-success-soft px-3 py-2 text-ui text-fg"
                >
                  Transcribed again and copied to the clipboard. Paste it with
                  ⌘V.
                </p>
              )}
              {status?.explanation && (
                <p className="text-ui text-fg-secondary">
                  {status.explanation}
                </p>
              )}
              {(error || outcome?.ok === false) && (
                <div
                  role={outcome?.ok === false ? "alert" : undefined}
                  className="space-y-2 rounded-md bg-danger-soft px-3 py-2.5"
                >
                  <p className="flex items-start gap-2 text-ui text-fg">
                    <AlertCircle
                      className="mt-px size-4 shrink-0 text-danger"
                      aria-hidden
                    />
                    <span>
                      {outcome?.ok === false && (
                        <strong className="font-semibold">
                          Retry failed.{" "}
                        </strong>
                      )}
                      {(outcome?.ok === false && outcome.message) ||
                        error?.summary ||
                        "The dictation could not be transcribed."}
                    </span>
                  </p>
                  {settingsLink && (
                    <Button
                      size="sm"
                      onClick={() => openSettings("transcription")}
                    >
                      Open transcription settings
                    </Button>
                  )}
                  {error?.details && (
                    <details className="text-caption text-fg">
                      <summary className="cursor-default">
                        Technical details
                      </summary>
                      <p
                        className="mt-1 whitespace-pre-wrap break-words font-mono"
                        data-selectable
                      >
                        {error.details}
                      </p>
                    </details>
                  )}
                </div>
              )}
              {retryState?.unavailable && (
                <p className="text-ui text-fg-secondary">
                  {retryState.unavailable}
                </p>
              )}

              {versions && (versions.refined || versions.raw) && (
                <section aria-label="Transcript" className="space-y-3">
                  {versions.differs && (
                    <SegmentedControl
                      label="Transcript version"
                      value={view}
                      onChange={setView}
                      options={[
                        { value: "refined", label: "Refined" },
                        { value: "original", label: "Original" },
                        { value: "both", label: "Both" },
                      ]}
                    />
                  )}
                  {versions.differs && view === "both" ? (
                    <div className="space-y-4">
                      <TranscriptBlock
                        label="Original transcript"
                        text={versions.raw ?? ""}
                      />
                      <TranscriptBlock
                        label="Refined"
                        text={versions.refined ?? ""}
                      />
                    </div>
                  ) : versions.differs ? (
                    <TranscriptBlock
                      label={
                        view === "original" ? "Original transcript" : "Refined"
                      }
                      text={
                        (view === "original"
                          ? versions.raw
                          : versions.refined) ?? ""
                      }
                    />
                  ) : (
                    <TranscriptBlock
                      label="Transcript"
                      text={versions.refined ?? versions.raw ?? ""}
                      hideLabel
                    />
                  )}
                  {row.aiRejectedText && (
                    <details className="text-caption text-fg-secondary">
                      <summary className="cursor-default">
                        AI output that was rejected
                      </summary>
                      <p
                        className="mt-1 whitespace-pre-wrap break-words text-ui text-fg"
                        data-selectable
                      >
                        {row.aiRejectedText}
                      </p>
                    </details>
                  )}
                </section>
              )}

              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 border-t border-hairline pt-4 text-ui">
                <Detail label="Application" value={row.appName ?? "Unknown"} />
                <Detail label="Length" value={formatSeconds(row.durationMs)} />
                {row.wordCount > 0 && (
                  <Detail
                    label="Words"
                    value={row.wordCount.toLocaleString()}
                  />
                )}
                {cleanupLabel(row) && (
                  <Detail label="Cleanup" value={cleanupLabel(row) ?? ""} />
                )}
                <Detail
                  label="Recording"
                  value={
                    row.hasAudio
                      ? "Kept on this Mac, encrypted"
                      : noRecordingNote(
                          row,
                          settings.history.audioRetentionDays,
                          Date.now(),
                        )
                  }
                />
              </dl>
              {row.hasAudio && (
                <div className="space-y-2">
                  <div className="flex items-center gap-3">
                    <PlayRecordingButton
                      id={row.id}
                      time={clockTime}
                      playback={playback}
                    />
                    <PlaybackReadout state={playback.state} />
                  </div>
                  <PlaybackProgress state={playback.state} />
                </div>
              )}
            </>
          )}
        </DialogBody>
        {row && (
          <DialogFooter
            start={
              <Button
                variant="danger"
                icon={<Trash2 className="size-3.5" aria-hidden />}
                onClick={() => onDelete(row)}
              >
                Delete…
              </Button>
            }
          >
            {retryState?.canRetry && (
              <Button
                icon={<RotateCw className="size-3.5" aria-hidden />}
                loading={retrying}
                onClick={retry}
              >
                {retrying ? "Transcribing…" : retryState.label}
              </Button>
            )}
            {(copyWhich === "raw" ? versions?.raw : row.finalText) && (
              <Button
                variant="primary"
                icon={<Copy className="size-3.5" aria-hidden />}
                onClick={() => onCopy(row, copyWhich)}
              >
                {copyWhich === "raw" ? "Copy original" : "Copy"}
              </Button>
            )}
          </DialogFooter>
        )}
      </SheetContent>
    </Dialog>
  );
}

function TranscriptBlock({
  label,
  text,
  hideLabel,
}: {
  label: string;
  text: string;
  hideLabel?: boolean;
}) {
  return (
    <div>
      <h3
        className={cn(
          "mb-1.5 text-micro font-medium uppercase text-fg-secondary",
          hideLabel && "sr-only",
        )}
      >
        {label}
      </h3>
      <p
        className="whitespace-pre-wrap break-words text-body text-fg"
        data-selectable
      >
        {text}
      </p>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-fg-secondary">{label}</dt>
      <dd className="min-w-0 break-words text-fg">{value}</dd>
    </>
  );
}

/**
 * "Transform with" (Stage 9C): the dictation's text in the Transform panel, on request. The
 * dictation itself is never changed; the result can be copied.
 */
function TransformItems({ dictationId }: { dictationId: string }) {
  const toast = useToast();
  const [list, setList] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    void hub.transforms().then(
      (all) => setList(all.map(({ id, name }) => ({ id, name }))),
      () => setList([]),
    );
  }, []);
  if (!list.length) return null;
  return (
    <>
      <MenuSeparator />
      <MenuLabel>Transform with</MenuLabel>
      {list.map((t) => (
        <MenuItem
          key={t.id}
          icon={<Wand2 className="size-3.5" />}
          onSelect={() =>
            void hub.transformDictation(dictationId, t.id).catch((e) =>
              toast({
                title: "Couldn't start the Transform",
                description: ipcErrorMessage(e),
                tone: "error",
              }),
            )
          }
        >
          <span className="block max-w-72 truncate" title={t.name}>
            {t.name}
          </span>
        </MenuItem>
      ))}
    </>
  );
}
