// Smoke checks for Stage 6A in the real app: totals (wpm, streak) on Dictation, sort menus,
// launch at login (development build), the Dock preference, feedback sounds through the real
// Capsule window, last-transcript actions (fake inserter: nothing is pasted for real), and
// reset through the UI. Runs inside `npm run smoke`, last, because it resets the profile.
import { app, type BrowserWindow } from "electron";
import type { MurmurApp } from "./app.ts";
import type { InsertOutcome, TargetSnapshot } from "./core/types.ts";
import { apiKeySecret } from "./settings/store.ts";
import { uiDriver } from "./ui-driver.ts";

type Check = (name: string, ok: boolean, details?: unknown) => void;

export async function runSystemChecks(
  m: MurmurApp,
  win: BrowserWindow,
  inserter: {
    calls: { text: string; target: TargetSnapshot }[];
    outcome: InsertOutcome;
  },
  provider: { text: string },
  check: Check,
): Promise<void> {
  const d = uiDriver(win);
  const { sleep, waitFor, key, click, clickText } = d;
  // Names the script in the error, so a failure says which step broke.
  const js = <T>(code: string): Promise<T> =>
    d.js<T>(code).catch((e: Error) => {
      throw new Error(`${e.message.split(".")[0]}: ${code.slice(0, 140)}`);
    });
  const s = () => m.settings.get();
  const idle = async () => {
    for (let i = 0; i < 60 && m.controller.currentPhase !== "idle"; i++)
      await sleep(50);
  };
  const dictate = async (text: string) => {
    provider.text = text;
    m.controller.hotkey("down");
    await sleep(400);
    m.controller.hotkey("up");
    await idle();
    await sleep(200);
  };
  const capsule = m.capsule.win.webContents;
  const soundsPlayed = async () =>
    Number(
      await capsule.executeJavaScript(
        `document.documentElement.dataset.soundsPlayed ?? "0"`,
      ),
    );

  await d.emulateFocus(true);

  // ---- Totals: wpm and day streak come from History ------------------------------------------
  await dictate("um one two three four five six seven");
  m.hub!.show("home");
  await waitFor(`document.querySelector('aside[aria-label="Totals"] dl')`);
  await sleep(300);
  const stats = m.service.historyStats();
  const totals = (
    await js<string>(
      // Each value with its own label, from the list's dt/dd pairs ("178 total words").
      `[...document.querySelectorAll('aside[aria-label="Totals"] dl > div')].map((d) => d.querySelector("dd").textContent.trim() + " " + d.querySelector("dt").textContent.trim()).join(" · ")`,
    )
  ).replace(/\s+/g, " ");
  check(
    "dictation totals: words, wpm and day streak shown exactly as History computes them",
    stats.wpm !== null &&
      stats.streakDays >= 1 &&
      totals.includes(stats.words.toLocaleString()) &&
      totals.includes(`${stats.wpm.toLocaleString()} wpm`) &&
      totals.includes(`${stats.streakDays} day streak`),
    { stats, totals: totals.slice(0, 200) },
  );

  // ---- Sorting: Dictionary A to Z, remembered; History oldest first --------------------------
  // Added a moment apart, so “Newest first” has a real order to show.
  for (const phrase of ["Zulu", "alpha", "Mike"]) {
    m.service.addDictionaryEntry({ phrase });
    await sleep(20);
  }
  m.hub!.show("dictionary");
  await waitFor(`document.querySelector('ul[aria-label="Dictionary words"]')`);
  const order = () =>
    js<string[]>(
      `[...document.querySelectorAll('ul[aria-label="Dictionary words"] li')].map((li) => li.querySelector(".truncate").textContent.trim())`,
    );
  const sortTo = async (labelStart: string, item: string) => {
    // Radix menus open on pointer-down, as with a mouse click.
    await js(
      `document.querySelector('button[aria-label^="${labelStart}"]').dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }))`,
    );
    await waitFor(`document.querySelector('[role="menuitemradio"]')`);
    await js(
      `[...document.querySelectorAll('[role="menuitemradio"]')].find((x) => x.textContent.trim() === ${JSON.stringify(item)}).click()`,
    );
    await sleep(300);
  };
  await sortTo("Sort words", "A to Z");
  const az = await order();
  const reloaded = new Promise<void>((r) =>
    win.webContents.once("did-finish-load", () => r()),
  );
  win.webContents.reload();
  await reloaded;
  // A reload returns to the window's launch route; once the app is listening again, go back
  // to the Dictionary.
  await waitFor(`document.querySelector('nav[aria-label="Main"]')`, 5000);
  await sleep(300);
  m.hub!.show("dictionary");
  await waitFor(`document.querySelector('ul[aria-label="Dictionary words"]')`);
  await sleep(300);
  const afterReload = await order();
  await sortTo("Sort words", "Newest first");
  const newest = await order();
  const collator = new Intl.Collator(undefined, {
    sensitivity: "base",
    numeric: true,
  });
  const ours = az.filter((p) => ["alpha", "Mike", "Zulu"].includes(p));
  check(
    "sort: Dictionary A to Z (case-insensitive), kept after reload; Newest first restores order",
    JSON.stringify(az) === JSON.stringify([...az].sort(collator.compare)) &&
      JSON.stringify(ours) === JSON.stringify(["alpha", "Mike", "Zulu"]) &&
      JSON.stringify(afterReload) === JSON.stringify(az) &&
      newest[0] === "Mike",
    { az, afterReload, newest },
  );
  m.hub!.show("home");
  await waitFor(`document.querySelector("[data-row-button]")`);
  await sortTo("Sort dictations", "Oldest first");
  const firstId = await js<string>(
    `document.querySelector('li[id^="dictation-"]').id`,
  );
  const oldest = m.service
    .listHistory({ limit: 100000 })
    .reduce((a, b) => (b.startedAt < a.startedAt ? b : a));
  await sortTo("Sort dictations", "Newest first");
  check(
    "sort: Dictation history oldest first comes from SQLite in that order",
    firstId === `dictation-${oldest.id}`,
    { firstId, oldest: oldest.id },
  );

  // ---- Launch at login: a development build can't register itself -----------------------------
  m.hub!.show("settings/system");
  await waitFor(`document.getElementById("launch-at-login")`);
  await sleep(400);
  const login = await js<{ disabled: boolean; text: string }>(
    `(() => { const sw = document.getElementById("launch-at-login"); return { disabled: sw.disabled, text: sw.closest("div.flex").parentElement.innerText }; })()`,
  );
  check(
    "launch at login: development build says so and offers no switch to flip (packaged app: manual)",
    !app.isPackaged
      ? login.disabled && login.text.includes("development build")
      : !login.disabled,
    login,
  );

  // ---- Dock: the switch saves; applying it hides and shows the real Dock icon -----------------
  await click("#show-in-dock");
  await sleep(300);
  const savedOn = s().system.showInDock;
  await m.applyDock();
  const shownOn = app.dock?.isVisible();
  await click("#show-in-dock");
  await sleep(300);
  await m.applyDock();
  await sleep(300);
  const hiddenOff = app.dock?.isVisible() === false;
  const hubStillThere = m.hub!.isVisible();
  void app.dock?.show(); // smoke and capture runs keep their Dock icon
  check(
    "dock: the setting is saved; off hides the Dock icon and the Murmur window stays open",
    savedOn === true &&
      shownOn === true &&
      hiddenOff &&
      hubStillThere &&
      s().system.showInDock === false,
    { savedOn, shownOn, hiddenOff, hubStillThere },
  );

  // ---- Sounds: off by default; on plays “stop” then “done” through the Capsule window ----------
  const before = await soundsPlayed();
  await dictate("sounds are off");
  const whileOff = await soundsPlayed();
  await click("#dictation-sounds");
  await sleep(300);
  await dictate("sounds are on");
  const whileOn = await soundsPlayed();
  const last = await capsule.executeJavaScript(
    `document.documentElement.dataset.lastSound`,
  );
  await click("#dictation-sounds");
  await sleep(300);
  check(
    "sounds: none while off; with the setting on a dictation plays two sounds, ending with “done”",
    whileOff === before &&
      whileOn === before + 2 &&
      last === "done" &&
      s().system.sounds === false,
    { before, whileOff, whileOn, last },
  );
  await key("Escape");

  // ---- Last transcript: copy and paste through the services (fake inserter) --------------------
  inserter.calls.length = 0;
  inserter.outcome = { strategy: "clipboard-paste" };
  const lastText = m.service.listHistory({ limit: 1 })[0].finalText;
  await m.pasteLastTranscript();
  await sleep(300);
  const pasted = inserter.calls.map((c) => c.text);
  const pastedState = await capsule.executeJavaScript(
    `document.getElementById("capsule").dataset.state`,
  );
  inserter.outcome = {
    strategy: "clipboard-only",
    reason: "no-post-event-permission",
  };
  await m.pasteLastTranscript();
  await sleep(300);
  const copiedText = await capsule.executeJavaScript(
    `document.querySelector("#capsule .label").textContent`,
  );
  inserter.outcome = { strategy: "clipboard-paste" };
  check(
    "last transcript: Paste sends the newest delivered text through the inserter; without the permission it says it copied",
    JSON.stringify(pasted) === JSON.stringify([lastText]) &&
      pastedState === "inserted" &&
      copiedText === "Paste is off — copied, press ⌘V",
    { pasted, pastedState, copiedText },
  );

  // ---- Reset, through the UI: confirmation required; data, keys and settings go ---------------
  await m.service.setSecret({
    provider: "groq",
    apiKey: "placeholder-not-a-key",
  });
  m.hub!.show("settings/system");
  await waitFor(`document.getElementById("launch-at-login")`);
  await clickText("Reset…");
  await waitFor(`document.querySelector('[role="alertdialog"]')`);
  const dialog = `document.querySelector('[role="alertdialog"]')`;
  const disabledFirst = await js<boolean>(
    `[...${dialog}.querySelectorAll("button")].find((b) => b.textContent.trim() === "Reset Murmur").disabled`,
  );
  await js(
    `[...${dialog}.querySelectorAll("label")].find((l) => l.textContent.startsWith("I understand")).click()`,
  );
  await sleep(200);
  await clickText("Reset Murmur", dialog);
  // Either the window reloads into setup, or (when another app holds the default shortcut,
  // e.g. the developer's own Murmur) the dialog says so and offers to continue.
  await waitFor(
    `Boolean(document.querySelector('nav[aria-label="Setup progress"]')) || [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Continue to setup")`,
    8000,
  );
  const keptShortcut = await js<boolean>(
    `[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Continue to setup")`,
  ).catch(() => false);
  if (keptShortcut) await clickText("Continue to setup");
  await waitFor(
    `document.querySelector('nav[aria-label="Setup progress"]')`,
    8000,
  );
  await sleep(500);
  const page = await js<string>("document.body.innerText");
  check(
    "reset: needs the confirmation tick; then History, keys and settings are gone, the library kept, and setup starts",
    disabledFirst &&
      m.history.count() === 0 &&
      !m.service.hasSecret("groq") &&
      !m.settings.hasSecret(apiKeySecret("openai")) &&
      s().onboardingCompleted === false &&
      s().appearance === "system" &&
      s().microphone.deviceId === null &&
      Object.values(m.hotkeys.actions).every((a) => a === null) &&
      m.service.listDictionary().length > 0 &&
      /get started/i.test(page),
    {
      disabledFirst,
      keptShortcut,
      history: m.history.count(),
      groq: m.service.hasSecret("groq"),
      onboarding: s().onboardingCompleted,
      appearance: s().appearance,
      actions: m.hotkeys.actions,
      library: m.service.listDictionary().length,
      hash: await js<string>("location.hash").catch(() => "?"),
      page: page.slice(0, 80),
    },
  );
  await d.emulateFocus(false);
}
