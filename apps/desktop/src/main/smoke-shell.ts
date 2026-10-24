// Smoke checks for the reconstructed shell (redesign Stage 3) in the real Hub window:
// sidebar order and selection, ⌘1–⌘8, the setup card against live readiness, appearance from
// the title bar, and keyboard use of the shared controls (choice cards, underline tabs,
// switches). Runs inside `npm run smoke`.
import { nativeTheme, type BrowserWindow } from "electron";
import type { MurmurApp } from "./app.ts";
import { uiDriver } from "./ui-driver.ts";
import { setupChecklist } from "../renderer/hub/model/setup.ts";

type Check = (name: string, ok: boolean, details?: unknown) => void;

const NAV = 'nav[aria-label="Main"]';
const PAGES = [
  ["Dictation", /^Good (morning|afternoon|evening), hold/],
  ["Notetaker", /^Notetaker$/],
  ["Insights", /^Insights$/],
  ["Dictionary", /^Dictionary$/],
  ["Snippets", /^Snippets$/],
  ["Style", /^Style$/],
  ["Transforms", /^Transforms\s*Beta$/],
  ["Scratchpad", /^Scratchpad\s*Beta$/],
] as const;

export async function runShellChecks(
  m: MurmurApp,
  win: BrowserWindow,
  check: Check,
): Promise<void> {
  const d = uiDriver(win);
  const { js, sleep, waitFor, key, click } = d;
  const s = () => m.settings.get();
  const title = () =>
    js<string>(`document.querySelector("main#main h1")?.textContent ?? ""`);
  const selected = () =>
    js<string[]>(
      `[...document.querySelectorAll('${NAV} [aria-current="page"]')].map((b) => b.textContent.trim())`,
    );
  const clickNav = (label: string) =>
    js(
      `(() => { const b = [...document.querySelectorAll('${NAV} button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); b.focus(); b.click(); })()`,
    );
  const cardSteps = () =>
    js<{ label: string; done: boolean }[] | null>(
      `(() => { const c = document.querySelector('[data-setup-card="expanded"][data-setup-kind="murmur"]'); if (!c) return null; return [...c.querySelectorAll("li button")].map((b) => ({ label: b.textContent.replace(/ \\((not )?done\\)$/, ""), done: / \\(done\\)$/.test(b.textContent) })); })()`,
    );
  const closeSettings = async () => {
    await key("Escape");
    await waitFor(`!document.getElementById("settings-section-title")`);
  };

  await d.emulateFocus(true);
  m.hub!.show("home");
  await waitFor(`document.querySelector('${NAV}')`);
  await sleep(400);

  // ---- Sidebar: order, a single selected item, every destination renders --------------------
  const labels = await js<string[]>(
    `[...document.querySelectorAll('${NAV} > div:nth-of-type(2) > button')].map((b) => b.textContent.trim())`,
  );
  const footer = await js<string>(
    `[...document.querySelectorAll('${NAV} button')].at(-1).textContent.trim()`,
  );
  const visits: string[] = [];
  let navOk = true;
  for (const [label, heading] of PAGES) {
    await clickNav(label);
    await sleep(350);
    const [t, sel] = [await title(), await selected()];
    visits.push(`${label} → ${t} [${sel.join(",")}]`);
    navOk &&= heading.test(t) && sel.length === 1 && sel[0] === label;
  }
  check(
    "sidebar: reference order, Settings at the bottom; each item opens its page and is the only one selected",
    JSON.stringify(labels) === JSON.stringify(PAGES.map(([l]) => l)) &&
      footer === "Settings" &&
      navOk,
    { labels, footer, visits },
  );

  // ---- ⌘1–⌘7 keep their pages (Stage 9D-1: Notetaker is second in the list but takes ⌘8) ----
  const KEYS = [
    "Dictation",
    "Insights",
    "Dictionary",
    "Snippets",
    "Style",
    "Transforms",
    "Scratchpad",
    "Notetaker",
  ];
  const byKey: string[] = [];
  for (let i = 1; i <= KEYS.length; i++) {
    await key(String(i), ["meta"]);
    await sleep(300);
    byKey.push((await selected())[0] ?? "");
  }
  check(
    "keyboard: ⌘1–⌘7 still select Dictation, Insights, Dictionary, Snippets, Style, Transforms, Scratchpad; ⌘8 selects Notetaker",
    JSON.stringify(byKey) === JSON.stringify(KEYS),
    byKey,
  );

  // ---- Setup card: real readiness, navigation, disappears and comes back ---------------------
  const status = await m.service.getStatus();
  const expected = setupChecklist(status);
  const steps = await cardSteps();
  const shownMatches = expected.complete
    ? steps === null
    : JSON.stringify(steps) ===
      JSON.stringify(
        expected.steps.map((x) => ({ label: x.label, done: x.done })),
      );
  let opened = "";
  if (steps) {
    await js(
      `[...document.querySelectorAll('[data-setup-card="expanded"][data-setup-kind="murmur"] li button')].find((b) => b.textContent.startsWith("Transcription service")).click()`,
    );
    await waitFor(`document.getElementById("settings-section-title")`);
    opened = await js<string>(
      `document.getElementById("settings-section-title").textContent`,
    );
    await closeSettings();
  }
  check(
    "setup card: shows exactly the live readiness checks; a step opens the Settings section that fixes it",
    shownMatches && (expected.complete || opened === "Transcription"),
    { expected: expected.steps, shown: steps, opened },
  );

  // Make transcription ready with a placeholder key (never sent anywhere), then remove it.
  const provider = s().speech.provider;
  const hadKey = m.service.hasSecret(provider);
  await m.service.setSecret({ provider, apiKey: "placeholder-not-a-real-key" });
  await sleep(2500);
  const afterKey = setupChecklist(await m.service.getStatus());
  const stepsWithKey = await cardSteps();
  await m.service.setSecret({ provider, apiKey: "" });
  await sleep(2500);
  const stepsWithout = await cardSteps();
  const transcriptionWithKey = stepsWithKey?.find(
    (x) => x.label === "Transcription service",
  );
  check(
    "setup card: hides only when every check passes and returns when one stops passing",
    (afterKey.complete
      ? stepsWithKey === null
      : transcriptionWithKey?.done === true) &&
      stepsWithout?.some(
        (x) => x.label === "Transcription service" && !x.done,
      ) === true &&
      !m.service.hasSecret(provider) &&
      !hadKey,
    { afterKey: afterKey.complete, stepsWithKey, stepsWithout },
  );

  // ---- Appearance from the title bar ----------------------------------------------------------
  // Radix menus open on pointer-down or the keyboard, so open it the way a keyboard user does.
  const openAppearance = async () => {
    await js(
      `document.querySelector('header button[aria-label="Appearance"]').focus()`,
    );
    await key("Return");
    await waitFor(`document.querySelector('[role="menuitemradio"]')`);
  };
  const before = s().appearance;
  await openAppearance();
  await js(
    `[...document.querySelectorAll('[role="menuitemradio"]')].find((x) => x.textContent.trim() === "Dark").click()`,
  );
  await sleep(400);
  const dark = { setting: s().appearance, theme: nativeTheme.themeSource };
  await openAppearance();
  await js(
    `[...document.querySelectorAll('[role="menuitemradio"]')].find((x) => x.textContent.trim() === "Match macOS").click()`,
  );
  await sleep(400);
  check(
    "appearance from the title bar: Dark applies and is saved; Match macOS restores it",
    dark.setting === "dark" &&
      dark.theme === "dark" &&
      s().appearance === "system" &&
      nativeTheme.themeSource === "system",
    { before, dark, after: s().appearance },
  );

  // ---- Style: choice cards by keyboard, persisted, same setting as Settings → AI cleanup -----
  m.hub!.show("style");
  await waitFor(`document.querySelector('[aria-label="Cleanup level"]')`);
  await sleep(300);
  const levels = '[role="radiogroup"][aria-label="Cleanup level"]';
  const modeBefore = s().cleanup.mode;
  await click(`${levels} [aria-checked="true"]`);
  await key("Right");
  await sleep(400);
  const afterRight = s().cleanup.mode;
  await key("Left");
  await key("Left");
  await sleep(400);
  const afterLeft = s().cleanup.mode;
  const focusedName = await js<string>(
    `document.activeElement?.querySelector("span")?.textContent ?? ""`,
  );
  await click(`${levels} [role="radio"]:nth-child(2)`);
  await sleep(400);
  m.hub!.show("settings/ai");
  await waitFor(`document.getElementById("settings-section-title")`);
  await sleep(300);
  const settingsShows = await js<string>(
    `document.querySelector('[aria-label="Cleanup mode"] [aria-checked="true"]')?.textContent ?? ""`,
  );
  await closeSettings();
  check(
    "style: arrow keys move the level and save it (Medium, then None); Settings shows the same level",
    modeBefore === "deterministic" &&
      afterRight === "ai" &&
      afterLeft === "off" &&
      focusedName === "None" &&
      s().cleanup.mode === "deterministic" &&
      settingsShows === "Light",
    { modeBefore, afterRight, afterLeft, focusedName, settingsShows },
  );

  // ---- Underline tabs (History filter) and switches by keyboard -------------------------------
  // An earlier section empties History; the filter only shows when there is something to filter.
  const rows = ["inserted", "copied"] as const;
  rows.forEach((status, i) =>
    m.history.insert({
      id: `shell-${i}`,
      startedAt: Date.now() - i * 60_000,
      durationMs: 2000,
      status,
      strategy: status === "inserted" ? "clipboard-paste" : "clipboard-only",
      rawText: "shell check",
      finalText: "Shell check.",
      wordCount: 2,
      appName: "TextEdit",
      appBundleId: null,
      error: null,
      provider: "openai",
      hasAudio: false,
    }),
  );
  m.service.notifyHistory();
  m.hub!.show("history");
  await waitFor(`document.querySelector('[aria-label="Show"]')`);
  await sleep(300);
  const show = '[role="radiogroup"][aria-label="Show"]';
  const checkedTab = () =>
    js<string>(
      `document.querySelector('${show} [aria-checked="true"]').textContent`,
    );
  await click(`${show} [aria-checked="true"]`);
  await key("Right");
  await sleep(300);
  const tabRight = await checkedTab();
  await key("Left");
  await sleep(300);
  const tabBack = await checkedTab();
  check(
    "underline tabs: ← / → move the History filter and keep focus on the selected tab",
    tabRight === "Inserted" &&
      tabBack === "All" &&
      (await js<boolean>(
        `document.activeElement?.getAttribute("aria-checked") === "true"`,
      )),
    { tabRight, tabBack },
  );
  rows.forEach((_, i) => m.history.delete(`shell-${i}`));
  m.service.notifyHistory();

  const added = m.service.addDictionaryEntry({ phrase: "Shellcheck" });
  m.hub!.show("dictionary");
  await waitFor(`document.querySelector('[role="switch"]')`);
  await sleep(400);
  const entry = () => m.service.listDictionary().find((e) => e.id === added.id);
  const enabledBefore = entry()?.enabled;
  await js(
    `[...document.querySelectorAll('[role="switch"]')].find((x) => x.getAttribute("aria-label")?.includes("Shellcheck"))?.focus()`,
  );
  await key("Space");
  await sleep(300);
  const afterSpace = entry()?.enabled;
  await key("Space");
  await sleep(300);
  check(
    "switch: Space toggles a dictionary entry and Space again restores it (saved each time)",
    enabledBefore !== undefined &&
      afterSpace === !enabledBefore &&
      entry()?.enabled === enabledBefore,
    { enabledBefore, afterSpace, after: entry()?.enabled },
  );
  m.service.deleteDictionaryEntry({ id: added.id });

  await d.emulateFocus(false);
}
