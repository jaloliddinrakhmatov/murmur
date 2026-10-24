// Scratchpad page (Stage 9B, reference 12): the global shortcut, a banner that starts a note,
// and Recents — every note on this Mac, newest first, with search, open, rename, export and
// delete. Notes are edited in the note window (main/windows/scratchpad.ts).
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Download,
  ExternalLink,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import type { NoteSummary } from "../../../shared/notes.ts";
import type { Settings } from "../../../shared/settings.ts";
import { hub } from "../bridge.ts";
import {
  Banner,
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogError,
  DialogFooter,
  DialogHeader,
  IconButton,
  InlineAlert,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  SearchToggle,
  Skeleton,
  type SearchToggleHandle,
  useToast,
} from "../ui/index.ts";
import { PageHeader } from "../shell/shell.tsx";
import { ipcErrorMessage } from "../model/errors.ts";
import { noteWhen } from "../model/scratchpad.ts";
import {
  ActionField,
  clearActionShortcut,
  MessageLine,
  saveActionShortcut,
  type ShortcutMessage,
} from "../settings/shortcuts-dialog.tsx";
import { useStatus } from "./shared.tsx";

export function ScratchpadPage({ settings }: { settings: Settings }) {
  const toast = useToast();
  const { status } = useStatus();
  const [search, setSearch] = useState("");
  const [notes, setNotes] = useState<NoteSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<ShortcutMessage>(null);
  const [renaming, setRenaming] = useState<NoteSummary | null>(null);
  const [deleting, setDeleting] = useState<NoteSummary | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const searchRef = useRef<SearchToggleHandle>(null);
  const newRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    try {
      setNotes(await hub.listNotes(search));
      setError(null);
    } catch (e) {
      setError(ipcErrorMessage(e));
    }
  }, [search]);
  useEffect(() => {
    void load();
    return hub.onNotesChanged(() => void load());
  }, [load]);

  const startNote = () => void hub.showNote({ new: true });
  const bound = status?.actions.openScratchpad ?? null;
  const now = new Date();

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            Scratchpad
            <span className="inline-flex h-6 items-center rounded-sm bg-fg px-1.5 text-caption font-medium text-canvas">
              Beta
            </span>
          </span>
        }
        actions={
          <div className="flex flex-col items-end">
            <ActionField
              action="openScratchpad"
              current={bound?.combo ?? settings.shortcuts.openScratchpad}
              placeholder="Click to enable shortcut"
              save={(combo) =>
                saveActionShortcut("openScratchpad", combo, setMessage)
              }
              clear={() =>
                void clearActionShortcut("openScratchpad", setMessage)
              }
              onMessage={setMessage}
              variant="pill"
            />
            <span id="shortcut-openScratchpad-desc" className="sr-only">
              Opens or closes the Scratchpad note window from any app.
            </span>
            {message ? (
              <span className="mt-1 max-w-[260px] text-right text-caption">
                <MessageLine message={message} />
              </span>
            ) : (
              bound &&
              !bound.registered && (
                <span role="status" className="mt-1 text-caption text-danger">
                  Not active
                </span>
              )
            )}
          </div>
        }
      />
      <Banner
        scene="scratchpad"
        // Reference 12: 226 pt tall, 26 pt below the header row (y 153 pt).
        className="-mt-[19px] min-h-[226px]"
        title="For quick thoughts you want to keep"
        actions={
          <Button variant="banner" onClick={startNote}>
            Start new note
          </Button>
        }
        aside={<NotePreviewArt />}
      >
        <p>
          Jot a list, draft a message before you send it, or think out loud.
          Notes stay on this Mac and are saved as you type or dictate.
        </p>
      </Banner>

      <section aria-labelledby="recents-title" className="mt-10">
        <div className="flex items-center gap-1 border-b border-hairline pb-2">
          <h2
            id="recents-title"
            className="flex-1 text-ui font-semibold text-fg"
          >
            Recents
          </h2>
          <SearchToggle
            ref={searchRef}
            value={search}
            onValueChange={setSearch}
            label="Search notes"
            placeholder="Search notes"
          />
          <IconButton
            ref={newRef}
            label="New note"
            icon={<Plus className="size-[18px]" aria-hidden />}
            onClick={startNote}
          />
          <IconButton
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
              Couldn't load your notes: {error}
            </InlineAlert>
          </div>
        ) : !notes ? (
          <Skeleton className="mt-4 h-40 rounded-list" />
        ) : notes.length === 0 ? (
          <p className="py-24 text-center text-ui text-fg-secondary">
            {search ? `No notes match “${search}”` : "No notes found"}
          </p>
        ) : (
          <ul aria-label="Notes" className="divide-y divide-hairline">
            {notes.map((n) => (
              <li
                key={n.id}
                id={`note-${n.id}`}
                className="group flex items-center gap-3"
              >
                <button
                  type="button"
                  onClick={() => void hub.showNote({ id: n.id })}
                  className="no-drag min-w-0 flex-1 py-3.5 text-left"
                >
                  <span className="flex items-baseline gap-3">
                    <span className="min-w-0 flex-1 truncate text-ui font-medium text-fg">
                      {n.title}
                    </span>
                    <span className="shrink-0 text-caption text-fg-secondary">
                      {noteWhen(n.updatedAt, now)}
                    </span>
                  </span>
                  {n.preview && (
                    <span className="mt-0.5 block truncate text-caption text-fg-secondary">
                      {n.preview}
                    </span>
                  )}
                </button>
                <Menu>
                  <MenuTrigger asChild>
                    <IconButton
                      size="sm"
                      label={`More actions for ${n.title}`}
                      icon={<MoreHorizontal className="size-4" aria-hidden />}
                    />
                  </MenuTrigger>
                  <MenuContent>
                    <MenuItem
                      icon={<ExternalLink className="size-3.5" />}
                      onSelect={() => void hub.showNote({ id: n.id })}
                    >
                      Open
                    </MenuItem>
                    <MenuItem
                      icon={<Pencil className="size-3.5" />}
                      onSelect={() => setRenaming(n)}
                    >
                      Rename…
                    </MenuItem>
                    <MenuItem
                      icon={<Download className="size-3.5" />}
                      onSelect={async () => {
                        try {
                          const r = await hub.exportNote(n.id);
                          if (r.saved)
                            toast({
                              title: "Exported",
                              description: r.path,
                              tone: "success",
                            });
                        } catch (e) {
                          toast({
                            title: "Couldn't export the note",
                            description: ipcErrorMessage(e),
                            tone: "error",
                          });
                        }
                      }}
                    >
                      Export…
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem
                      icon={<Trash2 className="size-3.5" />}
                      destructive
                      onSelect={() => setDeleting(n)}
                    >
                      Delete…
                    </MenuItem>
                  </MenuContent>
                </Menu>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete “${deleting?.title ?? ""}”?`}
        description="The note is deleted from this Mac. This can't be undone."
        confirmLabel="Delete note"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          if (!(await hub.deleteNote(deleting.id)))
            throw new Error("This note was already deleted.");
          toast({ title: "Note deleted", tone: "success" });
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          newRef.current?.focus();
        }}
      />
      <RenameNoteDialog
        note={renaming}
        onClose={() => setRenaming(null)}
        onSave={async (title) => {
          if (renaming) await hub.renameNote(renaming.id, title);
        }}
      />
    </div>
  );
}

function RenameNoteDialog({
  note,
  onClose,
  onSave,
}: {
  note: NoteSummary | null;
  onClose: () => void;
  onSave: (title: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (note) {
      setValue(note.title === "Untitled" ? "" : note.title);
      setError(null);
    }
  }, [note]);
  return (
    <Dialog open={note !== null} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent size="sm">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await onSave(value);
              onClose();
            } catch (err) {
              setError(ipcErrorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <DialogHeader
            title="Rename note"
            description="Leave it empty to use the first line as the name."
          />
          <Input
            aria-label="Note name"
            autoFocus
            maxLength={120}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <DialogError message={error} />
          <DialogFooter>
            <Button type="button" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={busy}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Original artwork: the top of a note window, drawn in CSS (no screenshot content). */
function NotePreviewArt() {
  return (
    <div className="h-[77px] w-[256px] overflow-hidden rounded-t-xl bg-canvas px-3 pt-2.5 text-fg shadow-popover">
      <div className="flex items-center gap-2.5">
        <span className="size-2 rounded-full bg-fg-tertiary" />
        <span className="h-1.5 w-12 rounded-full bg-surface-strong" />
        <span className="ml-auto h-1.5 w-4 rounded-full bg-surface-strong" />
      </div>
      <div className="mt-2.5 space-y-1.5 rounded-t-lg bg-sheet px-3 pb-4 pt-3">
        <span className="block h-1.5 w-[86%] rounded-full bg-surface-strong" />
        <span className="block h-1.5 w-[72%] rounded-full bg-surface-strong" />
        <span className="block h-1.5 w-[80%] rounded-full bg-surface-strong" />
      </div>
    </div>
  );
}
