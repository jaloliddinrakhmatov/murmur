// Smoke checks for the Settings sheet in the real Hub window: every section, appearance, the
// shortcut recorder against real Carbon registration, API keys, switches, retention and the
// "a change never resets another setting" guarantee. Runs inside `npm run smoke`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { app, type BrowserWindow } from "electron";
import type { MurmurApp } from "./app.ts";
import type { Settings } from "../shared/settings.ts";
import { uiDriver } from "./ui-driver.ts";
import { microphoneSummary } from "../renderer/hub/model/microphone.ts";

type Check = (name: string, ok: boolean, details?: unknown) => void;

// Stage 5 sections (reference grouping): the shortcut, microphone and language live in General.
const SECTIONS = [
  ["General", "Dictation language"],
  ["System", "Show the Murmur bar at all times"],
  ["Notetaker", "Keep meetings for"],
  ["Transcription", "Transcription service"],
  ["AI cleanup", "Mode"],
  ["Dictionary & snippets", "Use your dictionary"],
  ["Data and Privacy", "Keep History on this Mac"],
  ["About", "Data folder"],
] as const;

export async function runSettingsChecks(
  m: MurmurApp,
  win: BrowserWindow,
  check: Check,
): Promise<void> {
  const d = uiDriver(win);
  const { js, sleep, waitFor, key, click, clickText, active } = d;
  const wc = win.webContents;
  const pane = `document.querySelector('section[aria-labelledby="settings-section-title"]')`;
  const paneText = () => js<string>(`${pane}?.innerText ?? ""`);
  /**
   * Opens a section and waits until it really shows: its title, and its own content (the
   * marker), not a fixed pause. Stage 7: a missed navigation is reported where it happens,
   * instead of being read later as the previous section's content.
   */
  const navigations: { label: string; ms: number; ok: boolean }[] = [];
  const openSection = async (label: string) => {
    const marker = SECTIONS.find(([t]) => t === label)?.[1];
    const t0 = Date.now();
    const clicked = await js<boolean>(
      `(() => { const b = [...document.querySelectorAll('nav[aria-label="Settings sections"] button')].find((b) => b.title === ${JSON.stringify(label)}); b?.click(); return Boolean(b); })()`,
    );
    const ok =
      clicked &&
      (await waitFor(
        `document.getElementById("settings-section-title")?.textContent === ${JSON.stringify(label)}` +
          (marker
            ? ` && document.querySelector('section[aria-labelledby="settings-section-title"]')?.innerText.includes(${JSON.stringify(marker)})`
            : ""),
      ));
    navigations.push({ label, ms: Date.now() - t0, ok });
    if (!ok)
      console.log(
        `smoke: Settings section “${label}” didn't open (${clicked ? "title or content never appeared" : "nav button missing"}); shown: ${await js<string>(`document.getElementById("settings-section-title")?.textContent ?? "no Settings"`)}`,
      );
    return ok;
  };
  const choose = (id: string, value: string) =>
    js(
      `(() => { const s = document.getElementById(${JSON.stringify(id)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event("change", { bubbles: true })); })()`,
    );
  const s = () => m.settings.get();
  const same = (a: Settings, b: Settings, except: string[]) => {
    const strip = (x: Settings) => {
      const c = structuredClone(x) as unknown as Record<
        string,
        Record<string, unknown>
      >;
      for (const p of except) {
        const [k, sub] = p.split(".");
        if (sub) delete c[k][sub];
        else delete c[k];
      }
      return JSON.stringify(c);
    };
    return strip(a) === strip(b);
  };

  await d.emulateFocus(true);
  m.hub!.show("settings/general");
  await waitFor(`document.getElementById("settings-section-title")`);

  // Every section renders its own controls, with its title once (no old card headings).
  const sections: Record<string, boolean> = {};
  const failedText: Record<string, string> = {};
  for (const [title, marker] of SECTIONS) {
    await openSection(title);
    const text = await paneText();
    const headings = await js<number>(
      `[...${pane}.querySelectorAll("h2, h3")].filter((h) => h.textContent === ${JSON.stringify(title)}).length`,
    );
    sections[title] = text.includes(marker) && headings === 1;
    if (!sections[title])
      failedText[title] =
        `${headings} headings · ${text.slice(0, 160)} · dialogs ${await js<number>(`document.querySelectorAll('[role="dialog"]').length`)}`;
  }
  // Stage 7: navigation stress — 3 more rounds through every section, each switch timed.
  const stressFrom = navigations.length;
  for (let round = 0; round < 3; round++)
    for (const [title] of SECTIONS) await openSection(title);
  const stress = navigations.slice(stressFrom);
  const times = stress.map((n) => n.ms).sort((a, b) => a - b);
  check(
    "settings navigation: 21 more section switches all land on the right section with its content",
    stress.every((n) => n.ok),
    {
      failed: stress.filter((n) => !n.ok).map((n) => n.label),
      p50Ms: times[Math.floor(times.length / 2)],
      maxMs: times.at(-1),
    },
  );
  check(
    "settings: all seven sections render their controls, each titled once",
    Object.values(sections).every(Boolean),
    { sections, failedText },
  );

  // Appearance applies at once and touches nothing else.
  await openSection("General");
  let before = s();
  await click(
    '[role="radiogroup"][aria-label="Appearance"] [role="radio"]:nth-child(3)',
  );
  await waitFor(`matchMedia("(prefers-color-scheme: dark)").matches`);
  const dark = await js<boolean>(
    `matchMedia("(prefers-color-scheme: dark)").matches`,
  );
  check(
    "settings appearance: Dark applies immediately, is saved, resets nothing else",
    dark && s().appearance === "dark" && same(before, s(), ["appearance"]),
  );
  await click(
    '[role="radiogroup"][aria-label="Appearance"] [role="radio"]:nth-child(1)',
  );
  await sleep(300);

  // Shortcut recorder (General → Shortcuts → Change), with real Carbon registration.
  await openSection("General");
  await click("#shortcuts-change");
  await waitFor(`document.querySelector('[role="dialog"] #shortcut-recorder')`);
  const shortcutsDialog = `[...document.querySelectorAll('[role="dialog"]')].find((d) => d.querySelector("#shortcut-recorder"))`;
  const dialogText = () => js<string>(`${shortcutsDialog}?.innerText ?? ""`);
  before = s();
  const recorder = "#shortcut-recorder";
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
    await sleep(600);
  };
  await click(recorder);
  await press("F11", ["control", "alt"]);
  await waitFor(`!document.querySelector("[data-shortcut-recording]")`);
  check(
    "shortcut recorder: a new combination is registered, then saved; nothing else changes",
    s().shortcut === "ctrl+opt+f11" &&
      m.hotkeys.current.registered &&
      m.hotkeys.current.combo.toLowerCase() === "ctrl+opt+f11" &&
      (await dialogText()).includes("Saved.") &&
      same(before, s(), ["shortcut"]),
    { shortcut: s().shortcut, hotkey: m.hotkeys.current },
  );

  // Another app holds a combination: the change is refused and F11 keeps working.
  const taken = ["ctrl+opt+f9", "ctrl+opt+f8", "ctrl+opt+f10"].find(
    (c) => m.native.registerHotkey(99, c, { exclusive: true }, () => {}).ok,
  );
  if (taken) {
    await click(recorder);
    await press(taken.split("+")[2].toUpperCase(), ["control", "alt"]);
    await waitFor(`${shortcutsDialog}.innerText.includes("already used")`);
    const msg = await dialogText();
    m.native.unregisterHotkey(99);
    await key("Escape");
    check(
      "shortcut recorder: a taken combination is refused; the current shortcut stays registered",
      msg.includes("already used by another app") &&
        msg.includes("Your shortcut is unchanged") &&
        s().shortcut === "ctrl+opt+f11" &&
        m.hotkeys.current.registered &&
        m.hotkeys.current.combo.toLowerCase() === "ctrl+opt+f11",
      { hotkey: m.hotkeys.current },
    );
  } else check("shortcut recorder: conflict case", false, "no free test combo");

  await click(recorder);
  await press("K", []);
  const invalid = await dialogText();
  await key("Escape");
  const stillOpen = await js<boolean>(
    `Boolean(document.getElementById("settings-section-title")) && Boolean(${shortcutsDialog})`,
  );
  const recording = await js<boolean>(
    `Boolean(document.querySelector("[data-shortcut-recording]"))`,
  );
  const focusAfter = await active();
  check(
    "shortcut recorder: a key without modifiers is explained; Esc cancels recording, not the dialog",
    invalid.includes("Add Control, Option or Command") &&
      stillOpen &&
      !recording &&
      s().shortcut === "ctrl+opt+f11" &&
      focusAfter.label === "Push to talk" &&
      focusAfter.tag === "BUTTON",
    { invalid: invalid.slice(0, 400), stillOpen, recording, focusAfter },
  );
  // Done closes the dialog and returns focus to its Change button.
  await clickText("Done", shortcutsDialog);
  await waitFor(`!(${shortcutsDialog})`);
  check(
    "shortcuts dialog: Done closes it and returns focus to General → Change",
    (await active()).text === "Change" &&
      (await js<string>(
        `document.getElementById("settings-section-title").textContent`,
      )) === "General",
  );
  m.service.updateSettings({ shortcut: "ctrl+opt+f12" });

  // API keys: saved encrypted, never shown again, removable.
  await openSection("Transcription");
  const fake = "sk-smoke-not-a-real-key-0123456789";
  await click("#speech-key");
  await d.type(fake);
  await key("Return");
  await waitFor(`document.body.innerText.includes("API key saved")`);
  const keyShown = (await js<string>("document.body.innerText")).includes(fake);
  const field = await js<string>(`document.getElementById("speech-key").value`);
  const stored = m.service.hasSecret(s().speech.provider);
  const onDisk = readFileSync(
    join(app.getPath("userData"), "settings.json"),
    "utf8",
  );
  await clickText("Remove", pane);
  await waitFor(`document.querySelector('[role="alertdialog"]')`);
  await clickText("Remove", `document.querySelector('[role="alertdialog"]')`);
  await waitFor(`!document.querySelector('[role="alertdialog"]')`);
  await sleep(300);
  check(
    "transcription API key: saved encrypted, cleared from the field, never displayed, removable",
    stored &&
      !keyShown &&
      field === "" &&
      !onDisk.includes(fake) &&
      !m.service.hasSecret(s().speech.provider),
  );

  before = s();
  await choose("speech-provider", "groq");
  await sleep(400);
  const groq = s();
  await choose("speech-provider", before.speech.provider);
  await sleep(300);
  check(
    "transcription provider: switching it leaves dictionary and snippets settings alone",
    groq.speech.provider === "groq" &&
      same(before, groq, ["speech.provider"]) &&
      s().speech.provider === before.speech.provider,
  );

  // AI cleanup is never switched on by anything but the user, and shows what it sends.
  await openSection("AI cleanup");
  const defaultMode = s().cleanup.mode;
  await click(
    '[role="radiogroup"][aria-label="Cleanup mode"] [role="radio"]:nth-child(3)',
  );
  await waitFor(`${pane}.innerText.includes("quality check")`);
  const aiText = await paneText();
  await click(
    '[role="radiogroup"][aria-label="Cleanup mode"] [role="radio"]:nth-child(2)',
  );
  await sleep(300);
  check(
    "AI cleanup: Light by default; Medium (AI) shows the privacy warning and its own service settings",
    defaultMode === "deterministic" &&
      aiText.includes("sent to Groq") &&
      aiText.includes("AI service") &&
      s().cleanup.mode === "deterministic",
  );

  // Dictionary switch updates the Dictionary screen; its "Turn on" restores only that setting.
  await openSection("Dictionary & snippets");
  before = s();
  await click('button[role="switch"]#dictionary-enabled');
  await sleep(300);
  await clickText("Open Dictionary", pane);
  await waitFor(`document.body.innerText.includes("The dictionary is off")`);
  const sheetClosed = !(await js<boolean>(
    `Boolean(document.getElementById("settings-section-title"))`,
  ));
  await clickText("Turn on");
  await waitFor(`!document.body.innerText.includes("The dictionary is off")`);
  check(
    "dictionary switch: the Dictionary screen follows it; Turn on there restores it and nothing else",
    sheetClosed && s().dictionary.enabled === true && same(before, s(), []),
  );

  // History retention and the privacy summary.
  m.hub!.show("settings/privacy");
  await waitFor(
    `document.getElementById("settings-section-title")?.textContent === "Data and Privacy"`,
  );
  before = s();
  await choose("history-retention", "30");
  await sleep(300);
  const privacy = await paneText();
  check(
    "history retention: saved without touching other settings; privacy summary names the provider",
    s().history.historyRetentionDays === 30 &&
      same(before, s(), ["history.historyRetentionDays"]) &&
      privacy.includes("to be transcribed") &&
      privacy.includes("no cloud History"),
  );
  await choose(
    "history-retention",
    String(before.history.historyRetentionDays),
  );
  await sleep(200);

  await openSection("About");
  const about = await paneText();
  await openSection("General");
  await waitFor(`!${pane}.innerText.includes("Checking…")`);
  const mic = await paneText();
  const micState = m.service.permissions().microphone;
  const label = {
    granted: "Allowed",
    "not-determined": "Not asked yet",
    denied: "Blocked",
    restricted: "Restricted",
    unknown: "Unknown",
  }[micState];
  check(
    "about and microphone: real version and the permission macOS reports",
    about.includes(`Version ${app.getVersion()}`) &&
      mic.includes("Microphone") &&
      mic.includes(label) &&
      // Stage 6B: the row names the microphone dictation records from.
      (micState !== "granted" ||
        mic.includes(microphoneSummary(await m.microphones.list()))),
    { micState },
  );

  // Language dialog: one choice, saved on “Save and close”; Esc discards; auto-detect.
  const langDialog = `[...document.querySelectorAll('[role="dialog"]')].find((d) => d.querySelector('[aria-label="Language"]'))`;
  const openLanguage = async () => {
    await click("#speech-language");
    await waitFor(`${langDialog}`);
  };
  const tile = (name: string) =>
    js(
      `[...${langDialog}.querySelectorAll('[role="radio"]')].find((t) => t.querySelector("span").textContent === ${JSON.stringify(name)}).click()`,
    );
  before = s();
  await openLanguage();
  await tile("French");
  await key("Escape");
  await waitFor(`!(${langDialog})`);
  const afterEsc = s().speech.language;
  await openLanguage();
  await d.js(
    `${langDialog}.querySelector('input[aria-label="Search languages"]').focus()`,
  );
  await d.type("uzb");
  const filtered = await js<number>(
    `${langDialog}.querySelectorAll('[role="radio"]').length`,
  );
  await tile("Uzbek");
  await clickText("Save and close", langDialog);
  await waitFor(`!(${langDialog})`);
  const saved = s().speech.language;
  const row = await paneText();
  await openLanguage();
  await click(`[role="switch"][aria-label="Detect automatically"]`);
  await clickText("Save and close", langDialog);
  await waitFor(`!(${langDialog})`);
  check(
    "language dialog: Esc discards; search filters; Save stores one language; auto-detect clears it; nothing else changes",
    afterEsc === before.speech.language &&
      filtered === 1 &&
      saved === "uz" &&
      row.includes("Uzbek") &&
      s().speech.language === "" &&
      same(before, s(), ["speech.language"]),
    { afterEsc, filtered, saved, final: s().speech.language },
  );
  m.hub!.show("settings/language");
  const deepLink = await waitFor(`${langDialog}`);
  await key("Escape");
  await waitFor(`!(${langDialog})`);
  check("settings/language deep link opens the language dialog", deepLink);

  // System: the Murmur bar switch is the real Capsule visibility setting.
  await openSection("System");
  before = s();
  await click("#capsule-visibility");
  await sleep(300);
  const off = s().capsule;
  await click("#capsule-visibility");
  await sleep(300);
  check(
    "system: “Show the Murmur bar at all times” switches the Capsule setting and nothing else",
    off === "whileActive" && s().capsule === "always" && same(before, s(), []),
    { off, now: s().capsule },
  );

  // AI cleanup in Settings and the Style page are one setting.
  await openSection("AI cleanup");
  await click(
    '[role="radiogroup"][aria-label="Cleanup mode"] [role="radio"]:nth-child(1)',
  );
  await sleep(300);
  m.hub!.show("style");
  await waitFor(`document.querySelector('[aria-label="Cleanup level"]')`);
  const styleShows = await js<string>(
    `document.querySelector('[aria-label="Cleanup level"] [aria-checked="true"] span').textContent`,
  );
  m.service.updateSettings({ cleanup: { mode: "deterministic" } });
  check(
    "cleanup: None chosen in Settings is the level the Style page shows",
    styleShows === "None",
    styleShows,
  );

  // Data and Privacy: Delete all History removes rows and their encrypted recordings.
  m.history.insert({
    id: "privacy-del",
    startedAt: Date.now(),
    durationMs: 1000,
    status: "failed",
    strategy: null,
    rawText: null,
    finalText: null,
    wordCount: 0,
    appName: null,
    appBundleId: null,
    error: "HTTP 503",
    provider: "openai",
    hasAudio: true,
  });
  await m.vault.save("privacy-del", new Uint8Array([1, 2, 3, 4]));
  m.service.notifyHistory();
  m.hub!.show("settings/privacy");
  await waitFor(
    `document.getElementById("settings-section-title")?.textContent === "Data and Privacy"`,
  );
  await waitFor(`${pane}.innerText.includes("1 dictation")`);
  await clickText("Delete…", pane);
  await waitFor(`document.querySelector('[role="alertdialog"]')`);
  await clickText(
    "Delete all",
    `document.querySelector('[role="alertdialog"]')`,
  );
  await waitFor(`!document.querySelector('[role="alertdialog"]')`);
  await sleep(300);
  check(
    "data and privacy: Delete all History, confirmed, removes the rows and the encrypted recordings",
    m.history.count() === 0 && (await m.vault.load("privacy-del")) === null,
  );
  await openSection("General");

  const disk = JSON.parse(
    readFileSync(join(app.getPath("userData"), "settings.json"), "utf8"),
  );
  check(
    "settings file on disk matches the settings in use",
    JSON.stringify(disk) === JSON.stringify(s()),
  );
  await key("Escape");
  await d.emulateFocus(false);
}
