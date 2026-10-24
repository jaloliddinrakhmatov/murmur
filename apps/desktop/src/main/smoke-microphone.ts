// Smoke checks for Stage 6B in the real app, with the real audio renderer and the Mac's real
// input devices: the device list against CoreAudio, selection driving what a recording opens,
// a missing saved device, the live meter, preview/recording coordination and cleanup, and the
// optional shortcuts through the recorder (real Carbon registration; the fake inserter means
// nothing is pasted for real). Device hot-plugging needs hardware and is a manual check.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { app, systemPreferences, type BrowserWindow } from "electron";
import type { MurmurApp } from "./app.ts";
import { audioRendererStatus, RendererAudioCapture } from "./audio/capture.ts";
import { uiDriver } from "./ui-driver.ts";

type Check = (name: string, ok: boolean, details?: unknown) => void;
type Record = (
  name: string,
  status: "PASS" | "FAIL" | "NOT-TESTED",
  details?: unknown,
) => void;

/** Input devices as CoreAudio lists them (independent of Chromium). */
function coreAudioInputs(): { names: string[]; defaultName: string | null } {
  const r = spawnSync("system_profiler", ["SPAudioDataType", "-json"], {
    encoding: "utf8",
    timeout: 20000,
  });
  const items = (JSON.parse(r.stdout || "{}").SPAudioDataType ?? []).flatMap(
    (x: { _items?: unknown[] }) => x._items ?? [],
  ) as {
    _name: string;
    coreaudio_device_input?: number;
    coreaudio_default_audio_input_device?: string;
  }[];
  const inputs = items.filter((i) => (i.coreaudio_device_input ?? 0) > 0);
  return {
    names: inputs.map((i) => i._name).sort(),
    defaultName:
      inputs.find((i) => i.coreaudio_default_audio_input_device)?._name ?? null,
  };
}

export async function runMicrophoneChecks(
  m: MurmurApp,
  win: BrowserWindow,
  inserter: { calls: { text: string }[] },
  check: Check,
  record: Record,
): Promise<void> {
  const d = uiDriver(win);
  const { js, sleep, waitFor, click, key } = d;
  const wc = win.webContents;
  const status = () => audioRendererStatus(m.audioLink);
  const settingsFile = () =>
    JSON.parse(
      readFileSync(join(app.getPath("userData"), "settings.json"), "utf8"),
    );
  await d.emulateFocus(true);

  // Stage 8 security: only the hidden audio window may use the microphone.
  const hubMic = await js<string>(
    `navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => { s.getTracks().forEach((t) => t.stop()); return "granted"; }, (e) => e.name)`,
  );
  check(
    "security: the Settings window is refused the microphone (only the audio window may use it)",
    hubMic === "NotAllowedError",
    { hubMic },
  );

  if (systemPreferences.getMediaAccessStatus("microphone") !== "granted") {
    record("microphones (real devices)", "NOT-TESTED", "no microphone access");
  } else {
    // ---- Enumeration: Chromium's list matches CoreAudio's, without aliases or duplicates ------
    const info = await m.microphones.list();
    const core = coreAudioInputs();
    const ids = info.devices.map((x) => x.id);
    const names = info.devices.map((x) => x.name ?? "").sort();
    const def = info.devices.find((x) => x.id === info.systemDefault);
    check(
      "microphones: every CoreAudio input is listed once by name, no aliases; the system default is identified",
      ids.length > 0 &&
        new Set(ids).size === ids.length &&
        !ids.some((i) => i === "default" || i === "communications") &&
        JSON.stringify(names) === JSON.stringify(core.names) &&
        def?.name === core.defaultName,
      { chromium: names, coreAudio: core, systemDefault: def?.name },
    );

    // ---- Selection decides what a recording opens (same wiring as the app's capture) ---------
    const opened: { deviceId: string | null; fallback: boolean }[] = [];
    const cap = new RendererAudioCapture(m.audioLink, () => {}, {
      device: () => m.microphones.requested(),
      onStarted: (i) => opened.push(i),
    });
    const recordFrom = async () => {
      await cap.start();
      await sleep(500);
      const got = await cap.stop();
      return { ...opened.at(-1)!, peakRms: got.peakRms, ms: got.durationMs };
    };
    const perDevice: unknown[] = [];
    let allExact = true;
    for (const dev of info.devices) {
      await m.microphones.select({ deviceId: dev.id });
      const r = await recordFrom();
      perDevice.push({ name: dev.name, ...r, deviceId: undefined });
      if (r.deviceId !== dev.id || r.fallback || r.ms < 300) allExact = false;
    }
    await m.microphones.select({ deviceId: null });
    const viaDefault = await recordFrom();
    check(
      "microphones: choosing a device makes the next recording open exactly that device (each input tried)",
      allExact &&
        viaDefault.deviceId === info.systemDefault &&
        !viaDefault.fallback,
      { perDevice, systemDefault: { ...viaDefault, deviceId: undefined } },
    );

    // ---- Persisted; a saved device that's missing falls back to the default, and says so -----
    const other = info.devices.find((x) => x.id !== info.systemDefault);
    if (other) await m.microphones.select({ deviceId: other.id });
    const saved = settingsFile().microphone;
    m.settings.set("microphone", {
      deviceId: "smoke-missing-device",
      name: "Smoke Test Mic",
    });
    const missing = await recordFrom();
    const missingInfo = await m.microphones.list();
    m.hub!.show("settings/general");
    await waitFor(`document.getElementById("microphone-change")`, 5000);
    await sleep(400);
    const row = await js<string>(
      `document.getElementById("microphone-change-desc")?.innerText ?? ""`,
    );
    check(
      "microphones: the choice is saved; a missing saved device is never claimed — the default opens and Settings says so",
      (!other || saved.deviceId === other.id) &&
        missing.fallback &&
        missing.deviceId === info.systemDefault &&
        !missingInfo.selectedAvailable &&
        row.includes("Smoke Test Mic isn't connected"),
      { saved: Boolean(saved.deviceId), missing, row: row.slice(0, 160) },
    );
    await m.microphones.select({ deviceId: null });

    // ---- The dialog: real levels on the meter, a choice from the cards, released on close ----
    await click("#microphone-change");
    await waitFor(`document.querySelector('[role="meter"]')`, 4000);
    let peakLit = 0;
    let previewOpen = false;
    for (let i = 0; i < 30; i++) {
      await sleep(100);
      peakLit = Math.max(
        peakLit,
        await js<number>(
          `Number(document.querySelector('[role="meter"]')?.getAttribute("aria-valuenow") ?? 0)`,
        ),
      );
      if (!previewOpen) previewOpen = (await status()).preview;
    }
    const cards = await js<{ key: string; checked: string }[]>(
      `[...document.querySelectorAll('[role="radio"][data-mic-card]')].map((c) => ({ key: c.dataset.micCard, checked: c.getAttribute("aria-checked") }))`,
    );
    record(
      "microphones: the meter moves with real input (room sound; silence is possible)",
      peakLit > 0 ? "PASS" : "NOT-TESTED",
      { peakPercent: peakLit },
    );
    // Choose another device from the cards (opening the folded list if needed).
    await js(
      `[...document.querySelectorAll("button[aria-expanded]")].find((b) => b.textContent.includes("other devices"))?.click()`,
    );
    await sleep(200);
    const target = info.devices.find((x) => x.id !== info.systemDefault);
    if (target)
      await js(
        `document.querySelector('[data-mic-card="${target.id}"]')?.click()`,
      );
    await sleep(800);
    const radiosAfter = await js<{ key: string; checked: string }[]>(
      `[...document.querySelectorAll('[role="radio"][data-mic-card]')].map((c) => ({ key: c.dataset.micCard, checked: c.getAttribute("aria-checked") }))`,
    );
    const chosenInUi =
      radiosAfter.find((r) => r.checked === "true")?.key ?? null;
    check(
      "microphone dialog: cards list the system default first; choosing a card saves it; the preview runs while open",
      cards[0]?.key === "system" &&
        cards[0]?.checked === "true" &&
        previewOpen &&
        (!target ||
          (m.settings.get().microphone.deviceId === target.id &&
            chosenInUi === target.id)),
      {
        cards: cards.length,
        previewOpen,
        chosen: Boolean(chosenInUi),
        after: radiosAfter.map((r) => [r.key.slice(0, 6), r.checked]),
      },
    );
    await m.microphones.select({ deviceId: null });
    await key("Escape");
    await sleep(500);
    const afterClose = await status();
    check(
      "microphone dialog: closing it releases the microphone at once",
      !afterClose.open &&
        afterClose.contexts === 0 &&
        m.microphones.previewCount === 0,
      afterClose,
    );

    // ---- Rapid open/close leaks nothing --------------------------------------------------------
    for (let i = 0; i < 10; i++) {
      await click("#microphone-change");
      await sleep(60 + (i % 3) * 40);
      await key("Escape");
      await sleep(40);
    }
    await sleep(900);
    const afterRapid = await status();
    check(
      "microphone dialog: opening and closing it 10 times quickly leaves no stream or AudioContext open",
      !afterRapid.open &&
        afterRapid.contexts === 0 &&
        m.microphones.previewCount === 0,
      afterRapid,
    );

    // ---- A recording takes over from the preview; the preview resumes; one stream at a time --
    await click("#microphone-change");
    await waitFor(`document.querySelector('[role="meter"]')`, 4000);
    await sleep(700);
    const before = await status();
    await cap.start();
    await sleep(300);
    const during = await status();
    const micDialog = `document.querySelector('[aria-label="Microphone for dictation"]')?.closest('[role="dialog"]')`;
    const duringUi = await js<string>(`${micDialog}?.innerText ?? ""`);
    await cap.stop();
    await sleep(900);
    const resumed = await status();
    check(
      "preview and recording: dictation closes the preview first (never two streams) and it resumes afterwards",
      before.preview &&
        during.recording &&
        !during.preview &&
        during.contexts === 1 &&
        resumed.preview &&
        !resumed.recording &&
        /Paused while you dictate|Dictating now/.test(duringUi),
      { before, during, resumed, ui: duringUi.slice(0, 160) },
    );
    // A reload of the Settings window drops its preview (its owner went away).
    const reloaded = new Promise<void>((r) =>
      wc.once("did-finish-load", () => r()),
    );
    wc.reload();
    await reloaded;
    await sleep(600);
    const afterReload = await status();
    check(
      "preview: reloading the window that owns it releases the microphone",
      !afterReload.open && m.microphones.previewCount === 0,
      afterReload,
    );
    await waitFor(`document.querySelector('nav[aria-label="Main"]')`, 5000);
    await d.emulateFocus(true);
  }

  // ---- Optional shortcuts through the recorder (real Carbon registration) ----------------------
  m.hub!.show("settings/shortcuts");
  await waitFor(`document.getElementById("shortcut-copyLast")`, 5000);
  await sleep(300);
  const press = async (keyCode: string, modifiers: string[]) => {
    wc.sendInputEvent({
      type: "keyDown",
      keyCode,
      modifiers: modifiers as never,
    });
    wc.sendInputEvent({
      type: "keyUp",
      keyCode,
      modifiers: modifiers as never,
    });
    await sleep(700);
  };
  const cardText = (action: string) =>
    js<string>(
      `document.getElementById("shortcut-${action}").closest("section").innerText`,
    );
  const held = (combo: string) => {
    // Carbon refuses a second registration of a combination this process already holds.
    const r = m.native.registerHotkey(98, combo, { exclusive: true }, () => {});
    if (r.ok) m.native.unregisterHotkey(98);
    return !r.ok;
  };
  const ptt = m.hotkeys.current.combo;

  await click("#shortcut-copyLast");
  await sleep(200);
  const suspendedWhileListening = m.hotkeys.isSuspended && !held(ptt);
  await press("9", ["control", "meta"]);
  await waitFor(`!document.querySelector("[data-shortcut-recording]")`);
  const copyText = await cardText("copyLast");
  check(
    "shortcuts: recording pauses Murmur's shortcuts; a new Copy last transcript combination is registered, then saved",
    suspendedWhileListening &&
      !m.hotkeys.isSuspended &&
      held(ptt) &&
      m.hotkeys.actions.copyLast?.registered === true &&
      held("ctrl+cmd+9") &&
      m.settings.get().shortcuts.copyLast === "ctrl+cmd+9" &&
      settingsFile().shortcuts.copyLast === "ctrl+cmd+9" &&
      copyText.includes("Saved."),
    { actions: m.hotkeys.actions, text: copyText.slice(0, 120) },
  );

  // Murmur's own push-to-talk combination, and one another app holds, are refused.
  await click("#shortcut-pasteLast");
  await press(ptt.split("+").at(-1)!.toUpperCase(), ["control", "alt"]);
  const pttConflict = await cardText("pasteLast");
  await key("Escape");
  const taken = ["ctrl+cmd+8", "ctrl+cmd+7"].find(
    (c) => m.native.registerHotkey(99, c, { exclusive: true }, () => {}).ok,
  );
  await click("#shortcut-copyLast");
  await press(taken!.split("+")[2], ["control", "meta"]);
  const takenText = await cardText("copyLast");
  m.native.unregisterHotkey(99);
  await key("Escape");
  check(
    "shortcuts: Murmur's own push-to-talk keys and keys another app holds are refused; the working binding stays",
    /already uses that shortcut for Push to talk/.test(pttConflict) &&
      m.settings.get().shortcuts.pasteLast === null &&
      /already used by another app/.test(takenText) &&
      m.settings.get().shortcuts.copyLast === "ctrl+cmd+9" &&
      held("ctrl+cmd+9") &&
      held(ptt) &&
      !m.hotkeys.isSuspended,
    { pttConflict: pttConflict.slice(0, 120), taken: takenText.slice(0, 120) },
  );

  // Esc cancels a recording without changing anything.
  await click("#shortcut-copyOriginal");
  await sleep(150);
  await key("Escape");
  const stillOpen = await js<boolean>(
    `Boolean(document.getElementById("shortcut-copyOriginal"))`,
  );
  check(
    "shortcuts: Esc stops listening (shortcuts resume) without closing the dialog or saving",
    stillOpen &&
      !m.hotkeys.isSuspended &&
      m.settings.get().shortcuts.copyOriginal === null,
    { suspended: m.hotkeys.isSuspended },
  );

  // The action works: paste goes through the dictation inserter, once per press. (History was
  // emptied by earlier checks, so a delivered dictation is added first.)
  m.history.insert({
    id: "smoke-last-transcript",
    startedAt: Date.now(),
    durationMs: 2000,
    status: "inserted",
    strategy: "clipboard-paste",
    rawText: "um paste me again",
    finalText: "Paste me again.",
    wordCount: 3,
    appName: null,
    appBundleId: null,
    error: null,
    provider: "smoke-fake",
    hasAudio: false,
  });
  inserter.calls.length = 0;
  m.runShortcutAction("pasteLast", "pressed");
  m.runShortcutAction("pasteLast", "released");
  m.runShortcutAction("pasteLast", "released");
  await sleep(500);
  const pasteCalls = inserter.calls.length;
  check(
    "shortcuts: Paste last transcript pastes on key-up through the dictation inserter, once for a repeated event",
    pasteCalls === 1 && inserter.calls[0]?.text === "Paste me again.",
    { pasteCalls },
  );

  // Removing it unregisters it.
  await js(
    `document.querySelector('[aria-label="Remove the Copy last transcript shortcut"]').click()`,
  );
  await sleep(500);
  check(
    "shortcuts: removing one unregisters it and saves the change",
    m.settings.get().shortcuts.copyLast === null &&
      m.hotkeys.actions.copyLast === null &&
      !held("ctrl+cmd+9") &&
      held(ptt),
    { actions: m.hotkeys.actions },
  );
  // Left set, so the reset check (Stage 6A, last) can show reset clears it.
  await m.service.setActionShortcut({
    action: "copyOriginal",
    shortcut: "ctrl+cmd+0",
  });
  await key("Escape");
  await d.emulateFocus(false);
}
