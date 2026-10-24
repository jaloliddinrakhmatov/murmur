// Automated overlay checks. Every focus check has a negative control (a focusable window that
// SHOULD steal focus) so a passing result means the detector works, not that it is blind.
const { BrowserWindow, ipcMain, screen } = require("electron");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const q = (p) =>
    +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2);
  return { n: s.length, p50: q(0.5), p95: q(0.95), max: q(1) };
}

/** Frontmost app per LaunchServices (`lsappinfo`), which needs no permission. */
function frontBundleId() {
  const asn = execFileSync("lsappinfo", ["front"]).toString().trim();
  const info = execFileSync("lsappinfo", [
    "info",
    "-only",
    "bundleid",
    asn,
  ]).toString();
  return info.match(/(?:"CFBundleIdentifier"|bundleID)="([^"]+)"/)?.[1] ?? null;
}

function queryEditor(editor) {
  return new Promise((resolve) => {
    ipcMain.once("editor:report", (_e, report) => resolve(report));
    editor.webContents.send("editor:query");
  });
}

async function waitFor(fn, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
}

async function runSelftest({
  capsule,
  native,
  setCapsuleState,
  capsuleBoundsFor,
  createEditor,
  readyMs,
}) {
  const results = [];
  const record = (name, status, details) => {
    results.push({ name, status, details });
    console.log(`${status.padEnd(10)} ${name}`);
  };
  const states = [
    "listening",
    "processing",
    "inserted",
    "handsFree",
    "error",
    "resting",
  ];

  // 1. Window configuration
  const config = {
    isAlwaysOnTop: capsule.isAlwaysOnTop(),
    isFocusable: capsule.isFocusable(),
    backgroundColor: capsule.getBackgroundColor(),
    visibleOnAllWorkspaces: capsule.isVisibleOnAllWorkspaces(),
    readyToShowMs: +readyMs.toFixed(1),
  };
  record(
    "window-config",
    config.isAlwaysOnTop && !config.isFocusable && config.visibleOnAllWorkspaces
      ? "PASS"
      : "FAIL",
    config,
  );

  // 2. Transparency: pixels outside the pill must be fully transparent.
  await setCapsuleState("listening");
  await sleep(200);
  const image = await capsule.webContents.capturePage();
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap(); // BGRA
  const alphaAt = (x, y) => bitmap[(y * width + x) * 4 + 3];
  const transparency = {
    size: { width, height },
    cornerAlpha: alphaAt(1, 1),
    centerAlpha: alphaAt(Math.floor(width / 2), Math.floor(height / 2)),
  };
  record(
    "transparent-background",
    transparency.cornerAlpha === 0 && transparency.centerAlpha > 200
      ? "PASS"
      : "FAIL",
    transparency,
  );

  // 3. State change → painted latency
  const paint = [];
  for (let i = 0; i < 60; i++)
    paint.push(await setCapsuleState(states[i % states.length]));
  const paintStats = stats(paint);
  record(
    "state-paint-latency<=50ms-p95",
    paintStats.p95 <= 50 ? "PASS" : "FAIL",
    { ms: paintStats },
  );

  // 4. Positioning on every display
  const displays = screen.getAllDisplays();
  const placements = displays.map((d) => {
    const target = capsuleBoundsFor(d);
    capsule.setBounds(target);
    const actual = capsule.getBounds();
    const wa = d.workArea;
    const inside =
      actual.x >= wa.x &&
      actual.y >= wa.y &&
      actual.x + actual.width <= wa.x + wa.width &&
      actual.y + actual.height <= wa.y + wa.height;
    return {
      displayId: d.id,
      scaleFactor: d.scaleFactor,
      bounds: d.bounds,
      workArea: wa,
      capsule: actual,
      matchesTarget: JSON.stringify(actual) === JSON.stringify(target),
      insideWorkArea: inside,
      resolvedDisplay: screen.getDisplayMatching(actual).id === d.id,
    };
  });
  const cursor = screen.getCursorScreenPoint();
  record(
    `positioning-on-${displays.length}-display(s)`,
    placements.every(
      (p) => p.matchesTarget && p.insideWorkArea && p.resolvedDisplay,
    )
      ? "PASS"
      : "FAIL",
    {
      placements,
      cursor,
      cursorDisplayId: screen.getDisplayNearestPoint(cursor).id,
    },
  );
  capsule.setBounds(capsuleBoundsFor(screen.getPrimaryDisplay()));

  // 5. Focus retention with a text editor in this app
  const editor = createEditor();
  await new Promise((r) => editor.webContents.once("did-finish-load", r));
  editor.show();
  editor.focus();
  await waitFor(() => editor.isFocused(), 3000);
  editor.webContents.insertText("hello ");
  const baseline = await queryEditor(editor);
  const failures = [];
  for (let i = 0; i < 30; i++) {
    if (i % 5 === 0) capsule.hide();
    capsule.showInactive();
    capsule.moveTop();
    await setCapsuleState(states[i % states.length]);
    const report = await queryEditor(editor);
    const ok =
      editor.isFocused() &&
      !capsule.isFocused() &&
      BrowserWindow.getFocusedWindow()?.id === editor.id &&
      report.activeElementId === "editor" &&
      report.hasFocus &&
      report.selectionStart === baseline.selectionStart;
    if (!ok)
      failures.push({
        i,
        editorFocused: editor.isFocused(),
        capsuleFocused: capsule.isFocused(),
        report,
      });
  }
  // Synthetic click delivered to the capsule's renderer (does not go through window activation).
  capsule.setIgnoreMouseEvents(false);
  for (const type of ["mouseDown", "mouseUp"]) {
    capsule.webContents.sendInputEvent({
      type,
      x: 120,
      y: 28,
      button: "left",
      clickCount: 1,
    });
  }
  await sleep(150);
  capsule.setIgnoreMouseEvents(true, { forward: true });
  const afterClick = {
    editorFocused: editor.isFocused(),
    capsuleFocused: capsule.isFocused(),
  };
  record(
    "no-focus-steal:same-app-editor (30 show/state/moveTop cycles + synthetic click)",
    failures.length === 0 &&
      afterClick.editorFocused &&
      !afterClick.capsuleFocused
      ? "PASS"
      : "FAIL",
    { baseline, failures, afterClick },
  );

  // 6. Negative control: a focusable window must be detected stealing focus.
  const control = new BrowserWindow({
    width: 200,
    height: 100,
    show: false,
    focusable: true,
  });
  control.show();
  await sleep(300);
  const controlResult = {
    editorFocusedAfterControlShow: editor.isFocused(),
    controlFocused: control.isFocused(),
  };
  control.destroy();
  record(
    "negative-control:focusable-window-steals-focus",
    !controlResult.editorFocusedAfterControlShow && controlResult.controlFocused
      ? "PASS"
      : "FAIL",
    controlResult,
  );

  // 7. Focus retention against a separate app (TextEdit). Skipped if TextEdit is already open so
  //    we never touch the user's documents.
  const textEditRunning = spawnSync("pgrep", ["-x", "TextEdit"]).status === 0;
  if (textEditRunning) {
    record("no-focus-steal:external-app (TextEdit)", "SKIPPED", {
      reason: "TextEdit already running",
    });
  } else {
    spawnSync("open", ["-a", "TextEdit"]);
    const frontmost = await waitFor(
      () => frontBundleId() === "com.apple.TextEdit",
      8000,
    );
    const external = {
      textEditBecameFrontmost: frontmost,
      violations: [],
      nativeFrontmost: null,
    };
    if (frontmost) {
      for (let i = 0; i < 30; i++) {
        capsule.showInactive();
        capsule.moveTop();
        await setCapsuleState(states[i % states.length]);
        const front = frontBundleId();
        if (front !== "com.apple.TextEdit")
          external.violations.push({ i, front });
      }
      external.nativeFrontmost = {
        nsWorkspace: native.frontmostApp()?.bundleId,
        windowList: native.frontmostAppByWindowList()?.bundleId,
      };
      const control2 = new BrowserWindow({
        width: 200,
        height: 100,
        show: false,
        focusable: true,
      });
      control2.show();
      control2.focus();
      await sleep(500);
      external.negativeControlFront = frontBundleId();
      external.nativeFrontmostAfterControl = native.frontmostApp()?.bundleId;
      control2.destroy();
    }
    const pid = spawnSync("pgrep", ["-n", "-x", "TextEdit"])
      .stdout.toString()
      .trim();
    if (pid) process.kill(Number(pid), "SIGTERM");
    record(
      "no-focus-steal:external-app (TextEdit, 30 cycles, lsappinfo)",
      frontmost && external.violations.length === 0 ? "PASS" : "FAIL",
      external,
    );
    record(
      "negative-control:external focusable window takes frontmost",
      external.negativeControlFront &&
        external.negativeControlFront !== "com.apple.TextEdit"
        ? "PASS"
        : "FAIL",
      { front: external.negativeControlFront },
    );
  }
  editor.destroy();

  // 8. Capture exclusion (configuration only)
  capsule.setContentProtection(true);
  record(
    "content-protection-configurable",
    capsule.isContentProtected() ? "PASS" : "FAIL",
    {
      note: "Configured only; exclusion from a real screen share was not observed.",
    },
  );
  capsule.setContentProtection(false);

  // 9. Click-through: Electron has no getter and a real pointer cannot be synthesized here.
  record("click-through", "NOT-TESTED", {
    configured:
      "setIgnoreMouseEvents(true, { forward: true }) while idle; hover toggles interactivity",
    reason:
      "needs a real or synthesized pointer (event posting needs Accessibility, not granted)",
  });

  // 10. Native addon inside Electron (N-API ABI stability)
  const reg = native.registerHotkey(900, "ctrl+opt+f8", {}, () => {});
  const unreg = native.unregisterHotkey(900);
  record(
    "native-addon-loads-in-electron",
    reg.ok && unreg === 0 ? "PASS" : "FAIL",
    {
      electron: process.versions.electron,
      napi: process.versions.napi,
      register: reg,
      permissions: native.permissionStatus(),
    },
  );

  const out = path.join(__dirname, "results", "overlay-selftest.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(
    out,
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        electron: process.versions.electron,
        results,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`wrote ${out}`);
}

module.exports = { runSelftest };
