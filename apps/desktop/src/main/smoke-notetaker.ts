// Smoke checks for Notetaker (Stage 9D-1) in the real Hub window, against the throwaway profile:
// the page and its honest empty states, Set up Notetaker from start to finish (no permission is
// requested, nothing records), the sidebar card, a meeting created, renamed, timed, typed into
// and saved, reload restoring it, search, delete with confirmation, Settings → Notetaker, and
// the log never carrying meeting text. Export and Import open native file dialogs, so they're
// covered by unit tests (test/notetaker.test.ts), not here.
import { app, systemPreferences, type BrowserWindow } from "electron";
import { existsSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { audioRendererStatus } from "./audio/capture.ts";
import type { MurmurApp } from "./app.ts";
import { uiDriver } from "./ui-driver.ts";
import { setupChecklist } from "../renderer/hub/model/setup.ts";

type Check = (name: string, ok: boolean, details?: unknown) => void;

const MAIN = `document.querySelector("main#main")`;
const DIALOG = `document.querySelector('[role="dialog"]')`;
/** Anything that says a recording is running (shown only while the recorder says so). */
const RECORDING_SHOWN = `Boolean(document.querySelector("[data-recording-banner], [data-recording-panel]"))`;

type Record = (
  name: string,
  status: "PASS" | "FAIL" | "NOT-TESTED",
  details?: unknown,
) => void;

export async function runNotetakerChecks(
  m: MurmurApp,
  win: BrowserWindow,
  check: Check,
  record: Record,
  /** The smoke's fake transcription service (its text is what the recording "said"). */
  provider: { text: string; heard: number[] },
): Promise<void> {
  const d = uiDriver(win);
  const { js, sleep, waitFor, key, clickText, type } = d;
  const s = () => m.settings.get().notetaker;
  const mainText = () => js<string>(`${MAIN}?.innerText ?? ""`);
  const dialogText = () => js<string>(`${DIALOG}?.innerText ?? ""`);

  // Everything the app logs during these checks, to prove meeting text never reaches it.
  const logged: string[] = [];
  const consoleLog = console.log;
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
    consoleLog(...args);
  };
  try {
    m.notetaker.deleteAll();
    m.settings.update({
      notetaker: {
        setupCompleted: false,
        setupCardDismissed: false,
        consentAcknowledged: false,
        retentionDays: 0,
      },
    });
    await d.emulateFocus(true);

    // ---- Page --------------------------------------------------------------------------------
    m.hub!.show("notetaker");
    await waitFor(
      `document.querySelector("main#main h1")?.textContent === "Notetaker"`,
    );
    await waitFor(`${MAIN}.innerText.includes("No meetings today")`);
    const page = await mainText();
    check(
      "notetaker page: title, settings gear, Start Notetaker, New meeting note, Today with Set up Notetaker, Past notes with an honest empty state",
      /Start Notetaker/.test(page) &&
        (await js<boolean>(
          `Boolean(document.querySelector('main#main button[aria-label="New meeting note"]'))`,
        )) &&
        /TODAY/i.test(page) &&
        /Set up Notetaker/.test(page) &&
        /No meetings today/.test(page) &&
        /Past notes/.test(page) &&
        /Your meetings will appear here/.test(page) &&
        (await js<boolean>(
          `Boolean(document.querySelector('main#main button[aria-label="Notetaker settings"]'))`,
        )),
      page.slice(0, 600),
    );
    check(
      "nothing shows as recording until a recording is started (and the right column says Recording off)",
      !(await js<boolean>(RECORDING_SHOWN)) &&
        /Recording off/.test(
          await js<string>(
            `document.querySelector('aside[aria-label="Notetaker status"]')?.innerText ?? "Recording off"`,
          ),
        ) &&
        m.notetaker.recordingState().phase === "idle",
      page.slice(0, 300),
    );

    // ---- Sidebar card: after Murmur's own setup ----------------------------------------------
    const murmurReady = setupChecklist(await m.service.getStatus()).complete;
    const card = () =>
      js<string | null>(
        `document.querySelector('[data-setup-kind="notetaker"]')?.innerText ?? null`,
      );
    await sleep(400);
    const cardBefore = await card();
    check(
      "sidebar: Set up Notetaker appears once Murmur itself is set up (and not before)",
      murmurReady
        ? /Set up Notetaker/.test(cardBefore ?? "") &&
            /Write your first meeting note/.test(cardBefore ?? "")
        : cardBefore === null,
      { murmurReady, cardBefore },
    );

    // ---- Set up Notetaker: every step, no permission requested, nothing saved on Cancel -------
    const micBefore = systemPreferences.getMediaAccessStatus("microphone");
    await clickText("Start", MAIN);
    await waitFor(`${DIALOG}?.innerText.includes("Meet Notetaker")`);
    await clickText("Cancel", DIALOG);
    await waitFor(`!${DIALOG}`);
    const cancelled = s().setupCompleted === false;

    await clickText("Start", MAIN);
    await waitFor(`${DIALOG}?.innerText.includes("Meet Notetaker")`);
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      seen.push(
        await js<string>(
          `document.querySelector("[data-notetaker-setup]")?.getAttribute("data-notetaker-setup") ?? ""`,
        ),
      );
      const text = await dialogText();
      if (seen.at(-1) === "audio")
        seen.push(
          /System Audio Recording/.test(text) &&
            /doesn't ask for it now/.test(text)
            ? "system-audio-explained"
            : "system-audio-missing",
        );
      if (seen.at(-1) === "microphone") {
        await waitFor(
          `${DIALOG}?.innerText.match(/Allowed|Not asked yet|Off|Restricted|Unknown/)`,
        );
        seen.push(
          /Microphone access/.test(await dialogText())
            ? "mic-status"
            : "mic-missing",
        );
      }
      if (seen.at(-1) === "services") {
        await waitFor(`${DIALOG}?.innerText.match(/Ready|Not ready/)`);
        seen.push(
          /Transcription/.test(await dialogText()) ? "services-shown" : "x",
        );
      }
      await clickText("Continue", DIALOG);
      await sleep(250);
    }
    const finishDisabled = await js<boolean>(
      `[...${DIALOG}.querySelectorAll("button")].find((b) => b.textContent.trim() === "Finish")?.disabled ?? false`,
    );
    await js(`${DIALOG}.querySelector('input[type="checkbox"]').click()`);
    await sleep(200);
    await clickText("Finish", DIALOG);
    await waitFor(`!${DIALOG}`, 4000);
    const afterSetup = s();
    const micAfter = systemPreferences.getMediaAccessStatus("microphone");
    check(
      "set up Notetaker: Cancel saves nothing; six steps explain audio (system audio not requested), microphone and services; Finish needs consent and saves",
      cancelled &&
        seen.includes("system-audio-explained") &&
        seen.includes("mic-status") &&
        seen.includes("services-shown") &&
        finishDisabled &&
        afterSetup.setupCompleted &&
        afterSetup.consentAcknowledged &&
        micAfter === micBefore,
      { seen, finishDisabled, afterSetup, micBefore, micAfter },
    );
    await sleep(300);
    const pageAfterSetup = await mainText();
    check(
      "after setup the Today card no longer offers it; setup can be reopened from Settings",
      !/Set up Notetaker/.test(pageAfterSetup) &&
        /No meetings today/.test(pageAfterSetup),
      pageAfterSetup.slice(0, 300),
    );

    // ---- A meeting: create, rename, times, notes autosave ------------------------------------
    await js(
      `document.querySelector('main#main button[aria-label="New meeting note"]').click()`,
    );
    await waitFor(`document.querySelector("[data-meeting-detail]")`, 4000);
    const id = await js<string>(
      `document.querySelector("[data-meeting-detail]").getAttribute("data-meeting-detail")`,
    );
    const created = m.notetaker.get({ id });
    const detail = await mainText();
    check(
      "New meeting note opens a meeting with a default title, now as its time, empty Transcript and Summary (nothing invented)",
      created !== null &&
        /^Meeting, /.test(created.title) &&
        created.startedAt !== null &&
        Math.abs(created.startedAt - Date.now()) < 60_000 &&
        created.notes === "" &&
        created.status === "notes" &&
        /Transcript/.test(detail) &&
        /No recording yet\./.test(detail) &&
        /once there's a transcript/.test(detail) &&
        /Start recording/.test(detail) &&
        /Same as dictation/.test(detail) &&
        !(await js<boolean>(RECORDING_SHOWN)),
      { created, detail: detail.slice(0, 500) },
    );

    const title = `input[aria-label="Meeting title"]`;
    await js(
      `(() => { const i = document.querySelector('${title}'); i.focus(); i.select(); })()`,
    );
    await type("Design review ✅ ünïcode");
    await key("Return");
    await sleep(500);
    const renamed = m.notetaker.get({ id })?.title;

    // An end before the start is refused on the page and nothing is saved.
    // Set the value, let React render it, then leave the field (as a person would).
    const timeInput = (label: string) =>
      `[...document.querySelectorAll('main#main label')].find((l) => l.textContent.startsWith(${JSON.stringify(label)})).querySelector("input")`;
    const setTime = async (label: string, value: string) => {
      await js(
        `(() => { const i = ${timeInput(label)}; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; i.focus(); set.call(i, ${JSON.stringify(value)}); i.dispatchEvent(new Event("input", { bubbles: true })); })()`,
      );
      await sleep(150);
      await js(`${timeInput(label)}.blur()`);
    };
    await setTime("Started", "2026-10-19T10:00");
    await sleep(300);
    await setTime("Ended", "2026-10-19T09:00");
    await sleep(400);
    const timeError = await js<string>(
      `document.querySelector('main#main [role="alert"]')?.textContent ?? ""`,
    );
    const afterBadEnd = m.notetaker.get({ id });
    await setTime("Ended", "2026-10-19T10:45");
    await sleep(500);
    const afterGoodEnd = m.notetaker.get({ id });
    check(
      "title edits save; an end before the start is refused with a message; a valid end saves and shows the duration",
      renamed === "Design review ✅ ünïcode" &&
        /after the start/.test(timeError) &&
        afterBadEnd?.endedAt === null &&
        afterGoodEnd?.endedAt !== null &&
        (afterGoodEnd?.endedAt ?? 0) - (afterGoodEnd?.startedAt ?? 0) ===
          45 * 60_000 &&
        /45 min/.test(await mainText()),
      { renamed, timeError, afterBadEnd, afterGoodEnd },
    );

    const notes = "Decisions:\n- ship ✅\n- 日本語 notes";
    await js(`document.querySelector('main#main textarea').focus()`);
    await type(notes);
    const saved = await waitFor(
      `[...document.querySelectorAll('main#main [role="status"]')].some((e) => e.textContent === "Saved")`,
      4000,
    );
    check(
      "notes save as you type (Saved), Unicode intact",
      saved && m.notetaker.get({ id })?.notes === notes,
      { saved, stored: m.notetaker.get({ id })?.notes },
    );

    // ---- Reload restores everything --------------------------------------------------------
    win.webContents.reload();
    await waitFor(`document.querySelector('nav[aria-label="Main"]')`, 8000);
    await d.emulateFocus(true);
    m.hub!.show("notetaker");
    await waitFor(`${MAIN}?.innerText.includes("Design review")`, 4000);
    const listText = await mainText();
    await js(
      `[...document.querySelectorAll('main#main ul[aria-label="Meetings"] li button')].find((b) => b.textContent.includes("Design review")).click()`,
    );
    await waitFor(`document.querySelector("[data-meeting-detail]")`, 4000);
    const restored = await js<{ title: string; notes: string }>(
      `({ title: document.querySelector('${title}').value, notes: document.querySelector('main#main textarea').value })`,
    );
    check(
      "after a reload the meeting is listed under Today and Past notes and opens with its title and notes",
      listText.includes("Design review") &&
        restored.title === "Design review ✅ ünïcode" &&
        restored.notes === notes,
      { restored, listText: listText.slice(0, 400) },
    );
    await clickText("Notetaker", MAIN);
    await waitFor(`!document.querySelector("[data-meeting-detail]")`);

    // ---- Search ------------------------------------------------------------------------------
    m.notetaker.create({
      title: "Budget sync",
      startedAt: Date.now() - 3 * 86_400_000,
    });
    await waitFor(`${MAIN}.innerText.includes("Budget sync")`);
    await js(
      `document.querySelector('main#main button[aria-label="Search meetings"]').click()`,
    );
    await sleep(200);
    await type("日本語");
    await sleep(500);
    const searched = await js<string[]>(
      `[...document.querySelectorAll('main#main ul[aria-label="Meetings"] li')].map((l) => l.innerText.split("\\n")[0])`,
    );
    await key("Escape");
    await key("Escape");
    await waitFor(`${MAIN}.innerText.includes("Budget sync")`);
    check(
      "search finds meetings by their notes (Unicode) and hides the others",
      searched.length === 1 && searched[0].includes("Design review"),
      searched,
    );

    // ---- Delete with confirmation ----------------------------------------------------------
    await js(
      `document.querySelector('main#main button[aria-label="More actions for Budget sync"]').focus()`,
    );
    await key("Return");
    await waitFor(`document.querySelector('[role="menuitem"]')`);
    await js(
      `[...document.querySelectorAll('[role="menuitem"]')].find((x) => x.textContent.trim() === "Delete…").click()`,
    );
    await waitFor(`document.querySelector('[role="alertdialog"]')`);
    const confirmText = await js<string>(
      `document.querySelector('[role="alertdialog"]').innerText`,
    );
    const stillThere = m.notetaker.list().length === 2;
    await js(
      `[...document.querySelectorAll('[role="alertdialog"] button')].find((b) => b.textContent.trim() === "Delete meeting").click()`,
    );
    await waitFor(`!document.querySelector('[role="alertdialog"]')`, 3000);
    await sleep(300);
    const titles = m.notetaker.list().map((x) => x.title);
    check(
      "delete asks first (nothing deleted until confirmed), then removes only that meeting",
      /can't be undone/.test(confirmText) &&
        stillThere &&
        titles.length === 1 &&
        titles[0] === "Design review ✅ ünïcode",
      { confirmText, titles },
    );

    // ---- Settings → Notetaker --------------------------------------------------------------
    await js(
      `document.querySelector('main#main button[aria-label="Notetaker settings"]').click()`,
    );
    await waitFor(
      `document.getElementById("settings-section-title")?.textContent === "Notetaker"`,
    );
    const pane = await js<string>(
      `document.querySelector('section[aria-labelledby="settings-section-title"]').innerText`,
    );
    await key("Escape");
    await waitFor(`!document.getElementById("settings-section-title")`);
    check(
      "the gear opens Settings → Notetaker: setup, your Mac's sound, maximum length, recording now Off, Keep meetings for, Import (no reference rows without behaviour)",
      /Review setup/.test(pane) &&
        /Record your Mac's sound/.test(pane) &&
        /Label speakers/.test(pane) &&
        /Maximum recording length/.test(pane) &&
        /Recording now[\s\S]{0,200}\bOff\b/.test(pane) &&
        /Keep meetings for/.test(pane) &&
        /Import your meeting notes/.test(pane) &&
        !/Notify before scheduled meetings|Automatically detect any call|Default link permission/.test(
          pane,
        ),
      pane.slice(0, 600),
    );

    await runRecordingChecks(m, win, check, record, provider);

    // ---- Privacy: the log ----------------------------------------------------------------------
    const log = logged.join("\n");
    const leaked = [
      "Design review",
      "ünïcode",
      "日本語",
      "Budget sync",
      "ship ✅",
      SPOKEN,
    ].filter((x) => log.includes(x));
    check(
      "privacy: meeting titles, notes and transcripts never appear in the log",
      leaked.length === 0 && /meeting\.(created|deleted)/.test(log),
      { leaked, events: logged.length },
    );
  } finally {
    console.log = consoleLog;
    m.notetaker.deleteAll();
  }
}

const SPOKEN = "we agreed to ship the release on friday";

/**
 * Stage 9D-2 in the real windows: a meeting recorded with the real microphone (the fake
 * transcription service), shown as recording on the page, the Capsule and the menu bar only
 * while it runs; dictation refused meanwhile; Pause really closing the microphone; Stop leading
 * to a transcript and the audio being deleted. Needs microphone access: without it, NOT-TESTED.
 */
async function runRecordingChecks(
  m: MurmurApp,
  win: BrowserWindow,
  check: Check,
  record: Record,
  provider: { text: string; heard: number[] },
): Promise<void> {
  const d = uiDriver(win);
  const { js, sleep, waitFor } = d;
  const name = "meeting recording with the real microphone";
  if (systemPreferences.getMediaAccessStatus("microphone") !== "granted") {
    record(name, "NOT-TESTED", { reason: "microphone access not granted" });
    return;
  }
  provider.text = SPOKEN;
  // Automated runs never make macOS ask for a permission: your Mac's sound is recorded here only
  // when you opt in (MURMUR_SMOKE_SYSTEM_AUDIO=1, after granting it once by hand).
  const withSystem = process.env.MURMUR_SMOKE_SYSTEM_AUDIO === "1";
  const systemBefore = m.settings.get().notetaker.systemAudio;
  m.settings.update({ notetaker: { systemAudio: withSystem } });
  if (!withSystem)
    record("meeting recording of your Mac's sound", "NOT-TESTED", {
      reason:
        "off in automated runs so macOS never asks for permission; set MURMUR_SMOKE_SYSTEM_AUDIO=1 to include it",
    });
  const meeting = m.notetaker.create({ title: "Recording check" });
  m.hub!.show(`notetaker/${meeting.id}`);
  await waitFor(`document.querySelector("[data-meeting-detail]")`, 4000);
  await js(
    `[...document.querySelectorAll('main#main button')].find((b) => b.textContent.trim() === "Start recording").click()`,
  );
  const recording = await waitFor(
    `document.querySelector('[data-recording-panel="recording"]')`,
    6000,
  );
  if (!recording) {
    check(`${name}: Start opens the recording`, false, {
      state: m.notetaker.recordingState(),
      page: (await js<string>(`${MAIN}.innerText`)).slice(0, 400),
    });
    return;
  }
  // With your Mac's sound opted in, the Mac speaks: the tap (and the microphone) must hear it.
  if (withSystem)
    execFile("say", ["Murmur meeting recording check. One, two, three, four."]);
  await sleep(withSystem ? 4000 : 2500);
  const live = m.notetaker.recordingState();
  const capsuleSays = await m.capsule.win.webContents.executeJavaScript(
    `document.getElementById("capsule")?.getAttribute("aria-label") ?? ""`,
  );
  const sys = live.systemAudio;
  const panel = await js<string>(
    `document.querySelector("[data-recording-panel]").innerText`,
  );
  check(
    "Start recording: the microphone records; the page, the Murmur bar and the state all say so; system audio says why when it isn't recorded",
    live.phase === "recording" &&
      live.elapsedMs >= 1500 &&
      m.capsule.win.isVisible() &&
      capsuleSays === "Meeting recording on" &&
      /Recording/.test(panel) &&
      (withSystem
        ? sys.state === "on" ||
          (sys.state === "unavailable" && panel.includes(sys.reason))
        : sys.state === "off" && panel.includes("Off (Settings → Notetaker)")),
    { live, capsuleSays, panel: panel.slice(0, 300) },
  );

  // Dictation is refused while the meeting records, and says why.
  const audioBefore = await audioRendererStatus(m.audioLink).catch(() => null);
  m.controller.hotkey("down");
  await sleep(300);
  m.controller.hotkey("up");
  check(
    "while a meeting records, the dictation shortcut starts nothing and the Murmur bar says why",
    m.controller.currentPhase === "idle" &&
      (
        await m.capsule.win.webContents.executeJavaScript(
          `document.getElementById("capsule")?.innerText ?? ""`,
        )
      ).includes("Meeting recording on"),
    { phase: m.controller.currentPhase, audioBefore },
  );

  // Pause closes the microphone; Resume opens it again.
  await m.notetaker.pauseRecording();
  await sleep(400);
  const paused = await audioRendererStatus(m.audioLink);
  const pausedAt = m.notetaker.recordingState().elapsedMs;
  await sleep(1000);
  const stillPaused = m.notetaker.recordingState().elapsedMs;
  await m.notetaker.resumeRecording();
  await sleep(1200);
  const resumed = await audioRendererStatus(m.audioLink);
  check(
    "Pause really closes the microphone and stops the clock; Resume reopens it",
    !paused.open &&
      !paused.recording &&
      pausedAt === stillPaused &&
      resumed.recording,
    { paused, pausedAt, stillPaused, resumed },
  );

  // Stop: transcribed by the (fake) service, the audio deleted, the microphone closed.
  await js(
    `[...document.querySelectorAll('[data-recording-panel] button')].find((b) => b.textContent.trim() === "Stop").click()`,
  );
  const done = await waitFor(
    `document.querySelector('[data-meeting-section="transcript"]')?.innerText.includes(${JSON.stringify(SPOKEN)})`,
    10_000,
  );
  // With your Mac's sound, the two tracks are labelled. The fake service answers the same words
  // for both, so the microphone's copy is echo and only Others remains.
  const expected = withSystem ? `Others: ${SPOKEN}` : SPOKEN;
  const after = m.notetaker.get({ id: meeting.id });
  const audioDir = join(app.getPath("userData"), "meeting-audio");
  const leftover = existsSync(audioDir)
    ? readdirSync(audioDir).filter((f) => f.startsWith(meeting.id))
    : [];
  const closed = await audioRendererStatus(m.audioLink);
  check(
    "Stop: the recording is transcribed, the transcript shows, the audio is deleted, the microphone is closed, nothing shows as recording",
    done &&
      after?.status === "ready" &&
      after.transcript === expected &&
      after.audioParts === 0 &&
      after.recordedMs >= 2500 &&
      leftover.length === 0 &&
      !closed.open &&
      !(await js<boolean>(RECORDING_SHOWN)) &&
      m.notetaker.recordingState().phase === "idle",
    { status: after?.status, recordedMs: after?.recordedMs, leftover, closed },
  );

  // What was sent for transcription must contain sound (with the Mac speaking, it's loud).
  const heard = provider.heard.at(-1) ?? 0;
  if (withSystem)
    check(
      "your Mac's sound is recorded: the Mac speaking is in the audio sent for transcription",
      heard > 0.02,
      { heardPeakRms: heard },
    );
  else
    record(
      "recorded audio contains sound (needs the Mac to speak)",
      "NOT-TESTED",
      {
        heardPeakRms: heard,
        reason: "runs with MURMUR_SMOKE_SYSTEM_AUDIO=1",
      },
    );

  // A summary asks for the AI service first; nothing is sent in this throwaway profile.
  const summary = await js<string>(
    `document.querySelector('[data-meeting-section="summary"]')?.innerText ?? ""`,
  );
  check(
    "Summary: offered only once there is a transcript, and it says what it needs before sending anything",
    /Summaries use|Allow and summarize|Summarize/.test(summary),
    summary.slice(0, 200),
  );
  m.notetaker.delete({ id: meeting.id, confirm: true });
  m.settings.update({ notetaker: { systemAudio: systemBefore } });
}
