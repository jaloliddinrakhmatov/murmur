// The Scratchpad note window (Stage 9B, reference 13): a small floating editor with tabs. It
// hides rather than closes, so open tabs survive; text is saved by the page as it is typed.
// IPC: `note:*` channels are for the note window and the Hub page only, and every input is
// validated by ScratchpadService.
import { randomUUID } from "node:crypto";
import { BrowserWindow, ipcMain, nativeTheme, screen } from "electron";
import { z } from "zod";
import { NoteIdSchema } from "../../shared/notes.ts";
import { NotePrefsPatchSchema } from "../../shared/note-prefs.ts";
import type { NoteTarget } from "../scratchpad/inserter.ts";
import type { ScratchpadService } from "../scratchpad/service.ts";
import { canvasColor } from "./hub.ts";

export interface NoteWindowOptions {
  preload: string;
  url: string | { file: string };
  log?: (event: string, data?: Record<string, unknown>) => void;
}

/** What the page should show when the window opens. */
export type NoteOpen = { id: string } | { new: true } | { resume: true };

const INSERT_TIMEOUT_MS = 2000;

export class NoteWindow implements NoteTarget {
  private win: BrowserWindow | null = null;
  private readonly options: NoteWindowOptions;
  private focusedSince: number | null = null;
  private restoreBounds: Electron.Rectangle | null = null;
  private readonly pendingInserts = new Map<string, (ok: boolean) => void>();
  private readonly pendingFlushes = new Map<string, () => void>();

  constructor(options: NoteWindowOptions) {
    this.options = options;
    ipcMain.on("note:inserted", (e, reply: unknown) => {
      if (!this.win || e.sender !== this.win.webContents) return;
      const { requestId, ok } = (reply ?? {}) as {
        requestId?: unknown;
        ok?: unknown;
      };
      if (typeof requestId !== "string") return;
      this.pendingInserts.get(requestId)?.(ok === true);
      this.pendingInserts.delete(requestId);
    });
    ipcMain.on("note:flushed", (e, requestId: unknown) => {
      if (!this.win || e.sender !== this.win.webContents) return;
      if (typeof requestId !== "string") return;
      this.pendingFlushes.get(requestId)?.();
      this.pendingFlushes.delete(requestId);
    });
    nativeTheme.on("updated", () =>
      this.win?.setBackgroundColor(canvasColor()),
    );
  }

  get window(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null;
  }

  isFrom(sender: Electron.WebContents): boolean {
    return Boolean(this.window && sender === this.window.webContents);
  }

  isVisible(): boolean {
    return Boolean(this.window?.isVisible());
  }

  /** Shows the window (creating it once) and tells the page which note to show. */
  show(
    open: NoteOpen = { resume: true },
    options: { inactive?: boolean } = {},
  ) {
    const win = this.window ?? this.create(open, options);
    if (win.webContents.isLoading())
      win.webContents.once("did-finish-load", () =>
        win.webContents.send("note:open", open),
      );
    else win.webContents.send("note:open", open);
    if (options.inactive) win.showInactive();
    else {
      win.show();
      win.focus();
    }
    return win;
  }

  /** The global shortcut: open (resuming), or hide when it's already in front. */
  toggle(): void {
    if (this.window?.isVisible() && this.window.isFocused()) this.hide();
    else this.show({ resume: true });
  }

  hide(): void {
    this.window?.hide();
  }

  /** Expand fills the screen's work area; pressed again, back to the previous size. */
  toggleExpand(): boolean {
    const win = this.window;
    if (!win) return false;
    if (this.restoreBounds) {
      win.setBounds(this.restoreBounds, true);
      this.restoreBounds = null;
      return false;
    }
    this.restoreBounds = win.getBounds();
    const area = screen.getDisplayMatching(win.getBounds()).workArea;
    win.setBounds(area, true);
    return true;
  }

  get expanded(): boolean {
    return this.restoreBounds !== null;
  }

  send(channel: string, payload?: unknown): void {
    this.window?.webContents.send(channel, payload);
  }

  /** Asks the page to save every open note; resolves when it has, or after `timeoutMs`. */
  flush(timeoutMs: number): Promise<void> {
    const win = this.window;
    if (!win || win.webContents.isLoading()) return Promise.resolve();
    const requestId = randomUUID();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingFlushes.delete(requestId);
        resolve();
      }, timeoutMs);
      this.pendingFlushes.set(requestId, () => {
        clearTimeout(timer);
        resolve();
      });
      win.webContents.send("note:flush", requestId);
    });
  }

  /** Closes the window and drops its tabs without saving (Reset deletes the notes). */
  destroy(): void {
    this.window?.destroy();
    this.win = null;
    this.focusedSince = null;
    this.restoreBounds = null;
  }

  acceptsDictation(takenAt: number): boolean {
    const win = this.window;
    return Boolean(
      win?.isVisible() &&
      win.isFocused() &&
      this.focusedSince !== null &&
      this.focusedSince <= takenAt,
    );
  }

  insert(text: string): Promise<boolean> {
    const win = this.window;
    if (!win) return Promise.resolve(false);
    const requestId = randomUUID();
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingInserts.delete(requestId);
        resolve(false);
      }, INSERT_TIMEOUT_MS);
      this.pendingInserts.set(requestId, (ok) => {
        clearTimeout(timer);
        resolve(ok);
      });
      // The page ignores it after the deadline, so a late reply can't insert a second copy.
      win.webContents.send("note:insert", {
        requestId,
        text,
        expiresAt: Date.now() + INSERT_TIMEOUT_MS,
      });
    });
  }

  private create(open: NoteOpen, options: { inactive?: boolean }) {
    const work = screen.getDisplayNearestPoint(
      screen.getCursorScreenPoint(),
    ).workArea;
    // Reference: about 500 × 420 pt, floating over other apps.
    const width = 500;
    const height = 420;
    const win = new BrowserWindow({
      width,
      height,
      x: Math.round(work.x + (work.width - width) / 2),
      y: Math.round(work.y + (work.height - height) / 3),
      minWidth: 360,
      minHeight: 260,
      title: "Scratchpad",
      frame: false,
      roundedCorners: true,
      alwaysOnTop: true,
      fullscreenable: false,
      backgroundColor: canvasColor(),
      show: false,
      webPreferences: {
        preload: this.options.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    win.setAlwaysOnTop(true, "floating");
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.on("focus", () => {
      this.focusedSince = Date.now();
    });
    win.on("blur", () => {
      this.focusedSince = null;
    });
    win.on("hide", () => {
      this.focusedSince = null;
    });
    // Closing (⌘W, or the system) hides it; the page keeps its tabs and has saved the text.
    win.on("close", (e) => {
      if (!quitting) {
        e.preventDefault();
        win.webContents.send("note:flush");
        win.hide();
      }
    });
    win.on("closed", () => {
      this.win = null;
      this.focusedSince = null;
      for (const resolve of this.pendingInserts.values()) resolve(false);
      this.pendingInserts.clear();
    });
    win.once("ready-to-show", () =>
      options.inactive ? win.showInactive() : win.show(),
    );
    const hash = `#${"id" in open ? `note/${open.id}` : "new" in open ? "new" : ""}`;
    if (typeof this.options.url === "string")
      void win.loadURL(this.options.url + hash);
    else void win.loadFile(this.options.url.file, { hash: hash.slice(1) });
    this.win = win;
    return win;
  }
}

let quitting = false;
/** Lets the window really close when Murmur quits. */
export function allowNoteWindowClose(): void {
  quitting = true;
}

/** True when an IPC call comes from the note window page (dev server or the packaged file). */
function fromNotePage(e: Electron.IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url ?? e.sender.getURL();
  return /^(?:file:\/\/\/|https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/)(?:.*\/)?renderer\/scratchpad\/index\.html(?:[?#]|$)/.test(
    url,
  );
}

function fromHubPage(e: Electron.IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url ?? e.sender.getURL();
  return /^(?:file:\/\/\/|https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/)(?:.*\/)?renderer\/hub\/index\.html(?:[?#]|$)/.test(
    url,
  );
}

export function registerScratchpadIpc(
  service: ScratchpadService,
  notes: NoteWindow,
  prefs: {
    get: () => unknown;
    update: (patch: unknown) => unknown;
    /** Agree to send note text to this AI service (the one set up in Settings → AI cleanup). */
    allowAi: (provider: string) => unknown;
  },
  openAiSettings: () => void,
): void {
  // Notes are shared by the note window and the Hub's Scratchpad page; nothing else may call.
  const handle = (
    channel: string,
    fn: (e: Electron.IpcMainInvokeEvent, input: unknown) => unknown,
    who: "both" | "note" = "both",
  ) =>
    ipcMain.handle(channel, (e, input: unknown) => {
      // The page's address and, for the note window, the window itself.
      const ok =
        (fromNotePage(e) && notes.isFrom(e.sender)) ||
        (who === "both" && fromHubPage(e));
      if (!ok) throw new Error("not allowed");
      return fn(e, input);
    });
  handle("note:list", (_e, input) => service.list(input));
  handle("note:get", (_e, input) => service.get(input));
  handle("note:open", (_e, input) => service.open(input), "note");
  handle("note:initial", () => service.initial(), "note");
  handle("note:create", (_e, input) => service.create(input), "note");
  handle("note:save", (_e, input) => service.save(input), "note");
  handle("note:rename", (_e, input) => service.rename(input));
  handle("note:delete", (_e, input) => service.delete(input));
  handle("note:copy", (_e, input) => service.copy(input), "note");
  handle("note:export", (_e, input) => service.export(input));
  handle("note:aiStatus", () => service.aiStatus(), "note");
  handle("note:transforms", () => service.transformsForMenu(), "note");
  handle("note:ai", (_e, input) => service.ai(input), "note");
  handle("note:cancelAi", (_e, input) => service.cancelAi(input), "note");
  handle("note:prefs", () => prefs.get(), "note");
  handle(
    "note:updatePrefs",
    (_e, input) => prefs.update(NotePrefsPatchSchema.parse(input)),
    "note",
  );
  // The note window's consent dialog: the only way this window can grant AI consent.
  handle(
    "note:allowAi",
    (_e, input) =>
      prefs.allowAi(
        z.object({ provider: z.string().max(40) }).parse(input).provider,
      ),
    "note",
  );
  handle("note:hide", () => notes.hide(), "note");
  handle("note:openAiSettings", () => openAiSettings(), "note");
  handle("note:toggleExpand", () => notes.toggleExpand(), "note");
  // From the Hub page: open a note (or a new one) in the note window.
  handle("note:show", (_e, input) => {
    const open = (input ?? {}) as { id?: unknown; new?: unknown };
    const id = NoteIdSchema.safeParse(open);
    if (id.success && /^[\w-]+$/.test(id.data.id))
      notes.show({ id: id.data.id });
    else if (open.new === true) notes.show({ new: true });
    else notes.show({ resume: true });
  });
}
