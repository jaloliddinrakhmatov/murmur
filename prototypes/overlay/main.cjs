// M0 Prototype B — floating Capsule overlay.
//   npm start            interactive: hold Ctrl+Opt+Space (Carbon, no permission) to drive the capsule
//   npm run selftest     automated checks, writes results/overlay-selftest.json and exits
const { app, BrowserWindow, ipcMain, screen } = require("electron");
const path = require("node:path");

const native = require("../../native/index.cjs");

const CAPSULE = { width: 240, height: 56, bottomMargin: 12 };
const SELFTEST = process.argv.includes("--selftest");

let capsule;
let seq = 0;
const paintWaiters = new Map();

function capsuleBoundsFor(display) {
  const wa = display.workArea;
  return {
    x: Math.round(wa.x + (wa.width - CAPSULE.width) / 2),
    y: Math.round(wa.y + wa.height - CAPSULE.height - CAPSULE.bottomMargin),
    width: CAPSULE.width,
    height: CAPSULE.height,
  };
}

function createCapsule() {
  const win = new BrowserWindow({
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
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.loadFile(path.join(__dirname, "capsule.html"));
  return win;
}

/** Sends a state and resolves with ms until the renderer reports it painted. */
function setCapsuleState(state) {
  const id = ++seq;
  const t0 = performance.now();
  return new Promise((resolve) => {
    paintWaiters.set(id, () => resolve(performance.now() - t0));
    capsule.webContents.send("capsule:state", { state, seq: id });
  });
}

ipcMain.on("capsule:painted", (_e, id) => {
  paintWaiters.get(id)?.();
  paintWaiters.delete(id);
});
ipcMain.on("capsule:interactive", (_e, on) =>
  capsule.setIgnoreMouseEvents(!on, { forward: true }),
);

function followCursorDisplay() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  capsule.setBounds(capsuleBoundsFor(display));
}

function createEditor() {
  const editor = new BrowserWindow({
    width: 640,
    height: 360,
    title: "Murmur test editor",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  editor.loadFile(path.join(__dirname, "editor.html"));
  return editor;
}

async function runInteractive() {
  createEditor();
  const hold = new native.HoldToTalk();
  const apply = async (outputs) => {
    for (const o of outputs) {
      if (o === "start") followCursorDisplay();
      const state =
        o === "start"
          ? "listening"
          : o === "handsFree"
            ? "handsFree"
            : o.startsWith("stop:")
              ? "processing"
              : o.startsWith("cancel:")
                ? "resting"
                : null;
      if (!state) continue;
      const paintMs = await setCapsuleState(state);
      console.log(
        `${o.padEnd(16)} → ${state.padEnd(10)} painted in ${paintMs.toFixed(1)}ms`,
      );
      if (state === "processing") {
        setTimeout(
          () =>
            setCapsuleState("inserted").then(() =>
              setTimeout(() => setCapsuleState("resting"), 700),
            ),
          400,
        );
      }
    }
  };
  const reg = native.registerHotkey(1, "ctrl+opt+space", {}, (e) => {
    const lagMs = native.nowMs() - e.tMs;
    console.log(`hotkey ${e.kind} (Carbon handler → JS ${lagMs.toFixed(2)}ms)`);
    apply(hold.handle(e.kind === "pressed" ? "down" : "up", e.tMs));
  });
  console.log("Carbon hotkey registration:", reg);
  setInterval(() => apply(hold.handle("tick", native.nowMs())), 50);
  ipcMain.on("capsule:clicked", () =>
    apply(
      hold.handle(hold.state === "idle" ? "down" : "cancel", native.nowMs()),
    ),
  );
}

app.whenReady().then(async () => {
  const tCreate = performance.now();
  capsule = createCapsule();
  await new Promise((r) => capsule.once("ready-to-show", r));
  const readyMs = performance.now() - tCreate;
  capsule.showInactive();
  await setCapsuleState("resting");

  if (SELFTEST) {
    const { runSelftest } = require("./selftest.cjs");
    await runSelftest({
      capsule,
      native,
      setCapsuleState,
      capsuleBoundsFor,
      createEditor,
      readyMs,
    });
    app.exit(0);
  } else {
    await runInteractive();
  }
});

app.on("window-all-closed", () => app.quit());
