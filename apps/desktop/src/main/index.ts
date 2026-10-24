import { app } from "electron";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.ts";
import { ownsApp } from "./single-instance.ts";
import { testModeFlags, testModesAllowed } from "./test-modes.ts";

// Test modes (see test-modes.ts) are ignored by packaged builds unless built with them.
// --capture[=dir] renders every screen to PNG against throwaway data (see capture.ts).
// --compare[=dir] renders Murmur next to the private reference screenshots (compare/run.ts).
// --latency[=dir] measures microphone opening and the dictation stages (see latency.ts).
const {
  smoke: SMOKE,
  capture: CAPTURE,
  compare: COMPARE,
  latency: LATENCY,
} = testModeFlags(process.argv, testModesAllowed(app.isPackaged));
const THROWAWAY = SMOKE || CAPTURE || COMPARE || LATENCY;

if (THROWAWAY)
  app.setPath(
    "userData",
    mkdtempSync(join(tmpdir(), SMOKE ? "murmur-smoke-" : "murmur-capture-")),
  );
// `--mcp-stdio` (not a test mode, so packaged builds honour it): a headless stdio bridge for MCP
// clients that run a command (Claude Desktop). No single-instance lock, no window, no data
// folder; it only talks to the running app (main/mcp/bridge.ts). The Dock icon is hidden as
// early as possible; macOS may still show it for an instant because Info.plist has no LSUIElement.
const MCP_STDIO = process.argv.slice(1).includes("--mcp-stdio");
if (MCP_STDIO) {
  try {
    app.setActivationPolicy("prohibited");
    app.dock?.hide();
  } catch {
    // Cosmetic only.
  }
  void import("./mcp/bridge.ts").then(async ({ runStdioBridge }) =>
    app.exit(
      await runStdioBridge({
        env: process.env,
        input: process.stdin,
        output: process.stdout,
        errors: process.stderr,
      }),
    ),
  );
}
const PRIMARY =
  !MCP_STDIO && ownsApp(THROWAWAY, () => app.requestSingleInstanceLock());
// whenReady still fires after quit(), so the second instance leaves at once and never starts up.
if (!PRIMARY && !MCP_STDIO) app.exit(0);

// Menu-bar app: no Dock icon, no window at launch except the first-run onboarding.
app.on("window-all-closed", () => {});

if (PRIMARY)
  app.whenReady().then(async () => {
    // Hidden until settings are read, so a menu-bar app never flashes a Dock icon.
    if (process.platform === "darwin" && !THROWAWAY) app.dock?.hide();
    if (COMPARE) {
      const { runCompare, compareDir } = await import("./compare/run.ts");
      app.exit(await runCompare(compareDir()));
      return;
    }
    if (LATENCY) {
      const { runLatency, latencyDir } = await import("./latency.ts");
      app.exit(await runLatency(latencyDir()));
      return;
    }
    if (CAPTURE) {
      const { runCapture, captureDir } = await import("./capture.ts");
      app.exit(await runCapture(captureDir()!));
      return;
    }
    if (SMOKE) {
      const { runSmoke } = await import("./smoke.ts");
      const code = await runSmoke();
      app.exit(code);
      return;
    }
    // Dock icon per Settings → System (hidden by default: a menu-bar app).
    const murmur = await createApp({ manageDock: true });
    if (!murmur.settings.get().onboardingCompleted)
      murmur.hub?.show("onboarding");
    app.on("second-instance", () => murmur.hub?.show("home"));
    app.on("activate", () => murmur.hub?.show("home"));
    // Quit waits (at most 1.5 s) for the note window to save what was just typed.
    let quitting = false;
    app.on("before-quit", (e) => {
      if (quitting) return;
      quitting = true;
      e.preventDefault();
      void (async () => {
        try {
          await Promise.all([
            murmur.notes?.flush(1500),
            murmur.hub?.flush(1000),
          ]);
          await murmur.dispose();
        } catch (err) {
          murmur.log("app.quit.cleanup-failed", {
            error: (err as Error).name,
          });
        } finally {
          // Everything is saved and closed by now. A second app.quit() here could be cancelled
          // after the windows closed, leaving a windowless Murmur running: exit instead.
          app.exit(0);
        }
      })();
    });
  });
