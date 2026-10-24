import type { SystemSettingsPane } from "../../shared/ipc.ts";
import {
  BrowserWindow,
  dialog,
  ipcMain,
  type WebContents,
  nativeTheme,
  screen,
  shell,
} from "electron";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { HubService } from "../hub/service.ts";
import { writePrivateFile } from "../system/private-file.ts";

export interface HubWindowOptions {
  preload: string;
  url: string | { file: string };
  service: HubService;
}

/** Thin IPC layer: every channel maps to one validated HubService method. */
export function registerHubIpc(service: HubService): void {
  // Only the Hub window may use these channels (the Capsule and audio pages have their own).
  const handle = (
    channel: string,
    fn: (e: Electron.IpcMainInvokeEvent, ...args: never[]) => unknown,
  ) =>
    ipcMain.handle(channel, (e, ...args) => {
      if (!fromHub(e)) throw new Error("not allowed");
      return fn(e, ...(args as never[]));
    });
  handle("hub:getSettings", () => service.getSettings());
  handle("hub:updateSettings", (_e, patch: unknown) =>
    service.updateSettings(patch),
  );
  handle("hub:getStatus", () => service.getStatus());
  handle("hub:checkShortcut", (_e, shortcut: unknown, action: unknown) =>
    service.checkShortcut(action ? { shortcut, action } : { shortcut }),
  );
  handle("hub:setActionShortcut", (_e, input: unknown) =>
    service.setActionShortcut(input),
  );
  handle("hub:retrySecureStorage", () => service.retrySecureStorage());
  handle("hub:insights", () => service.insights());
  handle("hub:copyText", (_e, text: unknown) => service.copyText({ text }));
  handle("hub:copyInsights", () => service.copyInsights());
  handle("hub:voiceProfile", () => service.voiceProfile());
  handle("hub:generateVoiceProfile", () => service.generateVoiceProfile());
  handle("hub:startNewRecordingKey", () =>
    service.startNewRecordingKey({ confirm: true }),
  );
  handle("hub:suspendShortcuts", (e, on: unknown) =>
    suspendFor(e.sender, on === true),
  );
  handle("hub:microphones", () => service.microphones());
  handle("hub:selectMicrophone", (_e, input: unknown) =>
    service.selectMicrophone(input),
  );
  handle("hub:startMicPreview", (e) => startPreviewFor(e.sender));
  handle("hub:stopMicPreview", (e, input: unknown) => {
    service.stopMicPreview(input);
    if (
      previews.get(e.sender)?.session ===
      (input as { session?: number })?.session
    )
      previews.delete(e.sender);
  });
  handle("hub:setSecret", (_e, provider: unknown, apiKey: unknown) =>
    service.setSecret({ provider, apiKey }),
  );
  handle("hub:hasSecret", (_e, provider: unknown) =>
    service.hasSecret(String(provider)),
  );
  handle("hub:requestMicrophone", () => service.requestMicrophone());
  handle("hub:requestAccessibility", () => service.requestAccessibility());
  handle("hub:openSystemSettings", (_e, pane: unknown) =>
    openSystemSettings(
      pane === "accessibility" ||
        pane === "sound" ||
        pane === "login-items" ||
        pane === "calendars"
        ? pane
        : "microphone",
    ),
  );
  handle("hub:about", () => service.about());
  // The setup's practice field and shortcut test end when their window reloads, crashes or closes.
  const setupWatched = new WeakSet<WebContents>();
  const releaseSetupWith = (wc: WebContents) => {
    if (setupWatched.has(wc)) return;
    setupWatched.add(wc);
    const release = () => service.releaseOnboarding();
    wc.on("destroyed", release);
    wc.on("did-start-loading", release);
    wc.on("render-process-gone", release);
  };
  handle("hub:setPracticeFocus", (e, input: unknown) => {
    service.setPracticeFocus(input);
    releaseSetupWith(e.sender);
  });
  handle("hub:watchShortcut", (e, input: unknown) => {
    const on = service.watchShortcut(input);
    if (on) releaseSetupWith(e.sender);
    return on;
  });
  handle("hub:systemAudioStatus", () => service.systemAudioStatus());
  handle("hub:requestSystemAudio", () => service.requestSystemAudio());
  handle("hub:loginItem", () => service.loginItem());
  handle("hub:setLoginItem", (_e, input: unknown) =>
    service.setLoginItem(input),
  );
  handle("hub:resetApp", (_e, input: unknown) => service.resetApp(input));
  handle("hub:revealDataFolder", () => service.revealDataFolder());
  handle("hub:listHistory", (_e, query: unknown) => service.listHistory(query));
  handle("hub:historyStats", () => service.historyStats());
  handle("hub:queryHistory", (_e, query: unknown) =>
    service.queryHistory(query),
  );
  handle("hub:getDictation", (_e, id: unknown) => service.getDictation({ id }));
  handle("hub:exportData", () =>
    saveJson("murmur-export.json", service.exportData()),
  );
  handle("hub:aiCleanupStatus", () => service.aiCleanupStatus());
  handle("hub:listDictionary", (_e, search: unknown) =>
    service.listDictionary(String(search ?? "")),
  );
  handle("hub:findDictionaryPhrase", (_e, phrase: unknown) =>
    service.findDictionaryPhrase(String(phrase ?? "")),
  );
  handle("hub:addDictionaryEntry", (_e, entry: unknown) =>
    service.addDictionaryEntry(entry),
  );
  handle("hub:updateDictionaryEntry", (_e, id: unknown, patch: unknown) =>
    service.updateDictionaryEntry({ id }, patch),
  );
  handle("hub:deleteDictionaryEntry", (_e, id: unknown) =>
    service.deleteDictionaryEntry({ id }),
  );
  handle("hub:importDictionary", async () => {
    const r = await dialog.showOpenDialog({
      title: "Import dictionary",
      filters: [{ name: "JSON", extensions: ["json"] }],
      properties: ["openFile"],
    });
    if (r.canceled || !r.filePaths[0])
      return { added: 0, skipped: 0, cancelled: true };
    // A dictionary export is small; refuse anything large before reading it.
    if ((await stat(r.filePaths[0])).size > 2 * 1024 * 1024)
      throw new Error("That file is too large to be a dictionary export.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(r.filePaths[0], "utf8"));
    } catch {
      throw new Error("That file isn't a dictionary export.");
    }
    const entries = Array.isArray(parsed)
      ? parsed
      : (parsed as { dictionary?: unknown }).dictionary;
    return service.importDictionary(entries);
  });
  handle("hub:exportDictionary", () =>
    saveJson("murmur-dictionary.json", service.exportDictionary()),
  );
  handle("hub:listSnippets", (_e, search: unknown) =>
    service.listSnippets(String(search ?? "")),
  );
  handle("hub:checkSnippet", (_e, candidate: unknown, excludeId: unknown) =>
    service.checkSnippet(
      candidate,
      typeof excludeId === "string" ? excludeId : null,
    ),
  );
  handle("hub:addSnippet", (_e, snippet: unknown) =>
    service.addSnippet(snippet),
  );
  handle("hub:updateSnippet", (_e, id: unknown, patch: unknown) =>
    service.updateSnippet({ id }, patch),
  );
  handle("hub:deleteSnippet", (_e, id: unknown) =>
    service.deleteSnippet({ id }),
  );
  handle("hub:previewSnippets", (_e, text: unknown, draft: unknown) =>
    service.previewSnippets(String(text ?? ""), draft ?? undefined),
  );
  handle("hub:retryDictation", (_e, id: unknown) =>
    service.retryDictation({ id }),
  );
  handle("hub:dictationAudio", (_e, id: unknown) =>
    service.dictationAudio({ id }),
  );
  handle("hub:dictationRecording", () => service.dictationRecording());
  handle("hub:copyDictation", (_e, id: unknown, which: unknown) =>
    service.copyDictation({ id }, which === "raw" ? "raw" : "final"),
  );
  handle("hub:deleteDictation", (_e, id: unknown) =>
    service.deleteDictation({ id }),
  );
  handle("hub:clearHistory", () => service.clearHistory());

  // Each window owns at most one level preview, released when it starts another, reloads,
  // crashes or closes, so a microphone can't stay open behind a window that forgot it.
  const previews = new Map<WebContents, { session: number }>();
  const release = (wc: WebContents) => {
    const p = previews.get(wc);
    previews.delete(wc);
    if (p) service.stopMicPreview(p);
  };
  const watched = new WeakSet<WebContents>();
  const watch = (wc: WebContents, cleanup: () => void) => {
    if (watched.has(wc)) return;
    watched.add(wc);
    wc.on("destroyed", cleanup);
    wc.on("did-start-loading", cleanup);
    wc.on("render-process-gone", cleanup);
  };
  const startPreviewFor = (wc: WebContents) => {
    release(wc);
    const p = service.startMicPreview((event) => {
      if (!wc.isDestroyed()) wc.send("hub:micPreview", event);
    });
    previews.set(wc, p);
    watch(wc, () => {
      release(wc);
      service.suspendShortcuts(false);
      clearTimeout(suspendTimers.get(wc));
    });
    return p;
  };

  // The shortcut recorder pauses Murmur's shortcuts; they come back when it stops, when its
  // window goes away, or after 30 s at the latest.
  const suspendTimers = new Map<WebContents, ReturnType<typeof setTimeout>>();
  const suspendFor = (wc: WebContents, on: boolean): boolean => {
    clearTimeout(suspendTimers.get(wc));
    suspendTimers.delete(wc);
    const ok = service.suspendShortcuts(on);
    if (on && ok) {
      suspendTimers.set(
        wc,
        setTimeout(() => service.suspendShortcuts(false), 30_000),
      );
      watch(wc, () => {
        release(wc);
        service.suspendShortcuts(false);
        clearTimeout(suspendTimers.get(wc));
      });
    }
    return ok;
  };
}

/** True when an IPC call comes from the Hub page (dev server or the packaged file). */
export function fromHub(e: Electron.IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url ?? e.sender.getURL();
  return /^(?:file:\/\/\/|https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/)(?:.*\/)?renderer\/hub\/index\.html(?:[?#]|$)/.test(
    url,
  );
}

/** Save-dialog + JSON write; returns whether the user saved. */
async function saveJson(
  defaultName: string,
  data: unknown,
): Promise<{ saved: boolean; path?: string }> {
  const r = await dialog.showSaveDialog({
    defaultPath: defaultName,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (r.canceled || !r.filePath) return { saved: false };
  await writePrivateFile(r.filePath, JSON.stringify(data, null, 2));
  return { saved: true, path: r.filePath };
}

const PANES: Record<SystemSettingsPane, string> = {
  microphone:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  accessibility:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  sound: "x-apple.systempreferences:com.apple.preference.sound?input",
  "login-items":
    "x-apple.systempreferences:com.apple.LoginItems-Settings.extension",
  calendars:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars",
};

export async function openSystemSettings(
  pane: SystemSettingsPane,
): Promise<void> {
  await shell.openExternal(PANES[pane]);
}

/** Window background = the design token --m-canvas, so resizing and launch never flash. */
export function canvasColor(): string {
  return nativeTheme.shouldUseDarkColors ? "#121014" : "#f5f4f1";
}

export class HubWindow {
  private win: BrowserWindow | null = null;
  private readonly options: HubWindowOptions;
  private readonly pendingFlushes = new Map<string, () => void>();

  constructor(options: HubWindowOptions) {
    this.options = options;
    ipcMain.on("hub:flushed", (e, requestId: unknown) => {
      if (!this.win || e.sender !== this.win.webContents) return;
      if (typeof requestId !== "string") return;
      this.pendingFlushes.get(requestId)?.();
      this.pendingFlushes.delete(requestId);
    });
    options.service.onHistoryChanged(() =>
      this.win?.webContents.send("hub:historyChanged"),
    );
    options.service.onStatusChanged(() =>
      this.win?.webContents.send("hub:statusChanged"),
    );
    options.service.onLibraryChanged(() =>
      this.win?.webContents.send("hub:libraryChanged"),
    );
    options.service.onMicrophonesChanged(() =>
      this.win?.webContents.send("hub:microphonesChanged"),
    );
    nativeTheme.on("updated", () =>
      this.win?.setBackgroundColor(canvasColor()),
    );
  }

  get window(): BrowserWindow | null {
    return this.win;
  }

  isVisible(): boolean {
    return Boolean(this.win && !this.win.isDestroyed() && this.win.isVisible());
  }

  /** `inactive` shows the window without activating Murmur (screen capture runs). */
  show(route?: string, options: { inactive?: boolean } = {}): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) {
      if (route) this.win.webContents.send("hub:navigate", route);
      if (options.inactive) this.win.showInactive();
      else {
        this.win.show();
        this.win.focus();
      }
      return this.win;
    }
    // The reference window (1350 × 850 pt), smaller when the display's work area is.
    const work = screen.getDisplayNearestPoint(
      screen.getCursorScreenPoint(),
    ).workAreaSize;
    this.win = new BrowserWindow({
      width: Math.max(720, Math.min(1350, work.width - 48)),
      height: Math.max(500, Math.min(850, work.height - 48)),
      minWidth: 720,
      minHeight: 500,
      title: "Murmur",
      // Hidden title bar with inset traffic lights. macOS places the 16 pt button frames 1 pt
      // up and left of this point; frames at (15, 18) centre the circles on the reference's
      // (22.75, 25.75) within 0.25 pt (checked by `npm run compare`).
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 19 },
      backgroundColor: canvasColor(),
      show: false,
      webPreferences: {
        preload: this.options.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    this.win.webContents.on("will-navigate", (e) => e.preventDefault());
    this.win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    this.win.once("ready-to-show", () =>
      options.inactive ? this.win?.showInactive() : this.win?.show(),
    );
    this.win.on("closed", () => (this.win = null));
    const hash = route ? `#${route}` : "";
    if (typeof this.options.url === "string")
      void this.win.loadURL(this.options.url + hash);
    else void this.win.loadFile(this.options.url.file, { hash: route });
    return this.win;
  }

  /** Asks the page to save notes still waiting to autosave; resolves when it has, or after `timeoutMs`. */
  flush(timeoutMs: number): Promise<void> {
    const win = this.win;
    if (!win || win.isDestroyed() || win.webContents.isLoading())
      return Promise.resolve();
    const requestId = randomUUID();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.pendingFlushes.delete(requestId);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.pendingFlushes.set(requestId, done);
      win.webContents.send("hub:flush", requestId);
    });
  }

  close(): void {
    this.win?.close();
  }
}
