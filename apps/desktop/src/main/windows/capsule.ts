// The Capsule: a non-activating floating status pill. Window configuration is the one validated in
// M0 (no focus steal in 60 cycles against TextEdit and an in-app editor).
import { BrowserWindow, ipcMain, screen } from "electron";
import { join } from "node:path";
import type { CapsulePort } from "../core/types.ts";
import type { CapsuleState } from "../../shared/ipc.ts";

/**
 * The window is transparent around the pill (room for its shadow and longer messages) and
 * ignores the mouse except over the pill, so it never blocks the app underneath.
 */
const SIZE = { width: 380, height: 60, bottomMargin: 8 };

export function capsuleBoundsFor(display: Electron.Display) {
  const wa = display.workArea;
  return {
    x: Math.round(wa.x + (wa.width - SIZE.width) / 2),
    y: Math.round(wa.y + wa.height - SIZE.height - SIZE.bottomMargin),
    width: SIZE.width,
    height: SIZE.height,
  };
}

export interface PaintTiming {
  /** Including the main process reading the report. */
  totalMs: number;
  ipcMs: number;
  workMs: number;
  /** Send → on screen: what a user sees. */
  visibleMs: number;
  ackMs: number;
  /** Received → on screen. */
  renderMs: number;
}

export interface CapsuleWindowOptions {
  preload: string;
  url: string | { file: string };
  onClick: () => void;
  onCancel: () => void;
  visibility: () => "always" | "whileActive";
}

export class CapsuleWindow implements CapsulePort {
  readonly win: BrowserWindow;
  private seq = 0;
  private state: CapsuleState = "resting";
  private notice: string | null = null;
  private meeting: { text: string; paused: boolean } | null = null;
  private readonly painted = new Map<
    number,
    (receivedAt: number, workDoneAt: number, paintedAt: number) => void
  >();
  private probeSeq = 0;
  private readonly options: CapsuleWindowOptions;

  constructor(options: CapsuleWindowOptions) {
    this.options = options;
    this.win = new BrowserWindow({
      ...capsuleBoundsFor(screen.getPrimaryDisplay()),
      show: false,
      transparent: true,
      backgroundColor: "#00000000",
      frame: false,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      type: "panel",
      webPreferences: {
        preload: options.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        // Feedback sounds play without a click in this window (it never takes focus).
        autoplayPolicy: "no-user-gesture-required",
      },
    });
    this.win.setAlwaysOnTop(true, "screen-saver");
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.win.setIgnoreMouseEvents(true, { forward: true });
    this.win.webContents.on("will-navigate", (e) => e.preventDefault());
    this.win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    ipcMain.on(
      "capsule:painted",
      (
        e,
        seq: number,
        receivedAt: number,
        workDoneAt: number,
        paintedAt: number,
      ) => {
        if (e.sender === this.win.webContents) {
          this.painted.get(seq)?.(
            Number(receivedAt),
            Number(workDoneAt),
            Number(paintedAt),
          );
          this.painted.delete(seq);
        }
      },
    );
    ipcMain.on("capsule:interactive", (e, on: boolean) => {
      if (e.sender === this.win.webContents)
        this.win.setIgnoreMouseEvents(!on, { forward: true });
    });
    ipcMain.on("capsule:clicked", (e) => {
      if (e.sender === this.win.webContents) options.onClick();
    });
    ipcMain.on("capsule:cancel", (e) => {
      if (e.sender === this.win.webContents) options.onCancel();
    });
    // Displays added, removed, rearranged or rescaled: stay inside the current display's work
    // area (which excludes the menu bar and Dock).
    const reposition = () => {
      if (this.win.isDestroyed()) return;
      const b = this.win.getBounds();
      const target = capsuleBoundsFor(
        screen.getDisplayNearestPoint({
          x: b.x + Math.round(b.width / 2),
          y: b.y + Math.round(b.height / 2),
        }),
      );
      if (target.x !== b.x || target.y !== b.y) this.win.setBounds(target);
    };
    screen.on("display-metrics-changed", reposition);
    screen.on("display-removed", reposition);
    screen.on("display-added", reposition);
    this.win.on("closed", () => {
      screen.off("display-metrics-changed", reposition);
      screen.off("display-removed", reposition);
      screen.off("display-added", reposition);
    });
    this.win.webContents.on("did-finish-load", () => {
      this.send("capsule:notice", this.notice);
      this.send("capsule:meeting", this.meeting);
    });
    if (typeof options.url === "string") void this.win.loadURL(options.url);
    else void this.win.loadFile(options.url.file);
  }

  /** Sends to the Capsule page; a no-op once the window is gone (app shutting down). */
  private send(channel: string, ...args: unknown[]): void {
    if (!this.win.isDestroyed()) this.win.webContents.send(channel, ...args);
  }

  async ready(): Promise<void> {
    if (this.win.webContents.isLoading())
      await new Promise<void>((r) =>
        this.win.webContents.once("did-finish-load", () => r()),
      );
    this.applyVisibility();
  }

  /** Moves the capsule to the display under the cursor (M0: follows the cursor's display). */
  followCursor(): void {
    const target = capsuleBoundsFor(
      screen.getDisplayNearestPoint(screen.getCursorScreenPoint()),
    );
    const current = this.win.getBounds();
    if (target.x !== current.x || target.y !== current.y)
      this.win.setBounds(target);
  }

  show(state: CapsuleState, message?: string): void {
    this.state = state;
    if (state === "listening") this.followCursor();
    this.applyVisibility();
    this.send("capsule:state", {
      state,
      message,
      seq: ++this.seq,
    });
  }

  /** A standing problem shown at rest, e.g. "Shortcut unavailable"; null clears it. */
  setNotice(text: string | null): void {
    if (text === this.notice) return;
    this.notice = text;
    this.send("capsule:notice", text);
  }

  /** Stage 9D-2: a meeting recording, shown at rest whatever the visibility setting; null hides it. */
  setMeeting(meeting: { text: string; paused: boolean } | null): void {
    if (
      meeting?.text === this.meeting?.text &&
      meeting?.paused === this.meeting?.paused
    )
      return;
    this.meeting = meeting;
    this.applyVisibility();
    this.send("capsule:meeting", meeting);
  }

  /** Plays one of Murmur's feedback sounds (the caller checks the setting). */
  playSound(kind: "stop" | "done" | "error"): void {
    this.send("capsule:sound", kind);
  }

  level(rms: number): void {
    this.send("capsule:level", rms);
  }

  /** Resolves when the renderer has painted the current state (used by the smoke test). */
  /** Resolves with the time until the state was on screen (send → pixels). */
  async showAndAwaitPaint(
    state: CapsuleState,
    message?: string,
  ): Promise<number> {
    return (await this.timedShow(() => this.show(state, message))).visibleMs;
  }

  /**
   * Runs `trigger` (which must make the capsule show a new state) and resolves with when the
   * next state reached the screen, split into parts. Timestamps are wall-clock ms in both
   * processes:
   *  - ipcMs: main → renderer delivery
   *  - workMs: applying the state in the renderer, with layout forced
   *  - visibleMs: main send → on screen (two animation frames after the work)
   *  - ackMs: on screen → main process reads the report (not seen by the user)
   */
  timedShow(trigger: () => void): Promise<PaintTiming> {
    return this.timed(this.seq + 1, trigger);
  }

  /** The same measurement for a message that changes nothing: the frame-scheduling baseline. */
  probe(): Promise<PaintTiming> {
    const seq = -++this.probeSeq;
    return this.timed(seq, () => this.send("capsule:probe", seq));
  }

  private timed(seq: number, trigger: () => void): Promise<PaintTiming> {
    const sentAt = performance.timeOrigin + performance.now();
    return new Promise((resolve) => {
      this.painted.set(seq, (receivedAt, workDoneAt, paintedAt) => {
        const now = performance.timeOrigin + performance.now();
        resolve({
          totalMs: now - sentAt,
          ipcMs: receivedAt - sentAt,
          workMs: workDoneAt - receivedAt,
          visibleMs: paintedAt - sentAt,
          ackMs: now - paintedAt,
          renderMs: paintedAt - receivedAt,
        });
      });
      trigger();
    });
  }

  applyVisibility(): void {
    const visible =
      this.options.visibility() === "always" ||
      this.state !== "resting" ||
      this.meeting !== null;
    if (visible) {
      if (!this.win.isVisible()) this.win.showInactive();
    } else if (this.win.isVisible()) this.win.hide();
  }
}
