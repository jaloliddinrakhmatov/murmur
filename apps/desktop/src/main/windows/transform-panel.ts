// The Transform panel (Stage 9C): a floating, non-activating panel, like the Capsule. It never
// takes keyboard focus, so the app you selected text in stays in front with its selection, and
// Replace can check that selection before pasting once. Esc closes it while it is open.
import { BrowserWindow, ipcMain, nativeTheme, screen } from "electron";
import {
  PANEL_ACTIONS,
  type PanelAction,
  type PanelState,
} from "../../shared/transforms.ts";
import { canvasColor } from "./hub.ts";
import { IdleClose, PANEL_IDLE_MS } from "./idle-close.ts";

export interface TransformPanelOptions {
  preload: string;
  url: string | { file: string };
  onAction: (action: PanelAction) => void;
  /** Esc as a global key while the panel is open (it can't receive key events itself). */
  armEscape: (onEscape: () => void) => () => void;
}

const WIDTH = 460;
const HEIGHT = 380;

export class TransformPanel {
  private win: BrowserWindow | null = null;
  private state: PanelState = { kind: "hidden" };
  private disarm: (() => void) | null = null;
  private readonly options: TransformPanelOptions;
  private readonly idle = new IdleClose(PANEL_IDLE_MS, () => {
    this.options.onAction("close");
    // Whatever the session did with "close", the panel and its Esc key are released.
    this.hide();
  });

  constructor(options: TransformPanelOptions) {
    this.options = options;
    ipcMain.on("transform:action", (e, action: unknown) => {
      if (!this.win || e.sender !== this.win.webContents) return;
      if (!PANEL_ACTIONS.includes(action as PanelAction)) return;
      if (this.state.kind !== "hidden") this.idle.touch();
      options.onAction(action as PanelAction);
    });
    ipcMain.handle("transform:state", (e) => {
      if (!this.win || e.sender !== this.win.webContents)
        throw new Error("not allowed");
      return this.state;
    });
    nativeTheme.on("updated", () =>
      this.win?.setBackgroundColor(canvasColor()),
    );
  }

  get window(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null;
  }

  get current(): PanelState {
    return this.state;
  }

  show(state: PanelState): void {
    this.state = state;
    this.idle.touch();
    const win = this.window ?? this.create();
    const send = () => win.webContents.send("transform:state", state);
    if (win.webContents.isLoading())
      win.webContents.once("did-finish-load", send);
    else send();
    if (!win.isVisible()) {
      this.place(win);
      win.showInactive();
    }
    if (!this.disarm)
      this.disarm = this.options.armEscape(() =>
        this.options.onAction("close"),
      );
  }

  hide(): void {
    this.idle.clear();
    this.state = { kind: "hidden" };
    this.disarm?.();
    this.disarm = null;
    this.window?.webContents.send("transform:state", this.state);
    this.window?.hide();
  }

  /** Top centre of the display under the pointer, clear of the menu bar. */
  private place(win: BrowserWindow) {
    const area = screen.getDisplayNearestPoint(
      screen.getCursorScreenPoint(),
    ).workArea;
    win.setBounds({
      x: Math.round(area.x + (area.width - WIDTH) / 2),
      y: Math.round(area.y + 24),
      width: WIDTH,
      height: HEIGHT,
    });
  }

  private create(): BrowserWindow {
    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // Like the Capsule: a non-activating panel, so clicking it leaves the other app in front.
      focusable: false,
      type: "panel",
      alwaysOnTop: true,
      roundedCorners: true,
      backgroundColor: canvasColor(),
      webPreferences: {
        preload: this.options.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    win.setAlwaysOnTop(true, "floating");
    // Selected text shouldn't end up in screen recordings or screen sharing.
    win.setContentProtection(true);
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.on("closed", () => {
      this.idle.clear();
      this.win = null;
      this.disarm?.();
      this.disarm = null;
    });
    if (typeof this.options.url === "string")
      void win.loadURL(this.options.url);
    else void win.loadFile(this.options.url.file);
    this.win = win;
    return win;
  }

  destroy(): void {
    this.idle.clear();
    this.disarm?.();
    this.disarm = null;
    this.window?.destroy();
    this.win = null;
  }
}
