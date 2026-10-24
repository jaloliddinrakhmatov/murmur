// The Scratchpad note window (Stage 9B, reference 13): tabs of notes, a rail (notes list, new
// note, search, AI edits, text style) and a plain-text editor with Copy. Text is saved as it is
// typed (model/scratchpad.ts). Dictation lands at the cursor through the main process; AI edits
// run only when picked, show their result first, and are applied as one undoable edit.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  CaseSensitive,
  Copy,
  Download,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Plus,
  Search,
  Sparkles,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import {
  countNoteWords,
  noteTitle,
  type Note,
  type NoteSummary,
} from "../../shared/notes.ts";
import {
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogError,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
  Textarea,
  ToastProvider,
  Tooltip,
  TooltipProvider,
  cn,
  useToast,
} from "../hub/ui/index.ts";
import { MurmurMark } from "../hub/shell/shell.tsx";
import { ipcErrorMessage } from "../hub/model/errors.ts";
import {
  Autosaver,
  nextActiveTab,
  noteWhen,
  parseNoteRoute,
  saveErrorText,
  saveStateLabel,
  spacedInsertion,
  type SaveState,
} from "../hub/model/scratchpad.ts";
import { TRANSFORM_TEXT_MAX } from "../../shared/transforms.ts";
import { api, type NoteOpen, type NotePrefs } from "./bridge.ts";

interface Tab {
  key: string;
  noteId: string | null;
  title: string | null;
  body: string;
  state: SaveState;
  error?: string;
}

const FONT: Record<NotePrefs["font"], string> = {
  sans: "font-sans",
  serif: "font-serif",
  mono: "font-mono",
};
const SIZE: Record<NotePrefs["size"], string> = {
  small: "text-[14px] leading-[22px]",
  medium: "text-[16px] leading-[26px]",
  large: "text-[19px] leading-[30px]",
};

let tabCounter = 0;
const newKey = () => `tab-${++tabCounter}`;

export function NoteApp() {
  return (
    <TooltipProvider>
      <ToastProvider>
        <Notes />
      </ToastProvider>
    </TooltipProvider>
  );
}

function Notes() {
  const toast = useToast();
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<NotePrefs | null>(null);
  const [sidebar, setSidebar] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [closing, setClosing] = useState<string | null>(null);
  const [ai, setAi] = useState<AiRun | null>(null);
  const pendingApply = useRef<{
    mode: "replace" | "below";
    text: string;
    range: [number, number];
  } | null>(null);
  const [customAi, setCustomAi] = useState(false);
  const [consent, setConsent] = useState<
    (AiStatus & { go: () => void }) | null
  >(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const savers = useRef(new Map<string, Autosaver>());
  const selections = useRef(new Map<string, [number, number]>());
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeRef = useRef(active);
  activeRef.current = active;

  const current = tabs.find((t) => t.key === active) ?? null;

  const patchTab = useCallback((key: string, patch: Partial<Tab>) => {
    setTabs((list) =>
      list.map((t) => (t.key === key ? { ...t, ...patch } : t)),
    );
  }, []);

  const addTab = useCallback(
    (note: Note | null) => {
      const key = newKey();
      const saver = new Autosaver(
        {
          create: (body) => api.create(body),
          save: (id, body, rev) => api.save(id, body, rev),
        },
        note,
        {
          onState: (state, { note: n, error }) =>
            patchTab(key, {
              state,
              error,
              noteId: n?.id ?? null,
              title: n?.title ?? null,
            }),
        },
      );
      savers.current.set(key, saver);
      setTabs((list) => [
        ...list,
        {
          key,
          noteId: note?.id ?? null,
          title: note?.title ?? null,
          body: note?.body ?? "",
          state: note ? "saved" : "empty",
        },
      ]);
      setActive(key);
      return key;
    },
    [patchTab],
  );

  /** A new note: reuses the current tab when it is an empty, unsaved one. */
  const newNote = useCallback(() => {
    const cur = tabsRef.current.find((t) => t.key === activeRef.current);
    if (cur && !cur.noteId && !cur.body.trim()) setActive(cur.key);
    else addTab(null);
    requestAnimationFrame(() => editor.current?.focus());
  }, [addTab]);

  /** Opens still waiting on the main process, so the same request is never run twice. */
  const opening = useRef(new Map<string, Promise<void>>());
  const once = useCallback(
    (key: string, run: () => Promise<void>): Promise<void> => {
      const running = opening.current.get(key);
      if (running) return running;
      const p = run().finally(() => opening.current.delete(key));
      opening.current.set(key, p);
      return p;
    },
    [],
  );

  const openNote = useCallback(
    (id: string) =>
      once(`id:${id}`, async () => {
        const existing = tabsRef.current.find((t) => t.noteId === id);
        if (existing) {
          setActive(existing.key);
          void api.open(id);
          return;
        }
        const note = await api.open(id);
        if (!note) {
          toast({ title: "This note no longer exists", tone: "error" });
          return;
        }
        // Another request may have opened this note while the main process answered.
        const opened = tabsRef.current.find((t) => t.noteId === note.id);
        if (opened) {
          setActive(opened.key);
          return;
        }
        const cur = tabsRef.current.find((t) => t.key === activeRef.current);
        // An empty new tab is replaced rather than left behind.
        if (cur && !cur.noteId && !cur.body.trim()) {
          savers.current.get(cur.key)?.dispose();
          savers.current.delete(cur.key);
          setTabs((list) => list.filter((t) => t.key !== cur.key));
        }
        addTab(note);
        requestAnimationFrame(() => editor.current?.focus());
      }),
    [addTab, once, toast],
  );

  const handleOpen = useCallback(
    async (open: NoteOpen) => {
      if ("id" in open) return openNote(open.id);
      if ("new" in open) return newNote();
      return once("resume", async () => {
        if (tabsRef.current.length) {
          editor.current?.focus();
          return;
        }
        const note = await api.initial();
        if (note) await openNote(note.id);
        else if (!tabsRef.current.length) newNote();
      });
    },
    [newNote, once, openNote],
  );

  // First open from the address, later ones from the main process.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void handleOpen(parseNoteRoute(location.hash));
    // A reload (or a crash of the page) resumes instead of repeating "new note".
    history.replaceState(null, "", location.pathname + location.search);
    // Without them the editor keeps its defaults.
    void api
      .prefs()
      .then(setPrefs)
      .catch(() => {});
  }, [handleOpen]);
  useEffect(() => api.onOpen((o) => void handleOpen(o)), [handleOpen]);
  useEffect(() => api.onPrefsChanged(setPrefs), []);

  const flushAll = useCallback(async () => {
    await Promise.all([...savers.current.values()].map((s) => s.flush()));
  }, []);
  useEffect(
    () =>
      api.onFlush(async (requestId) => {
        await flushAll();
        if (requestId) api.flushed(requestId);
      }),
    [flushAll],
  );
  useEffect(() => {
    const onBlur = () => void flushAll();
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [flushAll]);

  // Notes deleted or renamed elsewhere (the Hub's Scratchpad page).
  useEffect(
    () =>
      api.onNotesChanged(async () => {
        for (const t of tabsRef.current) {
          if (!t.noteId) continue;
          const note = await api.get(t.noteId);
          const saver = savers.current.get(t.key);
          if (!note) {
            if (!saver?.dirty) closeTabNow(t.key);
          } else if (saver) {
            saver.adopt(note);
            patchTab(t.key, { title: saver.current?.title ?? null });
          }
        }
      }),
    [patchTab],
  );

  // Restore the cursor of the tab being shown.
  useEffect(() => {
    if (!active || !editor.current) return;
    const sel = selections.current.get(active);
    const el = editor.current;
    if (sel) el.setSelectionRange(sel[0], sel[1]);
  }, [active]);

  const rememberSelection = () => {
    const el = editor.current;
    if (el && activeRef.current)
      selections.current.set(activeRef.current, [
        el.selectionStart,
        el.selectionEnd,
      ]);
  };

  const onChange = (body: string) => {
    if (!current) return;
    patchTab(current.key, { body });
    savers.current.get(current.key)?.change(body);
  };

  /**
   * Types `text` into the focused field as one undoable edit: the editor (at its cursor, or
   * replacing [start, end) when given) or, when focus is in another text field of this window,
   * that field. Returns false when nothing could take it.
   */
  const typeInto = useCallback(
    (text: string, range?: [number, number]): boolean => {
      const focused = document.activeElement;
      const el = editor.current;
      const other =
        focused instanceof HTMLInputElement && !range ? focused : null;
      const target: HTMLTextAreaElement | HTMLInputElement | null = other ?? el;
      if (!target) return false;
      if (target === el) {
        target.focus();
        if (range) target.setSelectionRange(range[0], range[1]);
        else {
          const sel = activeRef.current
            ? selections.current.get(activeRef.current)
            : null;
          if (sel && document.activeElement !== el)
            target.setSelectionRange(sel[0], sel[1]);
        }
      }
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? start;
      const insert = range
        ? text
        : spacedInsertion(target.value, start, end, text);
      // execCommand keeps the browser's undo stack (⌘Z undoes the insertion).
      const ok = document.execCommand("insertText", false, insert);
      if (target === el) rememberSelection();
      return ok;
    },
    [],
  );

  useEffect(
    () =>
      api.onInsert(async ({ requestId, text, expiresAt }) => {
        // Too late: Murmur has already used the normal path (a copy) instead.
        if (Date.now() > expiresAt) return;
        const key = activeRef.current;
        const ok = key !== null && typeInto(text);
        if (ok && key) await savers.current.get(key)?.flush();
        api.inserted(requestId, ok);
      }),
    [typeInto],
  );

  const closeTabNow = (key: string) => {
    savers.current.get(key)?.dispose();
    savers.current.delete(key);
    selections.current.delete(key);
    const list = tabsRef.current;
    const next = nextActiveTab(list, key, activeRef.current ?? key);
    setTabs(list.filter((t) => t.key !== key));
    if (next) setActive(next);
    else addTab(null);
  };

  const closeTab = async (key: string) => {
    const saver = savers.current.get(key);
    await saver?.flush();
    if (saver && saver.dirty) setClosing(key);
    else closeTabNow(key);
  };

  const copy = async () => {
    if (!current?.body) return;
    try {
      const ok = await api.copy(current.body);
      toast(
        ok
          ? {
              title: "Copied",
              description: "The whole note is on the clipboard.",
              tone: "success",
            }
          : { title: "Couldn't copy the note", tone: "error" },
      );
    } catch (e) {
      toast({
        title: "Couldn't copy the note",
        description: ipcErrorMessage(e),
        tone: "error",
      });
    }
  };

  const exportNote = async () => {
    if (!current) return;
    const saver = savers.current.get(current.key);
    await saver?.flush();
    const id = saver?.id;
    if (!id) return;
    try {
      const r = await api.exportNote(id);
      if (r.saved)
        toast({ title: "Exported", description: r.path, tone: "success" });
    } catch (e) {
      toast({
        title: "Couldn't export the note",
        description: ipcErrorMessage(e),
        tone: "error",
      });
    }
  };

  // ---- AI edits ---------------------------------------------------------------------------------

  const startAi = async (pick: AiPick) => {
    const el = editor.current;
    if (!current || !el) return;
    const [s, e] = [el.selectionStart, el.selectionEnd];
    const range: [number, number] = s !== e ? [s, e] : [0, current.body.length];
    const text = current.body.slice(range[0], range[1]);
    if (!text.trim()) {
      toast({
        title: "Nothing to edit yet",
        description: "Write or dictate something first.",
      });
      return;
    }
    if (text.length > TRANSFORM_TEXT_MAX) {
      toast({
        title: "Too long for one AI edit",
        description: `Select a part of up to ${TRANSFORM_TEXT_MAX.toLocaleString()} characters.`,
        tone: "error",
      });
      return;
    }
    const run: AiRun = {
      requestId: crypto.randomUUID(),
      tabKey: current.key,
      pick,
      label: "transformId" in pick ? pick.name : "Your change",
      range,
      original: text,
      scope: s !== e ? "selection" : "note",
      result: null,
      error: null,
    };
    setAi(run);
    try {
      const out = await api.ai({
        requestId: run.requestId,
        ...("transformId" in pick
          ? { transformId: pick.transformId }
          : { instruction: pick.instruction }),
        text,
      });
      setAi((r) =>
        r?.requestId === run.requestId ? { ...r, result: out.text } : r,
      );
    } catch (err) {
      const message = ipcErrorMessage(err);
      setAi((r) =>
        r?.requestId === run.requestId
          ? /Cancelled/.test(message)
            ? null
            : { ...r, error: message }
          : r,
      );
    }
  };

  // A transform shortcut pressed while this window is in front: transform the selection here.
  const startAiRef = useRef(startAi);
  startAiRef.current = startAi;
  const aiRef = useRef(ai);
  aiRef.current = ai;
  useEffect(
    () =>
      api.onTransform(async (id) => {
        if (aiRef.current) return; // one at a time
        const [list, status] = await Promise.all([
          api.transforms(),
          api.aiStatus(),
        ]);
        const t = list.find((x) => x.id === id);
        if (!t) return;
        if (status.ready !== null) {
          toast({
            title: `Set up ${status.service} to use Transforms`,
            description: status.ready,
            tone: "error",
          });
          return;
        }
        const go = () =>
          void startAiRef.current({ transformId: t.id, name: t.name });
        if (status.consented) go();
        else setConsent({ ...status, go });
      }),
    [toast],
  );

  const applyAi = (mode: "replace" | "below") => {
    if (!ai?.result) return;
    const tab = tabsRef.current.find((t) => t.key === ai.tabKey);
    if (!tab || activeRef.current !== ai.tabKey) {
      setAi({ ...ai, error: "Switch back to the note this edit is for." });
      return;
    }
    // The text may have changed while the AI worked: never replace anything else.
    if (tab.body.slice(ai.range[0], ai.range[1]) !== ai.original) {
      setAi({
        ...ai,
        error:
          "The text changed while the AI was working, so nothing was replaced.",
      });
      return;
    }
    // The dialog holds focus while it is open, and the edit is typed into the focused editor:
    // close it first and apply when it hands focus back (onCloseAutoFocus below).
    pendingApply.current = {
      mode,
      text: mode === "replace" ? ai.result : `\n\n${ai.result}`,
      range: mode === "replace" ? ai.range : [ai.range[1], ai.range[1]],
    };
    setAi(null);
  };

  const finishApply = (e: Event) => {
    const p = pendingApply.current;
    if (!p) return;
    pendingApply.current = null;
    e.preventDefault();
    if (typeInto(p.text, p.range))
      toast({
        title: p.mode === "replace" ? "Replaced" : "Added below",
        description: "⌘Z undoes it.",
      });
    else
      toast({
        title: "Couldn't change the note",
        description: "Your note is unchanged.",
        tone: "error",
      });
  };

  // ---- Keyboard -----------------------------------------------------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "n" && !e.shiftKey) {
        e.preventDefault();
        newNote();
      } else if (k === "f" && !e.shiftKey) {
        e.preventDefault();
        setSidebar(true);
        requestAnimationFrame(() => searchRef.current?.focus());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newNote]);

  const words = useMemo(
    () => (current ? countNoteWords(current.body) : 0),
    [current],
  );
  const label = current ? saveStateLabel(current.state) : "";
  const tabTitle = (t: Tab) => noteTitle({ title: t.title, body: t.body });

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-canvas text-fg">
      <header className="drag flex h-11 shrink-0 items-center gap-1 pl-3 pr-2">
        <MurmurMark className="mr-3 size-5 shrink-0" />
        <ul aria-label="Open notes" className="flex min-w-0 items-center gap-1">
          {tabs.map((t) => (
            <li
              key={t.key}
              className={cn(
                "no-drag group flex h-7 min-w-0 max-w-44 items-center rounded-md pl-2.5 pr-1",
                t.key === active
                  ? "bg-surface-active"
                  : "hover:bg-surface-hover",
              )}
            >
              <button
                type="button"
                data-note-tab
                aria-current={t.key === active || undefined}
                onClick={() => {
                  rememberSelection();
                  setActive(t.key);
                }}
                onDoubleClick={() => t.noteId && setRenaming(true)}
                className="min-w-0 truncate text-ui font-medium"
              >
                {tabTitle(t)}
              </button>
              <button
                type="button"
                aria-label={`Close ${tabTitle(t)}`}
                onClick={() => void closeTab(t.key)}
                className="ml-1 flex size-5 shrink-0 items-center justify-center rounded-sm text-fg-secondary hover:bg-surface-hover hover:text-fg"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
        <Tooltip content="New note (⌘N)">
          <button
            type="button"
            aria-label="New note"
            onClick={newNote}
            className="no-drag ml-1 flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-surface-hover"
          >
            <Plus className="size-4" aria-hidden />
          </button>
        </Tooltip>
        <div className="flex-1" />
        <Tooltip content={expanded ? "Restore size" : "Expand"}>
          <button
            type="button"
            aria-label={expanded ? "Restore size" : "Expand"}
            onClick={async () => setExpanded(await api.toggleExpand())}
            className="no-drag flex size-7 items-center justify-center rounded-md hover:bg-surface-hover"
          >
            {expanded ? (
              <Minimize2 className="size-4" aria-hidden />
            ) : (
              <Maximize2 className="size-4" aria-hidden />
            )}
          </button>
        </Tooltip>
        <Tooltip content="Close (your notes are saved)">
          <button
            type="button"
            aria-label="Close Scratchpad"
            onClick={async () => {
              await flushAll();
              void api.hide();
            }}
            className="no-drag flex size-7 items-center justify-center rounded-md hover:bg-surface-hover"
          >
            <X className="size-4" aria-hidden />
          </button>
        </Tooltip>
      </header>

      <div className="flex min-h-0 flex-1 pb-2 pr-2">
        <nav
          aria-label="Scratchpad tools"
          className="flex w-12 shrink-0 flex-col items-center gap-1 pt-1"
        >
          <RailButton
            label={sidebar ? "Hide notes" : "Show notes"}
            pressed={sidebar}
            onClick={() => setSidebar((s) => !s)}
            icon={<PanelLeft />}
          />
          <RailButton
            label="New note (⌘N)"
            onClick={newNote}
            icon={<SquarePen />}
          />
          <RailButton
            label="Search notes (⌘F)"
            onClick={() => {
              setSidebar(true);
              requestAnimationFrame(() => searchRef.current?.focus());
            }}
            icon={<Search />}
          />
          <div className="flex-1" />
          <AiMenu
            disabled={!current?.body.trim() || Boolean(ai)}
            onPick={(pick, status) => {
              const go = () =>
                pick === "custom" ? setCustomAi(true) : void startAi(pick);
              // The first AI edit for a service asks before any text is sent to it.
              if (status.consented) go();
              else setConsent({ ...status, go });
            }}
            hasSelection={() => {
              const el = editor.current;
              return Boolean(el && el.selectionStart !== el.selectionEnd);
            }}
          />
          <StyleMenu
            prefs={prefs}
            onChange={async (patch) => {
              try {
                setPrefs(await api.updatePrefs(patch));
              } catch (e) {
                toast({
                  title: "Couldn't change the text style",
                  description: ipcErrorMessage(e),
                  tone: "error",
                });
              }
            }}
          />
        </nav>

        {sidebar && (
          <NotesPanel
            searchRef={searchRef}
            activeNoteId={current?.noteId ?? null}
            onOpen={(id) => void openNote(id)}
            onEscape={() => editor.current?.focus()}
          />
        )}

        <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-sheet">
          {current && (
            <textarea
              ref={editor}
              id="note-editor"
              aria-label={`Note: ${tabTitle(current)}`}
              value={current.body}
              onChange={(e) => onChange(e.target.value)}
              onSelect={rememberSelection}
              onBlur={rememberSelection}
              onKeyDown={(e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.currentTarget.blur();
                }
              }}
              spellCheck
              autoFocus
              placeholder="Start typing, or hold your shortcut and speak…"
              className={cn(
                "min-h-0 w-full flex-1 resize-none bg-transparent px-6 pb-16 pt-5 text-fg caret-accent outline-none placeholder:text-fg-tertiary",
                FONT[prefs?.font ?? "sans"],
                SIZE[prefs?.size ?? "medium"],
              )}
            />
          )}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-2 px-4 pb-3">
            <p
              className={cn(
                "pointer-events-auto min-w-0 flex-1 truncate text-caption",
                current?.state === "error" || current?.state === "conflict"
                  ? "text-danger"
                  : "text-fg-secondary",
              )}
              role={
                current?.state === "error" || current?.state === "conflict"
                  ? "alert"
                  : undefined
              }
            >
              {current?.state === "error"
                ? saveErrorText(current.error)
                : label}
              {current?.state === "conflict" && (
                <ConflictActions
                  saver={savers.current.get(current.key)}
                  onUseSaved={(body) => patchTab(current.key, { body })}
                />
              )}
              {words > 0 &&
                current?.state !== "error" &&
                current?.state !== "conflict" && (
                  <span>
                    {label ? " · " : ""}
                    {words.toLocaleString()} {words === 1 ? "word" : "words"}
                  </span>
                )}
            </p>
            <Menu>
              <Tooltip content="More">
                <MenuTrigger asChild>
                  <button
                    type="button"
                    aria-label="More note actions"
                    className="pointer-events-auto flex size-9 items-center justify-center rounded-full bg-surface text-fg hover:bg-surface-hover"
                  >
                    <MoreHorizontal className="size-4" aria-hidden />
                  </button>
                </MenuTrigger>
              </Tooltip>
              <MenuContent>
                <MenuItem
                  icon={<Pencil />}
                  disabled={!current?.noteId}
                  onSelect={() => setRenaming(true)}
                >
                  Rename…
                </MenuItem>
                <MenuItem
                  icon={<Download />}
                  disabled={!current?.noteId}
                  onSelect={() => void exportNote()}
                >
                  Export…
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  icon={<Trash2 />}
                  destructive
                  disabled={!current?.noteId}
                  onSelect={() => setDeleting(true)}
                >
                  Delete…
                </MenuItem>
              </MenuContent>
            </Menu>
            <Button
              variant="primary"
              className="pointer-events-auto rounded-full"
              icon={<Copy />}
              disabled={!current?.body}
              onClick={() => void copy()}
            >
              Copy
            </Button>
          </div>
        </main>
      </div>

      <RenameDialog
        open={renaming && Boolean(current?.noteId)}
        onOpenChange={setRenaming}
        initial={current?.title ?? ""}
        placeholder={
          current ? noteTitle({ title: null, body: current.body }) : ""
        }
        onSave={async (title) => {
          const id = current?.noteId;
          if (!id || !current) return;
          const note = await api.rename(id, title);
          savers.current.get(current.key)?.adopt(note);
          patchTab(current.key, { title: note.title });
        }}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete “${current ? tabTitle(current) : ""}”?`}
        description="The note is deleted from this Mac. This can't be undone."
        confirmLabel="Delete note"
        destructive
        onConfirm={async () => {
          const id = current?.noteId;
          if (!id || !current) return;
          savers.current.get(current.key)?.dispose();
          if (!(await api.remove(id)))
            throw new Error("This note was already deleted.");
          closeTabNow(current.key);
          toast({ title: "Note deleted", tone: "success" });
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          editor.current?.focus();
        }}
      />
      <ConfirmDialog
        open={closing !== null}
        onOpenChange={(o) => !o && setClosing(null)}
        title="This note isn't saved"
        description="Murmur couldn't save the latest changes. Close it anyway and lose them?"
        confirmLabel="Close and lose changes"
        destructive
        onConfirm={() => {
          if (closing) closeTabNow(closing);
          setClosing(null);
        }}
      />
      <ConfirmDialog
        open={consent !== null}
        onOpenChange={(o) => !o && setConsent(null)}
        title={`Send text to ${consent?.service ?? ""}?`}
        description={`AI edits send the selected text, or the whole note when nothing is selected, to ${consent?.service ?? ""}, the AI service set up in Settings → AI cleanup. They are sent only when you pick an edit, and you see the result before anything changes.`}
        confirmLabel={`Allow ${consent?.service ?? ""}`}
        onConfirm={async () => {
          if (!consent) return;
          const { go, provider } = consent;
          try {
            setPrefs(await api.allowAi(provider));
          } catch (e) {
            setConsent(null);
            toast({
              title: "Couldn't save your choice",
              description: ipcErrorMessage(e),
              tone: "error",
            });
            return;
          }
          setConsent(null);
          go();
        }}
      />
      <CustomAiDialog
        open={customAi}
        onOpenChange={setCustomAi}
        onSubmit={(instruction) => {
          setCustomAi(false);
          void startAi({ instruction });
        }}
      />
      <AiResultDialog
        run={ai}
        onCancel={() => {
          if (ai && !ai.result && !ai.error) void api.cancelAi(ai.requestId);
          setAi(null);
        }}
        onApply={applyAi}
        onRetry={() => {
          const pick = ai?.pick;
          setAi(null);
          if (pick) void startAi(pick);
        }}
        onCloseAutoFocus={finishApply}
      />
    </div>
  );
}

function RailButton({
  label,
  icon,
  onClick,
  pressed,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  pressed?: boolean;
}) {
  return (
    <Tooltip content={label} side="right">
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        onClick={onClick}
        className={cn(
          "flex size-9 items-center justify-center rounded-md text-fg hover:bg-surface-hover [&_svg]:size-[19px]",
          pressed && "bg-surface-active",
        )}
      >
        {icon}
      </button>
    </Tooltip>
  );
}

function ConflictActions({
  saver,
  onUseSaved,
}: {
  saver: Autosaver | undefined;
  onUseSaved: (body: string) => void;
}) {
  if (!saver) return null;
  return (
    <span className="ml-2 inline-flex gap-2">
      <button
        type="button"
        className="underline"
        onClick={() => void saver.keepMine()}
      >
        Keep this version
      </button>
      <button
        type="button"
        className="underline"
        onClick={() => onUseSaved(saver.useSaved())}
      >
        Show the saved one
      </button>
    </span>
  );
}

function NotesPanel({
  searchRef,
  activeNoteId,
  onOpen,
  onEscape,
}: {
  searchRef: React.RefObject<HTMLInputElement | null>;
  activeNoteId: string | null;
  onOpen: (id: string) => void;
  onEscape: () => void;
}) {
  const [search, setSearch] = useState("");
  const [notes, setNotes] = useState<NoteSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setNotes(await api.list(search));
      setError(null);
    } catch (e) {
      setError(ipcErrorMessage(e));
    }
  }, [search]);
  useEffect(() => {
    void load();
    return api.onNotesChanged(() => void load());
  }, [load]);
  const now = new Date();
  return (
    <aside
      aria-label="Notes"
      className="mr-2 flex w-52 shrink-0 flex-col gap-2 pt-1"
    >
      <Input
        ref={searchRef}
        type="search"
        aria-label="Search notes"
        placeholder="Search notes"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            if (search) setSearch("");
            else onEscape();
          }
        }}
        className="h-8"
      />
      {error ? (
        <p role="alert" className="px-1 text-caption text-danger">
          Couldn't load notes: {error}
        </p>
      ) : notes && notes.length === 0 ? (
        <p className="px-1 text-caption text-fg-secondary">
          {search ? "No notes match." : "No notes yet."}
        </p>
      ) : (
        <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
          {notes?.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                aria-current={n.id === activeNoteId || undefined}
                onClick={() => onOpen(n.id)}
                className={cn(
                  "w-full rounded-md px-2 py-1.5 text-left hover:bg-surface-hover",
                  n.id === activeNoteId && "bg-surface-active",
                )}
              >
                <span className="block truncate text-ui text-fg">
                  {n.title}
                </span>
                <span className="block truncate text-caption text-fg-secondary">
                  {noteWhen(n.updatedAt, now)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

function AiMenu({
  disabled,
  onPick,
  hasSelection,
}: {
  disabled: boolean;
  onPick: (pick: AiPick | "custom", status: AiStatus) => void;
  hasSelection: () => boolean;
}) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [transforms, setTransforms] = useState<
    { id: string; name: string; description: string }[]
  >([]);
  const [selection, setSelection] = useState(false);
  return (
    <Menu
      onOpenChange={(open) => {
        if (!open) return;
        setSelection(hasSelection());
        void api.aiStatus().then(setStatus, () => setStatus(null));
        void api.transforms().then(setTransforms, () => setTransforms([]));
      }}
    >
      <Tooltip content="AI edits" side="right">
        <MenuTrigger asChild>
          <button
            type="button"
            aria-label="AI edits"
            disabled={disabled}
            className="flex size-9 items-center justify-center rounded-md text-fg hover:bg-surface-hover disabled:opacity-40 [&_svg]:size-[19px]"
          >
            <Sparkles aria-hidden />
          </button>
        </MenuTrigger>
      </Tooltip>
      <MenuContent align="start" className="w-72">
        {status && status.ready !== null ? (
          <>
            <MenuLabel>AI edits use your AI cleanup service</MenuLabel>
            <p className="px-2.5 pb-2 text-caption text-fg-secondary">
              {status.service} isn't set up: {status.ready}
            </p>
            <MenuItem onSelect={() => void api.openAiSettings()}>
              Set up AI service…
            </MenuItem>
          </>
        ) : (
          <>
            <MenuLabel>
              {status
                ? `Sends ${selection ? "the selected text" : "this note"} to ${status.service}`
                : "Checking the AI service…"}
            </MenuLabel>
            {transforms.map((t) => (
              <MenuItem
                key={t.id}
                disabled={!status}
                onSelect={() =>
                  status && onPick({ transformId: t.id, name: t.name }, status)
                }
              >
                {t.name}
              </MenuItem>
            ))}
            <MenuItem
              disabled={!status}
              onSelect={() => status && onPick("custom", status)}
            >
              Ask for a change…
            </MenuItem>
            <p className="px-2.5 pb-1 pt-1.5 text-caption text-fg-secondary">
              You see the result before anything changes.
            </p>
          </>
        )}
      </MenuContent>
    </Menu>
  );
}

function StyleMenu({
  prefs,
  onChange,
}: {
  prefs: NotePrefs | null;
  onChange: (patch: Partial<NotePrefs>) => void;
}) {
  return (
    <Menu>
      <Tooltip content="Text style" side="right">
        <MenuTrigger asChild>
          <button
            type="button"
            aria-label="Text style"
            className="flex size-9 items-center justify-center rounded-md text-fg hover:bg-surface-hover [&_svg]:size-[21px]"
          >
            <CaseSensitive aria-hidden />
          </button>
        </MenuTrigger>
      </Tooltip>
      <MenuContent align="start">
        <MenuLabel>Font</MenuLabel>
        <MenuRadioGroup
          value={prefs?.font ?? "sans"}
          onValueChange={(v) => onChange({ font: v as NotePrefs["font"] })}
        >
          <MenuRadioItem value="sans">Sans serif</MenuRadioItem>
          <MenuRadioItem value="serif">Serif</MenuRadioItem>
          <MenuRadioItem value="mono">Monospaced</MenuRadioItem>
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuLabel>Size</MenuLabel>
        <MenuRadioGroup
          value={prefs?.size ?? "medium"}
          onValueChange={(v) => onChange({ size: v as NotePrefs["size"] })}
        >
          <MenuRadioItem value="small">Small</MenuRadioItem>
          <MenuRadioItem value="medium">Medium</MenuRadioItem>
          <MenuRadioItem value="large">Large</MenuRadioItem>
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

function RenameDialog({
  open,
  onOpenChange,
  initial,
  placeholder,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: string;
  placeholder: string;
  onSave: (title: string) => Promise<void>;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setValue(initial);
      setError(null);
    }
  }, [open, initial]);
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent size="sm">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await onSave(value);
              onOpenChange(false);
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
            placeholder={placeholder}
            onChange={(e) => setValue(e.target.value)}
          />
          <DialogError message={error} />
          <DialogFooter>
            <Button
              type="button"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
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

function CustomAiDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (instruction: string) => void;
}) {
  const [value, setValue] = useState("");
  useEffect(() => {
    if (open) setValue("");
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) onSubmit(value.trim());
          }}
        >
          <DialogHeader
            title="Ask for a change"
            description="Describe the edit, for example “make it friendlier” or “turn it into a list”."
          />
          <Textarea
            aria-label="The change you want"
            autoFocus
            rows={3}
            maxLength={500}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.metaKey && value.trim()) {
                e.preventDefault();
                onSubmit(value.trim());
              }
            }}
          />
          <DialogFooter>
            <Button type="button" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!value.trim()}>
              Continue
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type AiStatus = Awaited<ReturnType<typeof api.aiStatus>>;

/** A saved Transform, or a one-off instruction ("Ask for a change…"). */
type AiPick = { transformId: string; name: string } | { instruction: string };

interface AiRun {
  requestId: string;
  tabKey: string;
  pick: AiPick;
  label: string;
  range: [number, number];
  original: string;
  scope: "selection" | "note";
  result: string | null;
  error: string | null;
}

function AiResultDialog({
  run,
  onCancel,
  onApply,
  onRetry,
  onCloseAutoFocus,
}: {
  run: AiRun | null;
  onCancel: () => void;
  onApply: (mode: "replace" | "below") => void;
  onRetry: () => void;
  onCloseAutoFocus: (e: Event) => void;
}) {
  const label = run?.label ?? "";
  const working = Boolean(run && !run.result && !run.error);
  return (
    <Dialog open={Boolean(run)} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent
        size="lg"
        aria-describedby={undefined}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogHeader
          title={label}
          description={
            run?.scope === "selection"
              ? "Your selection, edited."
              : "Your note, edited."
          }
        />
        <div className="grid min-h-0 grid-cols-2 gap-3 max-[560px]:grid-cols-1">
          <section aria-label="Before" className="min-h-0">
            <h3 className="mb-1 text-caption font-medium text-fg-secondary">
              Before
            </h3>
            <div className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md bg-surface p-3 text-ui text-fg">
              {run?.original}
            </div>
          </section>
          <section aria-label="After" aria-busy={working} className="min-h-0">
            <h3 className="mb-1 text-caption font-medium text-fg-secondary">
              After
            </h3>
            <div className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md bg-accent-faint p-3 text-ui text-fg">
              {run?.result ??
                (working ? <span role="status">Working…</span> : null)}
            </div>
          </section>
        </div>
        <DialogError message={run?.error ?? null} />
        <DialogFooter>
          <Button onClick={onCancel}>{working ? "Cancel" : "Discard"}</Button>
          {!working && <Button onClick={onRetry}>Retry</Button>}
          {run?.scope === "note" && (
            <Button disabled={!run.result} onClick={() => onApply("below")}>
              Add below
            </Button>
          )}
          <Button
            variant="primary"
            disabled={!run?.result}
            onClick={() => onApply("replace")}
          >
            Replace
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
