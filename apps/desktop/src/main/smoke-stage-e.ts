// Smoke checks for Stage E (local features, part 1) in the real windows: the new optional
// shortcuts (unset by default, registered with macOS when set), Command Mode end to end (the
// spoken instruction reaches the Transform panel, nothing is inserted or kept in History),
// Press Enter (recorded, never posted to a real app), and the Notetaker shortcut starting a
// recording. Mute other audio is unit-tested only: muting would silence the developer's Mac.
import { systemPreferences, type BrowserWindow } from "electron";
import type { MurmurApp } from "./app.ts";
import { uiDriver } from "./ui-driver.ts";

type Check = (name: string, ok: boolean, details?: unknown) => void;
type Record = (
  name: string,
  status: "PASS" | "FAIL" | "NOT-TESTED",
  details?: unknown,
) => void;

const NEW = ["commandMode", "pressEnter", "startNotetaker"] as const;

export async function runStageEChecks(
  m: MurmurApp,
  win: BrowserWindow,
  check: Check,
  record: Record,
  provider: { text: string },
  enterPresses: () => number,
): Promise<void> {
  const d = uiDriver(win);
  const { js, sleep, waitFor } = d;
  const s = () => m.settings.get();

  // ---- The shortcuts: listed, unset by default, registered when set -----------------------------
  m.hub!.show("settings/shortcuts");
  // Settings is a dialog too: read the Shortcuts dialog, the one holding these rows.
  const shortcutsDialog = `[...document.querySelectorAll('[role="dialog"]')].find((d) => d.innerText.includes("Join meeting / start Notetaker"))`;
  await waitFor(shortcutsDialog, 5000);
  const dialog = await js<string>(`${shortcutsDialog}?.innerText ?? ""`);
  for (let i = 0; i < 3; i++) {
    if (
      !(await js<boolean>(`Boolean(document.querySelector('[role="dialog"]'))`))
    )
      break;
    await d.key("Escape");
  }
  const unset = NEW.every((a) => s().shortcuts[a] === null);
  const combos = {
    commandMode: "ctrl+opt+f9",
    pressEnter: "ctrl+opt+f10",
    startNotetaker: "ctrl+opt+f11",
  };
  // Plain three-key combinations (at most three keys are allowed); a refusal is reported here
  // instead of stopping the run.
  const refused: { [action: string]: string } = {};
  for (const a of NEW)
    try {
      m.service.setActionShortcut({ action: a, shortcut: combos[a] });
    } catch (err) {
      refused[a] = (err as Error).message;
    }
  const status = await m.service.getStatus();
  check(
    "Stage E shortcuts: Command Mode, Press Enter and Join meeting / start Notetaker are listed, unset by default, and registered with macOS when set",
    /Command Mode/.test(dialog) &&
      /Press Enter/.test(dialog) &&
      /Join meeting \/ start Notetaker/.test(dialog) &&
      unset &&
      NEW.every((a) => status.actions[a]?.registered === true),
    { unset, refused, actions: NEW.map((a) => status.actions[a]) },
  );

  // ---- Command Mode: instruction → Transform panel; nothing inserted or kept ---------------------
  const historyBefore = m.history.count();
  provider.text = "what does this word mean";
  m.runShortcutAction("commandMode", "pressed");
  await sleep(1500);
  m.runShortcutAction("commandMode", "released");
  let panel = m.transformPanel?.current;
  for (let i = 0; i < 40 && (!panel || panel.kind === "hidden"); i++) {
    await sleep(100);
    panel = m.transformPanel?.current;
  }
  check(
    "Command Mode: the spoken request opens the Transform panel (it says what it needs before sending anything); nothing is inserted or kept in History",
    Boolean(panel && panel.kind !== "hidden") &&
      m.history.count() === historyBefore &&
      m.controller.currentPhase === "idle",
    { panel, historyBefore, historyAfter: m.history.count() },
  );
  m.transformPanel?.hide();
  m.sessions?.forget();

  // ---- Press Enter: recorded by the smoke's stand-in, never a real key -------------------------
  const before = enterPresses();
  m.runShortcutAction("pressEnter", "pressed");
  await sleep(200);
  check(
    "Press Enter: the shortcut presses Return once (recorded here, never posted to a real app)",
    enterPresses() === before + 1,
    { presses: enterPresses() - before },
  );

  // ---- Join meeting / start Notetaker -------------------------------------------------------------
  if (systemPreferences.getMediaAccessStatus("microphone") !== "granted")
    record("Notetaker shortcut starts a recording", "NOT-TESTED", {
      reason: "microphone access not granted",
    });
  else {
    const systemBefore = s().notetaker.systemAudio;
    // Automated runs never make macOS ask for a permission (see smoke-notetaker.ts).
    m.settings.update({
      notetaker: {
        systemAudio: false,
        setupCompleted: true,
        consentAcknowledged: true,
      },
    });
    m.runShortcutAction("startNotetaker", "pressed");
    let state = m.notetaker.recordingState();
    for (let i = 0; i < 40 && state.phase !== "recording"; i++) {
      await sleep(100);
      state = m.notetaker.recordingState();
    }
    const shown = await waitFor(
      `document.querySelector('[data-recording-panel="recording"]')`,
      4000,
    );
    const id = state.meetingId;
    await m.notetaker.stopRecording();
    if (id) m.notetaker.delete({ id, confirm: true });
    m.settings.update({ notetaker: { systemAudio: systemBefore } });
    check(
      "Join meeting / start Notetaker: the shortcut starts a new meeting recording and opens it",
      state.phase === "recording" && Boolean(id) && shown,
      { state, shown },
    );
  }

  for (const a of NEW)
    m.service.setActionShortcut({ action: a, shortcut: null });
}
