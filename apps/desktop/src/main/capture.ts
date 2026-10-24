// Screenshot capture for design review and visual regression (`npm run capture`).
// Boots the real app against a throwaway data directory seeded with sample entries (clearly not
// the user's data), renders each Hub page in light and dark mode with webContents.capturePage
// (no Screen Recording permission needed), and writes PNGs. capturePage omits native window
// chrome, so one extra shot per theme uses `screencapture -l` on the real window; that one needs
// Screen Recording permission for the terminal and is skipped with a note when it is missing.
// Windows are shown inactive so the developer's frontmost app keeps focus.
import { app, ipcMain, nativeTheme } from "electron";
import { execFile, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testKeychain } from "./settings/secure-storage.ts";
import { createApp, type MurmurApp } from "./app.ts";
import { FakeMurmurServer } from "./account/fake-server.ts";
import { captureAccountScreens } from "./capture-account.ts";
import { uiDriver } from "./ui-driver.ts";
import type { PaintTiming } from "./windows/capsule.ts";
import { LONG_TRANSCRIPT } from "./smoke-history.ts";
import { encodeWav } from "@murmur/speech";

const execFileAsync = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function seed(m: MurmurApp): void {
  m.settings.update({ onboardingCompleted: true });
  for (const [phrase, misheardAs] of [
    ["Samsara", null],
    ["Macropoint", "macro point"],
    ["ELD", "yield"],
    ["Bill of Lading", null],
    ["NestJS", "nest js"],
    ["PostgreSQL", "postgres sequel"],
  ] as const) {
    m.service.addDictionaryEntry({ phrase, misheardAs });
  }
  m.service.addSnippet({ trigger: "my email", replacement: "you@example.com" });
  m.service.addSnippet({
    trigger: "office address",
    replacement: "12 Example Street, Tashkent",
  });
  const now = Date.now();
  const rows = [
    {
      offset: 5 * 60_000,
      status: "inserted",
      raw: "um so the yield report is ready comma can you check it",
      final: "So the ELD report is ready, can you check it?",
    },
    {
      offset: 50 * 60_000,
      status: "copied",
      raw: "send the bill of lading to my email",
      final: "Send the Bill of Lading to you@example.com.",
    },
    { offset: 26 * 3600_000, status: "failed", raw: null, final: null },
    {
      offset: 27 * 3600_000,
      status: "inserted",
      raw: "deploy nest js tonight not tomorrow",
      final: "Deploy NestJS tonight, not tomorrow.",
    },
  ] as const;
  rows.forEach((r, i) =>
    m.history.insert({
      id: `sample-${i}`,
      startedAt: now - r.offset,
      durationMs: 4200 + i * 1300,
      status: r.status,
      strategy:
        r.status === "inserted"
          ? "clipboard-paste"
          : r.status === "copied"
            ? "clipboard-only"
            : null,
      rawText: r.raw,
      finalText: r.final,
      wordCount: r.final ? r.final.split(/\s+/).length : 0,
      appName: "TextEdit",
      appBundleId: "com.apple.TextEdit",
      error: r.status === "failed" ? "HTTP 503" : null,
      provider: "groq",
      hasAudio: r.status === "failed",
      cleanupUsed: r.final ? "deterministic" : null,
    }),
  );
}

/** Original sample text for the note window screenshots (no reference content). */
const SAMPLE_NOTE =
  "Trip checklist\nBook the early train on Friday and ask Dana about the late check-in.\n\n- Charger and adapter\n- Print the tickets\n- Water the plants before leaving";

/** The Transform panel with an original sample result (no AI request). */
async function showTransformPanel(
  m: MurmurApp,
): Promise<Electron.BrowserWindow> {
  m.transformPanel!.show({
    kind: "review",
    name: "Polish",
    before:
      "ok so for the offsite i booked the room for thursday but the caterer cant do lunch before one",
    after:
      "I booked the room for the offsite on Thursday. The caterer can't do lunch before one.",
    canReplace: true,
    appName: "TextEdit",
  });
  await sleep(700);
  return m.transformPanel!.window!;
}

/** Opens the note window without activating Murmur and waits for its editor. */
async function showNoteWindow(m: MurmurApp): Promise<Electron.BrowserWindow> {
  const win = m.notes!.show({ resume: true }, { inactive: true });
  win.setSize(500, 420);
  for (let i = 0; i < 80; i++) {
    const ready = await win.webContents
      .executeJavaScript(
        `Boolean(document.getElementById("note-editor")?.value.length)`,
      )
      .catch(() => false);
    if (ready) break;
    await sleep(100);
  }
  await sleep(500);
  return win;
}

export async function runCapture(outDir: string): Promise<number> {
  mkdirSync(outDir, { recursive: true });
  const scenes = (
    process.env.MURMUR_CAPTURE_SCENES ?? "home,library,history,settings"
  )
    .split(",")
    .map((x) => x.trim());
  // Account screens run the real AccountService against an in-memory server (no network).
  const accountServer = new FakeMurmurServer();
  const m = await createApp({
    env: { shortcut: "ctrl+opt+f12" },
    keychain: testKeychain(),
    accountFetch: accountServer.fetch,
  });
  // Before anything else touches the capsule, so the first measurement is a real cold one.
  if (scenes.includes("timing")) await measureCapsule(m, outDir);
  seed(m);
  const written: string[] = [];
  const shoot = async (
    name: string,
    target: Electron.BrowserWindow | Electron.WebContents,
  ) => {
    const wc = "webContents" in target ? target.webContents : target;
    await sleep(450);
    const image = await wc.capturePage();
    const file = join(outDir, `${name}.png`);
    writeFileSync(file, image.toPNG());
    written.push(file);
  };
  const shootChrome = (name: string, win: Electron.BrowserWindow) => {
    const windowId = win.getMediaSourceId().split(":")[1];
    const file = join(outDir, `${name}.png`);
    try {
      execFileSync("screencapture", ["-x", "-o", "-l", windowId, file]);
      written.push(file);
    } catch (e) {
      console.log(`skipped ${name}: ${(e as Error).message.split("\n")[0]}`);
    }
  };
  // Native traffic lights vs. the title-bar controls, measured rather than eyeballed: button
  // frames come from the Accessibility API (scripts/window-buttons.js, run with JXA), control frames from
  // the DOM. Needs Accessibility permission for the terminal; skipped with a note without it.
  const measureChrome = async (name: string, win: Electron.BrowserWindow) => {
    try {
      // Async on purpose: Murmur's main thread must stay free to answer the AX query.
      const { stdout } = await execFileAsync(
        "osascript",
        [
          "-l",
          "JavaScript",
          join(app.getAppPath(), "scripts/window-buttons.js"),
          String(process.pid),
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      type Frame = { x: number; y: number; width: number; height: number };
      const bounds = win.getBounds();
      const buttons = (
        JSON.parse(stdout) as Record<
          "window" | "close" | "minimize" | "zoom",
          Frame
        >[]
      ).find(
        // Size only: right after a resize the AX position can lag behind the window's.
        (w) =>
          Math.abs(w.window.width - bounds.width) < 2 &&
          Math.abs(w.window.height - bounds.height) < 2,
      );
      if (!buttons?.close) throw new Error("Hub window not found via AX");
      const content = win.getContentBounds();
      const toggle = (await win.webContents.executeJavaScript(
        `(() => { const r = document.querySelector('[aria-label^="Hide sidebar"], [aria-label^="Show sidebar"]').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
      )) as { x: number; y: number; width: number; height: number };
      const toggleScreen = {
        ...toggle,
        x: content.x + toggle.x,
        y: content.y + toggle.y,
      };
      const lights = [buttons.close, buttons.minimize, buttons.zoom];
      const lightsRight = Math.max(...lights.map((b) => b.x + b.width));
      const lightsCenterY = lights[0].y + lights[0].height / 2;
      const report = {
        windowSize: win.getSize(),
        trafficLights: buttons,
        sidebarToggle: toggleScreen,
        horizontalGap: Math.round((toggleScreen.x - lightsRight) * 10) / 10,
        verticalCenterOffset:
          Math.round(
            (toggleScreen.y + toggleScreen.height / 2 - lightsCenterY) * 10,
          ) / 10,
        overlaps: toggleScreen.x < lightsRight,
      };
      const file = join(outDir, `${name}.json`);
      writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
      written.push(file);
    } catch (e) {
      const stderr = String((e as { stderr?: unknown }).stderr ?? "").trim();
      console.log(
        `skipped ${name}: ${stderr || (e as Error).message.split("\n")[0]}`,
      );
    }
  };
  const show = async (route: string, size: [number, number] = [1180, 780]) => {
    const win = m.hub!.show(route, { inactive: true });
    win.setSize(size[0], size[1]);
    // Polled, not an event: right after a reload the page can still report loading after
    // did-finish-load has fired, and waiting for another one hung the run.
    for (
      const end = Date.now() + 10_000;
      win.webContents.isLoading() && Date.now() < end;
    )
      await sleep(50);
    await sleep(500);
    return win;
  };
  const setCollapsed = async (
    win: Electron.BrowserWindow,
    collapsed: boolean,
  ) => {
    await win.webContents.executeJavaScript(
      `localStorage.setItem("murmur.sidebar.collapsed", "${collapsed ? "1" : "0"}")`,
    );
    const loaded = new Promise<void>((r) =>
      win.webContents.once("did-finish-load", () => r()),
    );
    win.webContents.reload();
    await loaded;
    await sleep(600);
  };
  const js = (win: Electron.BrowserWindow, code: string) =>
    win.webContents.executeJavaScript(code);
  const populated = async (theme: "light" | "dark") => {
    nativeTheme.themeSource = theme;
    let win = await show("home");
    await setCollapsed(win, false);
    win = await show("home");
    await shoot(`home-${theme}`, win);
    await measureChrome(`window-chrome-${theme}`, win);
    shootChrome(`window-chrome-${theme}`, win);
    // Keyboard states. The window is shown inactive (the developer's app keeps focus), so the
    // page is told to behave as focused, and focus moves with a real Tab key so
    // :focus-visible and focus-opened tooltips behave as they do for a keyboard user.
    await uiDriver(win).emulateFocus(true);
    await js(win, `document.querySelector("[data-row-button]").focus()`);
    await shoot(`home-row-focus-${theme}`, win);
    await js(
      win,
      `document.querySelector('button[aria-label="How time saved is estimated"]').focus()`,
    );
    await sleep(700);
    await shoot(`home-estimate-tooltip-${theme}`, win);
    await js(win, `document.activeElement?.blur()`);
    await uiDriver(win).emulateFocus(false);
    // Old History links land on Dictation with that record highlighted.
    win = await show(`history/${m.service.listHistory({ limit: 1 })[0].id}`);
    await shoot(`history-deeplink-${theme}`, win);
    if (!m.scratchpad.list().length) m.scratchpad.create({ body: SAMPLE_NOTE });
    for (const route of [
      "insights",
      "dictionary",
      "snippets",
      "style",
      "transforms",
      "scratchpad",
      "notetaker",
    ]) {
      win = await show(route);
      await shoot(`${route}-${theme}`, win);
    }
    await shootNotetaker(m, show, shoot, theme);
    await shoot(`transform-panel-${theme}`, await showTransformPanel(m));
    m.transformPanel?.hide();
    win = await show("insights");
    await uiDriver(win).clickText("Your voice");
    await shoot(`insights-voice-${theme}`, win);
    await shoot(`note-window-${theme}`, await showNoteWindow(m));
    m.notes?.hide();
    for (const section of ["general", "transcription"]) {
      win = await show(`settings/${section}`);
      await shoot(`settings-${section}-${theme}`, win);
    }
    await setCollapsed(win, true);
    win = await show("home");
    await shoot(`home-collapsed-${theme}`, win);
    await setCollapsed(win, false);
    win = await show("home", [780, 560]);
    await shoot(`home-narrow-${theme}`, win);
    await measureChrome(`window-chrome-narrow-${theme}`, win);
    win.setSize(1180, 780);
  };
  const empty = async (theme: "light" | "dark") => {
    nativeTheme.themeSource = theme;
    for (const n of m.scratchpad.list())
      m.scratchpad.delete({ id: n.id, confirm: true });
    let win = await show("scratchpad");
    await shoot(`scratchpad-empty-${theme}`, win);
    win = await show("home");
    await shoot(`home-empty-${theme}`, win);
    win = await show("home", [780, 560]);
    await shoot(`home-empty-narrow-${theme}`, win);
    win.setSize(1180, 780);
  };
  if (scenes.includes("home")) {
    for (const theme of ["light", "dark"] as const) await populated(theme);
    // Sample data removed: Home must show its first-run state, not zeros.
    await m.service.clearHistory();
    for (const theme of ["light", "dark"] as const) await empty(theme);
    // Loading and error states: swap the stats handler in this throwaway session only.
    const reload = async (win: Electron.BrowserWindow) => {
      const loaded = new Promise<void>((r) =>
        win.webContents.once("did-finish-load", () => r()),
      );
      win.webContents.reload();
      await loaded;
    };
    for (const theme of ["light", "dark"] as const) {
      nativeTheme.themeSource = theme;
      const win = await show("home");
      ipcMain.removeHandler("hub:historyStats");
      ipcMain.handle("hub:historyStats", () => new Promise(() => {}));
      await reload(win);
      await shoot(`home-loading-${theme}`, win);
      ipcMain.removeHandler("hub:historyStats");
      ipcMain.handle("hub:historyStats", () => {
        throw new Error("database is locked (simulated for this screenshot)");
      });
      await reload(win);
      await shoot(`home-error-${theme}`, win);
    }
    // Later scenes (Settings over Home, the accessibility audit) need the real Home.
    ipcMain.removeHandler("hub:historyStats");
    ipcMain.handle("hub:historyStats", () => m.service.historyStats());
    await reload(await show("home"));
  }
  if (scenes.includes("history"))
    await captureHistory(m, show, shoot, setCollapsed);
  if (scenes.includes("account"))
    for (const theme of ["light", "dark"] as const) {
      nativeTheme.themeSource = theme;
      await captureAccountScreens(
        m,
        show,
        shoot,
        async () => {},
        theme,
        accountServer,
      );
    }
  if (scenes.includes("a11y"))
    await auditAccessibility(m, show, shoot, outDir, accountServer);
  if (scenes.includes("capsule")) await captureCapsule(m, outDir, written);
  if (scenes.includes("settings")) await captureSettings(m, show, shoot);
  if (scenes.includes("library"))
    await captureLibrary(m, show, shoot, setCollapsed);
  m.hub?.close();
  await m.dispose();
  console.log(`captured ${written.length} screenshots → ${outDir}`);
  return 0;
}

export function captureDir(): string | null {
  const arg = process.argv.find((a) => a.startsWith("--capture"));
  if (!arg) return null;
  const [, dir] = arg.split("=");
  return dir || join(app.getAppPath(), "results", "screens");
}

async function reloadPage(win: Electron.BrowserWindow): Promise<void> {
  const loaded = new Promise<void>((r) =>
    win.webContents.once("did-finish-load", () => r()),
  );
  win.webContents.reload();
  await loaded;
  await sleep(500);
}

type Show = (
  route: string,
  size?: [number, number],
) => Promise<Electron.BrowserWindow>;
type Shoot = (name: string, win: Electron.BrowserWindow) => Promise<void>;

/** Phase 4: Dictionary and Snippets, populated, searched, in dialogs, empty; both themes. */
async function captureLibrary(
  m: MurmurApp,
  show: Show,
  shoot: Shoot,
  setCollapsed: (
    win: Electron.BrowserWindow,
    collapsed: boolean,
  ) => Promise<void>,
): Promise<void> {
  // More sample library data (fictional): usage counts, a disabled word and snippet, and a
  // multi-line signature to show truncation.
  const find = (p: string) => m.service.findDictionaryPhrase(p)!;
  m.service.updateDictionaryEntry(
    { id: find("Bill of Lading").id },
    { enabled: false },
  );
  const signature = m.service.addSnippet({
    trigger: "my signature",
    replacement:
      "Best regards,\nAlex Example\nOperations lead · Example Logistics\n+1 555 0100",
  });
  const office = m.service
    .listSnippets()
    .find((x) => x.trigger === "office address")!;
  m.service.updateSnippet({ id: office.id }, { enabled: false });
  const email = m.service.listSnippets().find((x) => x.trigger === "my email")!;
  m.service.recordHits({
    dictionary: { [find("Macropoint").id]: 12, [find("ELD").id]: 4 },
    snippets: { [email.id]: 7, [signature.id]: 3 },
  });

  const blur = (win: Electron.BrowserWindow) =>
    win.webContents.executeJavaScript("document.activeElement?.blur()");
  for (const theme of ["light", "dark"] as const) {
    nativeTheme.themeSource = theme;
    let win = await show("dictionary");
    const d = uiDriver(win);
    await d.emulateFocus(true);
    await blur(win);
    await shoot(`dictionary-${theme}`, win);
    await d.click('[aria-label="Search dictionary"]');
    await d.waitFor(
      `document.querySelector('input[aria-label="Search dictionary"]')`,
    );
    await d.type("nest");
    await shoot(`dictionary-search-${theme}`, win);
    await d.key("Escape");
    await d.type("kubernetes");
    await shoot(`dictionary-no-results-${theme}`, win);
    await d.key("Escape");
    await d.clickText("Add word");
    await d.waitFor(`document.querySelector('[role="dialog"]')`);
    await shoot(`dictionary-add-${theme}`, win);
    await d.type("eld");
    await d.waitFor(
      `document.querySelector('[role="dialog"]').innerText.includes("already")`,
    );
    await shoot(`dictionary-add-duplicate-${theme}`, win);
    await d.key("Escape");
    await shoot(`dictionary-discard-${theme}`, win);
    await d.clickText("Discard");
    await d.click('button[aria-label="Edit Macropoint"]');
    await d.waitFor(`document.querySelector('[role="dialog"]')`);
    await shoot(`dictionary-edit-${theme}`, win);
    await d.key("Escape");
    await d.click('button[aria-label="Delete ELD"]');
    await d.waitFor(`document.querySelector('[role="alertdialog"]')`);
    await shoot(`dictionary-delete-${theme}`, win);
    await d.key("Escape");

    win = await show("snippets");
    await blur(win);
    await shoot(`snippets-${theme}`, win);
    await d.click('[aria-label="Search snippets"]');
    await d.waitFor(
      `document.querySelector('input[aria-label="Search snippets"]')`,
    );
    await d.type("regards");
    await shoot(`snippets-search-${theme}`, win);
    await d.key("Escape");
    await d.clickText("Create snippet");
    await d.waitFor(`document.querySelector('[role="dialog"]')`);
    await shoot(`snippets-create-${theme}`, win);
    await d.type("My Email");
    await d.key("Tab");
    await d.type("me@example.org");
    await d.waitFor(
      `document.querySelector('[role="dialog"]').innerText.includes("Another snippet")`,
    );
    await shoot(`snippets-create-conflict-${theme}`, win);
    await d.key("Escape");
    await d.clickText("Discard");
    await d.click('button[aria-label="Edit snippet my signature"]');
    await d.waitFor(`document.querySelector('[role="dialog"]')`);
    await d.js(`document.querySelectorAll('[role="dialog"] input')[1].focus()`);
    await d.type("thanks, my signature");
    await d.waitFor(
      `document.querySelector('[role="dialog"] p[data-selectable]')`,
    );
    await shoot(`snippets-edit-preview-${theme}`, win);
    await d.key("Escape");
    await d.click('button[aria-label="Delete snippet office address"]');
    await d.waitFor(`document.querySelector('[role="alertdialog"]')`);
    await shoot(`snippets-delete-${theme}`, win);
    await d.key("Escape");

    win = await show("dictionary", [780, 560]);
    await blur(win);
    await shoot(`dictionary-narrow-${theme}`, win);
    await d.clickText("Add word");
    await d.waitFor(`document.querySelector('[role="dialog"]')`);
    await shoot(`dictionary-add-narrow-${theme}`, win);
    await d.key("Escape");
    win = await show("snippets", [780, 560]);
    await blur(win);
    await shoot(`snippets-narrow-${theme}`, win);
    await d.click('button[aria-label="Edit snippet my signature"]');
    await d.waitFor(`document.querySelector('[role="dialog"]')`);
    await shoot(`snippets-edit-narrow-${theme}`, win);
    await d.key("Escape");
    win.setSize(1180, 780);

    await setCollapsed(win, true);
    win = await show("dictionary");
    await shoot(`dictionary-collapsed-${theme}`, win);
    win = await show("snippets");
    await shoot(`snippets-collapsed-${theme}`, win);
    await setCollapsed(win, false);
    await uiDriver(win).emulateFocus(false);
  }

  nativeTheme.themeSource = "light";
  // The renderer reads settings when it loads; reload to show the change. A settings change
  // re-applies the stored appearance, so set the capture theme again afterwards.
  m.settings.update({
    dictionary: { enabled: false },
    snippets: { enabled: false },
  });
  nativeTheme.themeSource = "light";
  let win = await show("dictionary");
  await reloadPage(win);
  await shoot("dictionary-off-light", win);
  win = await show("snippets");
  await shoot("snippets-off-light", win);
  m.settings.update({
    dictionary: { enabled: true },
    snippets: { enabled: true },
  });
  await reloadPage(win);

  // No sample data: the first-run states.
  for (const r of m.service.listDictionary())
    m.service.deleteDictionaryEntry({ id: r.id });
  for (const r of m.service.listSnippets())
    m.service.deleteSnippet({ id: r.id });
  for (const theme of ["light", "dark"] as const) {
    nativeTheme.themeSource = theme;
    win = await show("dictionary");
    await shoot(`dictionary-empty-${theme}`, win);
    win = await show("snippets");
    await shoot(`snippets-empty-${theme}`, win);
  }
  nativeTheme.themeSource = "light";
  win = await show("snippets", [780, 560]);
  await shoot("snippets-empty-narrow-light", win);
  win.setSize(1180, 780);
}

/** Phase 5: History list, search, filters, detail sheet, retry and delete; both themes. */
async function captureHistory(
  m: MurmurApp,
  show: Show,
  shoot: Shoot,
  setCollapsed: (
    win: Electron.BrowserWindow,
    collapsed: boolean,
  ) => Promise<void>,
): Promise<void> {
  // Fictional sample dictations over three days, covering every status the list shows.
  await m.service.clearHistory();
  const now = Date.now();
  const day = 86_400_000;
  const add = (
    id: string,
    ago: number,
    extra: Partial<Parameters<MurmurApp["history"]["insert"]>[0]>,
  ) =>
    m.history.insert({
      id,
      startedAt: now - ago,
      durationMs: 5200,
      status: "inserted",
      strategy: "clipboard-paste",
      rawText: null,
      finalText: null,
      wordCount: 0,
      appName: "TextEdit",
      appBundleId: null,
      error: null,
      provider: "openai",
      hasAudio: false,
      cleanupUsed: "deterministic",
      ...extra,
    });
  const words = (t: string) => t.split(/\s+/).length;
  const said = [
    [
      "s1",
      4 * 60_000,
      "Slack",
      "um so the ELD report is ready comma can you check it",
      "So the ELD report is ready, can you check it?",
    ],
    [
      "s2",
      38 * 60_000,
      "Mail",
      "please send the bill of lading to the dock team before noon",
      "Please send the Bill of Lading to the dock team before noon.",
    ],
    ["s3", 2 * 3_600_000, "Notes", LONG_TRANSCRIPT, LONG_TRANSCRIPT],
    [
      "s5",
      day + 3_600_000,
      "Linear",
      "deploy nest js tonight not tomorrow",
      "Deploy NestJS tonight, not tomorrow.",
    ],
    [
      "s7",
      2 * day + 2 * 3_600_000,
      "Slack",
      "meet at cafe muller at noon",
      "Meet at Café Müller at noon.",
    ],
  ] as const;
  for (const [id, ago, app, raw, final] of said)
    add(id, ago, {
      appName: app,
      rawText: raw,
      finalText: final,
      wordCount: words(final),
    });
  add("s4", 5 * 3_600_000, {
    status: "copied",
    strategy: "clipboard-only",
    error: "target-changed",
    appName: "Mail",
    rawText: "thanks for the update talk soon",
    finalText: "Thanks for the update, talk soon.",
    wordCount: 6,
  });
  add("s6", day + 5 * 3_600_000, {
    status: "failed",
    strategy: null,
    error: "HTTP 503 upstream connect error",
    appName: "Slack",
    hasAudio: true,
    cleanupUsed: null,
  });
  await m.vault.save("s6", encodeWav(new Int16Array(16000).fill(2000), 16000));
  add("s8", 2 * day + 4 * 3_600_000, {
    status: "failed",
    strategy: null,
    error: "timeout",
    appName: "Notes",
    hasAudio: false,
    cleanupUsed: null,
  });
  add("s9", 2 * day + 5 * 3_600_000, {
    status: "rejected",
    strategy: "rejected",
    error: "secure-field",
    appName: "1Password",
    rawText: "my password is not this",
    finalText: "My password is not this.",
    wordCount: 5,
  });

  const sheet = `document.querySelector('[role="dialog"]')`;
  for (const theme of ["light", "dark"] as const) {
    // The previous theme's retry changed this row's error; show the same failure in both.
    m.history.update("s6", {
      status: "failed",
      error: "HTTP 503 upstream connect error",
    });
    nativeTheme.themeSource = theme;
    let win = await show("history");
    const d = uiDriver(win);
    await d.emulateFocus(true);
    await win.webContents.executeJavaScript("document.activeElement?.blur()");
    await shoot(`history-${theme}`, win);
    // Hover/focus actions on a row.
    await d.js(
      `document.querySelector("#dictation-s2 [data-row-button]").focus()`,
    );
    await d.key("Tab");
    await d.key("Tab");
    await d.key("Return");
    await d.waitFor(`document.querySelector('[role="menu"]')`);
    await shoot(`history-row-menu-${theme}`, win);
    await d.key("Escape");
    await d.click('[aria-label="Search history"]');
    await d.waitFor(
      `document.querySelector('input[aria-label="Search history"]')`,
    );
    await d.type("café");
    await d.waitFor(`document.body.innerText.includes("1 of 9")`);
    await shoot(`history-search-${theme}`, win);
    await d.key("Escape");
    await d.type("kubernetes");
    await d.waitFor(`document.body.innerText.includes("Nothing matches")`);
    await shoot(`history-no-results-${theme}`, win);
    await d.key("Escape");
    await d.click(
      '[role="radiogroup"][aria-label="Show"] [role="radio"]:nth-child(4)',
    );
    await d.waitFor(`document.body.innerText.includes("3 of 9")`);
    await shoot(`history-filter-issues-${theme}`, win);
    await d.click(
      '[role="radiogroup"][aria-label="Show"] [role="radio"]:nth-child(1)',
    );
    await d.waitFor(`document.body.innerText.includes("9 dictations")`);

    await d.click("#dictation-s1 [data-row-button]");
    await d.waitFor(sheet);
    await d.clickText("Both", sheet);
    await shoot(`history-detail-${theme}`, win);
    await d.key("Escape");
    await d.click("#dictation-s3 [data-row-button]");
    await d.waitFor(sheet);
    await shoot(`history-detail-long-${theme}`, win);
    await d.key("Escape");
    await d.click("#dictation-s6 [data-row-button]");
    await d.waitFor(sheet);
    await shoot(`history-failed-${theme}`, win);
    // The capture profile has no transcription key, so a retry genuinely fails.
    await d.clickText("Retry transcription", sheet);
    await d.waitFor(`${sheet}.innerText.includes("Retry failed")`, 8000);
    await shoot(`history-retry-failed-${theme}`, win);
    await d.clickText("Delete…", sheet);
    await d.waitFor(`document.querySelector('[role="alertdialog"]')`);
    await shoot(`history-delete-${theme}`, win);
    await d.key("Escape");
    await d.key("Escape");
    await d.click("#dictation-s8 [data-row-button]");
    await d.waitFor(sheet);
    await shoot(`history-unrecoverable-${theme}`, win);
    await d.key("Escape");

    win = await show("history", [780, 560]);
    await win.webContents.executeJavaScript(
      'document.activeElement?.blur(); document.getElementById("main").scrollTop = 0',
    );
    await shoot(`history-narrow-${theme}`, win);
    await d.click("#dictation-s3 [data-row-button]");
    await d.waitFor(sheet);
    await shoot(`history-detail-narrow-${theme}`, win);
    await d.key("Escape");
    win.setSize(1180, 780);
    await setCollapsed(win, true);
    win = await show("history");
    await shoot(`history-collapsed-${theme}`, win);
    await setCollapsed(win, false);
    await uiDriver(win).emulateFocus(false);
  }

  nativeTheme.themeSource = "light";
  m.settings.update({ history: { enabled: false } });
  nativeTheme.themeSource = "light";
  let win = await show("history");
  await reloadPage(win);
  await shoot("history-off-light", win);
  m.settings.update({ history: { enabled: true } });
  nativeTheme.themeSource = "light";
  await reloadPage(win);

  await m.service.clearHistory();
  for (const theme of ["light", "dark"] as const) {
    nativeTheme.themeSource = theme;
    win = await show("history");
    await shoot(`history-empty-${theme}`, win);
  }
}

// Settings sections, plus the two row dialogs (their routes open General with the dialog).
const SETTINGS_IDS = [
  "general",
  "shortcuts",
  "microphone",
  "language",
  "system",
  "transcription",
  "ai",
  "library",
  "privacy",
  "about",
] as const;

/** Phase 6: every Settings section in both themes, narrow layouts and error states. */
async function captureSettings(
  m: MurmurApp,
  show: Show,
  shoot: Shoot,
): Promise<void> {
  // Sample state (fictional): some History, and one failed dictation by the selected provider.
  await m.service.clearHistory();
  const now = Date.now();
  for (const [id, ago, status, error] of [
    ["c1", 60_000, "failed", "HTTP 503 upstream connect error"],
    ["c2", 3_600_000, "inserted", null],
  ] as const)
    m.history.insert({
      id,
      startedAt: now - ago,
      durationMs: 4000,
      status,
      strategy: status === "inserted" ? "clipboard-paste" : null,
      rawText: status === "inserted" ? "hello there" : null,
      finalText: status === "inserted" ? "Hello there." : null,
      wordCount: status === "inserted" ? 2 : 0,
      appName: "Slack",
      appBundleId: null,
      error,
      provider: "openai",
      hasAudio: false,
    });

  for (const theme of ["light", "dark"] as const) {
    nativeTheme.themeSource = theme;
    // No API key yet: the real "not set up" state.
    m.service.setSecret({ provider: "openai", apiKey: "" });
    for (const id of SETTINGS_IDS) {
      const win = await show(`settings/${id}`);
      await win.webContents.executeJavaScript("document.activeElement?.blur()");
      await shoot(`settings-${id}-${theme}`, win);
    }
  }

  nativeTheme.themeSource = "light";
  let win = await show("settings/shortcuts");
  const d = uiDriver(win);
  await d.emulateFocus(true);
  // Recording, with modifiers held.
  await d.click("#shortcut-recorder");
  win.webContents.sendInputEvent({
    type: "keyDown",
    keyCode: "Control",
    modifiers: ["control", "alt"],
  });
  await sleep(400);
  await shoot("settings-shortcuts-recording-light", win);
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Control" });
  await d.key("Escape");
  // A combination another app holds (simulated with a second registration): refused, kept.
  const taken = ["ctrl+opt+f9", "ctrl+opt+f8", "ctrl+opt+f10"].find(
    (c) => m.native.registerHotkey(99, c, { exclusive: true }, () => {}).ok,
  );
  if (taken) {
    await d.click("#shortcut-recorder");
    const keyCode = taken.split("+")[2].toUpperCase();
    win.webContents.sendInputEvent({
      type: "keyDown",
      keyCode,
      modifiers: ["control", "alt"],
    });
    // Keys released, as a person would after pressing them.
    win.webContents.sendInputEvent({ type: "keyUp", keyCode });
    await d.waitFor(`document.body.innerText.includes("already used")`);
    await shoot("settings-shortcuts-conflict-light", win);
    m.native.unregisterHotkey(99);
    await d.key("Escape");
  }
  // Stage 6B: the optional shortcuts, one set (registered for real, cleared afterwards).
  await m.service.setActionShortcut({
    action: "pasteLast",
    shortcut: "ctrl+cmd+9",
  });
  await sleep(300);
  await d.js(
    `document.getElementById("shortcut-copyLast").closest("section").scrollIntoView({ block: "center" })`,
  );
  await sleep(300);
  await shoot("settings-shortcuts-actions-light", win);
  await m.service.setActionShortcut({ action: "pasteLast", shortcut: null });
  await d.emulateFocus(false);

  // A saved key (placeholder, throwaway profile): status comes from the last real dictation.
  m.service.setSecret({ provider: "openai", apiKey: "sk-capture-placeholder" });
  win = await show("settings/transcription");
  await sleep(600);
  await shoot("settings-transcription-failed-light", win);
  m.service.setSecret({ provider: "openai", apiKey: "" });

  // AI cleanup switched on, no key: its warning and "not set up" status.
  m.settings.update({ cleanup: { mode: "ai" } });
  nativeTheme.themeSource = "light";
  win = await show("settings/ai");
  await reloadPage(win);
  win = await show("settings/ai");
  await win.webContents.executeJavaScript(
    `document.querySelector('[aria-label="Settings"], #main')?.scrollTo?.(0, 0)`,
  );
  await shoot("settings-ai-on-light", win);
  nativeTheme.themeSource = "dark";
  await sleep(400);
  await shoot("settings-ai-on-dark", win);
  m.settings.update({ cleanup: { mode: "deterministic" } });
  nativeTheme.themeSource = "light";

  // Microphone blocked: simulated by answering the status request (macOS permission can't be
  // revoked from a test). Everything else on the screen is real.
  ipcMain.removeHandler("hub:getStatus");
  ipcMain.handle("hub:getStatus", async () => {
    const real = await m.service.getStatus();
    return {
      ...real,
      permissions: { ...real.permissions, microphone: "denied" as const },
    };
  });
  win = await show("settings/microphone");
  await reloadPage(win);
  win = await show("settings/microphone");
  await shoot("settings-microphone-denied-light", win);
  ipcMain.removeHandler("hub:getStatus");
  ipcMain.handle("hub:getStatus", () => m.service.getStatus());
  await reloadPage(win);

  win = await show("settings/privacy");
  await uiDriver(win).clickText("Delete…");
  await sleep(500);
  await shoot("settings-privacy-delete-light", win);
  await uiDriver(win).key("Escape");

  // Reset: the confirmation, before and after ticking “I understand” (nothing is reset here).
  win = await show("settings/system");
  await uiDriver(win).clickText("Reset…");
  await uiDriver(win).waitFor(`document.querySelector('[role="alertdialog"]')`);
  await sleep(300);
  await shoot("settings-system-reset-light", win);
  await uiDriver(win).key("Escape");

  for (const theme of ["light", "dark"] as const) {
    nativeTheme.themeSource = theme;
    for (const id of [
      "general",
      "shortcuts",
      "language",
      "transcription",
      "privacy",
    ]) {
      win = await show(`settings/${id}`, [780, 560]);
      await win.webContents.executeJavaScript("document.activeElement?.blur()");
      await shoot(`settings-${id}-narrow-${theme}`, win);
    }
  }
  win.setSize(1180, 780);
}

async function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`capsule timing: no paint for ${what}`)),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const stats = (xs: number[]) => {
  const a = [...xs].sort((x, y) => x - y);
  const at = (q: number) =>
    +a[Math.min(a.length - 1, Math.floor(a.length * q))].toFixed(1);
  return {
    n: a.length,
    p50: at(0.5),
    p95: at(0.95),
    max: +a.at(-1)!.toFixed(1),
  };
};

/**
 * Capsule timing, split into IPC delivery and render: the first state after launch, warm
 * state changes, the real shortcut-down path (hold machine → controller → capsule), and the
 * hidden-until-dictating mode where the window must be shown first. Writes capsule-timing.json.
 */
async function measureCapsule(m: MurmurApp, outDir: string): Promise<void> {
  const c = m.capsule;
  const t = <T>(p: Promise<T>, what: string) => withTimeout(p, what);
  const cold = await t(
    c.timedShow(() => c.show("listening")),
    "cold",
  );
  await t(
    c.timedShow(() => c.show("resting")),
    "resting",
  );
  // Warm: 200 state changes, each followed by a no-op probe (the frame-scheduling baseline).
  const states: PaintTiming[] = [];
  const probes: PaintTiming[] = [];
  for (let i = 0; i < 50; i++)
    for (const s of [
      "listening",
      "processing",
      "inserted",
      "resting",
    ] as const) {
      states.push(
        await t(
          c.timedShow(() => c.show(s)),
          `warm ${s}`,
        ),
      );
      probes.push(await t(c.probe(), "probe"));
    }
  // Microphone opening, and reopening at different gaps after closing (in the audio window).
  const mic = (await m.audioWindow.webContents.executeJavaScript(`(async () => {
    const open = async () => {
      const t0 = performance.now();
      const s = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
      return { s, ms: performance.now() - t0 };
    };
    const out = { fresh: [], reopen0: [], reopen100: [], reopen400: [] };
    for (let i = 0; i < 6; i++) {
      const a = await open(); out.fresh.push(a.ms);
      a.s.getTracks().forEach((t) => t.stop());
      await new Promise((r) => setTimeout(r, 1500));
    }
    for (const [key, gap] of [["reopen0", 0], ["reopen100", 100], ["reopen400", 400]]) {
      for (let i = 0; i < 6; i++) {
        const a = await open();
        a.s.getTracks().forEach((t) => t.stop());
        await new Promise((r) => setTimeout(r, gap));
        const b = await open(); out[key].push(b.ms);
        b.s.getTracks().forEach((t) => t.stop());
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    return out;
  })()`)) as Record<string, number[]>;
  const statsOf = (xs: number[]) => stats(xs);
  const pick = (k: keyof PaintTiming) => (xs: PaintTiming[]) =>
    xs.map((x) => x[k]);
  const result = {
    measuredAt: new Date().toISOString(),
    load: process.env.MURMUR_TIMING_LOAD ?? "idle",
    loadAverage: execFileSync("sysctl", ["-n", "vm.loadavg"], {
      encoding: "utf8",
    }).trim(),
    busiestProcesses: execFileSync("ps", ["-Ao", "pcpu,comm", "-r"], {
      encoding: "utf8",
    })
      .split("\n")
      .slice(1, 6)
      .map((l) => l.trim().replace(/\s+\/.*\//, " ")),
    cold: Object.fromEntries(
      Object.entries(cold).map(([k, v]) => [k, +v.toFixed(1)]),
    ),
    warm: {
      visible: statsOf(pick("visibleMs")(states)),
      baselineVisible: statsOf(pick("visibleMs")(probes)),
      ipc: statsOf(pick("ipcMs")(states)),
      work: statsOf(pick("workMs")(states)),
      ack: statsOf(pick("ackMs")(states)),
    },
    microphone: Object.fromEntries(
      Object.entries(mic).map(([k, v]) => [k, statsOf(v)]),
    ),
    raw: {
      visible: pick("visibleMs")(states).map((x) => +x.toFixed(2)),
      baselineVisible: pick("visibleMs")(probes).map((x) => +x.toFixed(2)),
      work: pick("workMs")(states).map((x) => +x.toFixed(2)),
      ipc: pick("ipcMs")(states).map((x) => +x.toFixed(2)),
      microphone: mic,
    },
  };
  const file = join(outDir, `capsule-timing-${result.load}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
  console.log(`capsule timing → ${file}`);
}

/**
 * Phase 7: the Capsule in every state, light and dark, over a light and a dark backdrop (a
 * plain colour standing in for the app underneath; the window itself is transparent). States
 * are sent to the real Capsule window directly. "listening-activity" replays level values
 * shaped like speech (simulated: no one spoke); "listening-silence" has no level events.
 */
async function captureCapsule(
  m: MurmurApp,
  outDir: string,
  written: string[],
): Promise<void> {
  const c = m.capsule;
  const wc = c.win.webContents;
  const backdrop = (color: string | null) =>
    wc.executeJavaScript(
      `document.body.style.background = ${JSON.stringify(color ?? "")}`,
    );
  const shot = async (name: string) => {
    await sleep(350);
    const image = await wc.capturePage();
    const file = join(outDir, `${name}.png`);
    writeFileSync(file, image.toPNG());
    written.push(file);
  };
  const SPEECH = [0.004, 0.03, 0.09, 0.16, 0.07, 0.12, 0.21, 0.09, 0.03];
  const scenes: [string, () => Promise<void>][] = [
    ["resting", async () => void (await c.showAndAwaitPaint("resting"))],
    [
      "notice",
      async () => {
        c.setNotice("Shortcut unavailable — open Settings");
        await c.showAndAwaitPaint("resting");
      },
    ],
    [
      "listening-silence",
      async () => {
        c.setNotice(null);
        await c.showAndAwaitPaint("listening");
      },
    ],
    [
      "listening-activity-simulated",
      async () => {
        await c.showAndAwaitPaint("listening");
        for (const rms of SPEECH) {
          c.level(rms);
          await sleep(100);
        }
      },
    ],
    [
      "hands-free",
      async () => {
        await c.showAndAwaitPaint("resting"); // a fresh recording, no levels yet
        await c.showAndAwaitPaint("listening");
        await c.showAndAwaitPaint("handsFree");
      },
    ],
    [
      "transcribing",
      async () => void (await c.showAndAwaitPaint("processing")),
    ],
    ["refining", async () => void (await c.showAndAwaitPaint("refining"))],
    ["inserting", async () => void (await c.showAndAwaitPaint("inserting"))],
    ["inserted", async () => void (await c.showAndAwaitPaint("inserted"))],
    [
      "copied",
      async () =>
        void (await c.showAndAwaitPaint(
          "copied",
          "App changed — copied, press ⌘V",
        )),
    ],
    ["cancelled", async () => void (await c.showAndAwaitPaint("cancelled"))],
    [
      "error-microphone",
      async () =>
        void (await c.showAndAwaitPaint(
          "error",
          "Microphone access is off — open Settings",
        )),
    ],
    [
      "error-transcription",
      async () =>
        void (await c.showAndAwaitPaint(
          "error",
          "Transcription failed — retry from History",
        )),
    ],
    // Stage 7 messages: the longest the controller shows.
    [
      "inserted-mic-disconnected",
      async () =>
        void (await c.showAndAwaitPaint(
          "inserted",
          "Mic disconnected — inserted what it heard",
        )),
    ],
    [
      "error-mic-late",
      async () =>
        void (await c.showAndAwaitPaint(
          "error",
          "Mic was still starting — try again",
        )),
    ],
    [
      "error-auth",
      async () =>
        void (await c.showAndAwaitPaint(
          "error",
          "API key rejected — check Settings",
        )),
    ],
    [
      "inserted-history-failed",
      async () =>
        void (await c.showAndAwaitPaint(
          "inserted",
          "Inserted · not saved to History",
        )),
    ],
    [
      "warning-limit",
      async () =>
        void (await c.showAndAwaitPaint(
          "warning",
          "Stopping in 1 minute (20-minute limit)",
        )),
    ],
  ];
  for (const theme of ["light", "dark"] as const) {
    nativeTheme.themeSource = theme;
    await sleep(300);
    for (const app of ["light-app", "dark-app"] as const) {
      await backdrop(app === "light-app" ? "#f2f1ef" : "#1e1e20");
      for (const [name, run] of scenes) {
        // Every state on its own theme's usual backdrop; key states also on the opposite one.
        const usual = (theme === "light") === (app === "light-app");
        if (
          !usual &&
          ![
            "listening-activity-simulated",
            "inserted",
            "copied",
            "error-microphone",
          ].includes(name)
        )
          continue;
        await run();
        await shot(`capsule-${name}-${theme}-on-${app}`);
      }
    }
  }

  // Reduced motion: no spinner rotation or eased bar heights; checked from computed styles.
  wc.debugger.attach("1.3");
  await wc.debugger.sendCommand("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  nativeTheme.themeSource = "light";
  await backdrop("#f2f1ef");
  await c.showAndAwaitPaint("processing");
  const reduced = await wc.executeJavaScript(`(() => {
    const spin = document.querySelector(".spin");
    const bar = document.querySelector(".wave i");
    return {
      spinnerAnimation: spin ? getComputedStyle(spin).animationName : null,
      barTransition: getComputedStyle(bar).transitionDuration,
    };
  })()`);
  await shot("capsule-transcribing-reduced-motion-light-on-light-app");
  await wc.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [] });
  const normal = await wc.executeJavaScript(`(() => ({
    spinnerAnimation: getComputedStyle(document.querySelector(".spin")).animationName,
    barTransition: getComputedStyle(document.querySelector(".wave i")).transitionDuration,
  }))()`);
  wc.debugger.detach();
  writeFileSync(
    join(outDir, "capsule-reduced-motion.json"),
    JSON.stringify({ reduced, normal }, null, 2) + "\n",
  );
  await backdrop(null);
  await c.showAndAwaitPaint("resting");
}

/**
 * Phase 8: automated accessibility audit with axe-core (WCAG 2.1 A and AA rules) on every Hub
 * screen, Settings section, Onboarding step and the main dialogs, light and dark, plus the
 * Capsule. Also screenshots Onboarding. Writes a11y-audit.json. Automated rules only: this does
 * not replace a VoiceOver pass.
 */
async function auditAccessibility(
  m: MurmurApp,
  show: Show,
  shoot: Shoot,
  outDir: string,
  accountServer: FakeMurmurServer,
): Promise<void> {
  const axe = readFileSync(
    createRequire(join(app.getAppPath(), "package.json")).resolve(
      "axe-core/axe.min.js",
    ),
    "utf8",
  );
  type Violation = {
    id: string;
    impact: string;
    help: string;
    nodes: string[];
  };
  const results: Record<string, Violation[]> = {};
  const audit = async (name: string, wc: Electron.WebContents) => {
    await sleep(400);
    if (!(await wc.executeJavaScript("typeof axe !== 'undefined'")))
      await wc.executeJavaScript(axe);
    const v = (await wc.executeJavaScript(`axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
      resultTypes: ["violations"],
    }).then((r) => r.violations.map((v) => ({
      id: v.id, impact: v.impact, help: v.help,
      nodes: v.nodes.slice(0, 5).map((n) => n.target.join(" ") + " :: " + (n.failureSummary || "").split("\\n")[1]),
    })))`)) as Violation[];
    // The window shell is fixed to the viewport: only the sidebar and the sheet may scroll.
    const doc = (await wc.executeJavaScript(`(() => {
      const main = document.querySelector("main");
      if (main) main.scrollTop = main.scrollHeight;
      const e = document.scrollingElement;
      return { scroll: e.scrollHeight, inner: innerHeight, top: e.scrollTop };
    })()`)) as { scroll: number; inner: number; top: number };
    if (doc.scroll > doc.inner || doc.top !== 0)
      v.push({
        id: "document-scrolls",
        impact: "serious",
        help: "The document is taller than the window",
        nodes: [`scrollHeight ${doc.scroll} > innerHeight ${doc.inner}`],
      });
    results[name] = v;
  };
  const d = (win: Electron.BrowserWindow) => uiDriver(win);
  const sheet = `document.querySelector('[role="dialog"]')`;
  // A short generated recording for every sample row that claims one, so History offers Play.
  // Playback itself is never started here (no sound from a capture run).
  for (const row of m.history.list(1000).filter((r) => r.hasAudio))
    await m.vault.save(
      row.id,
      encodeWav(new Int16Array(16000).fill(2000), 16000),
    );
  for (const theme of ["light", "dark"] as const) {
    nativeTheme.themeSource = theme;
    let win = await show("home");
    await audit(`home-${theme}`, win.webContents);
    if (!m.scratchpad.list().length) m.scratchpad.create({ body: SAMPLE_NOTE });
    for (const route of [
      "history",
      "insights",
      "dictionary",
      "snippets",
      "style",
      "transforms",
      "scratchpad",
      "notetaker",
    ]) {
      win = await show(route);
      await audit(`${route}-${theme}`, win.webContents);
    }
    // Notetaker: every Set up Notetaker step, then a meeting with notes.
    m.settings.update({
      notetaker: { setupCompleted: false, setupCardDismissed: false },
    });
    win = await show("notetaker/setup");
    await d(win).waitFor(sheet);
    for (let i = 0; i < 6; i++) {
      await sleep(300);
      await audit(`notetaker-setup-${i + 1}-${theme}`, win.webContents);
      if (i < 5) await d(win).clickText("Continue", sheet);
    }
    await d(win).key("Escape");
    win = await show(`notetaker/${sampleMeeting(m)}`);
    await d(win).waitFor(`document.querySelector("[data-meeting-detail]")`);
    await audit(`notetaker-meeting-${theme}`, win.webContents);
    // Transforms: the Polish editor, Create your own, and the panel's states.
    win = await show("transforms");
    for (const [name, open] of [
      [
        "polish",
        `[...document.querySelectorAll('ul[aria-label="My Transforms"] button')].find((b) => b.getAttribute("aria-label")?.startsWith("Polish")).click()`,
      ],
      [
        "create",
        `[...document.querySelectorAll("main button")].find((b) => b.textContent === "Create New").click()`,
      ],
    ] as const) {
      await win.webContents.executeJavaScript(open);
      await sleep(500);
      await audit(`transform-editor-${name}-${theme}`, win.webContents);
      await d(win).key("Escape");
      await sleep(300);
    }
    const panel = await showTransformPanel(m);
    await audit(`transform-panel-review-${theme}`, panel.webContents);
    m.transformPanel!.show({
      kind: "consent",
      name: "Polish",
      service: "Groq",
      chars: 120,
    });
    await sleep(300);
    await audit(`transform-panel-consent-${theme}`, panel.webContents);
    m.transformPanel!.hide();
    const note = await showNoteWindow(m);
    await audit(`note-window-${theme}`, note.webContents);
    m.notes?.hide();
    win = await show("insights");
    await d(win).clickText("Your voice");
    await sleep(300);
    await audit(`insights-voice-${theme}`, win.webContents);
    for (const section of [
      "general",
      "shortcuts",
      "microphone",
      "language",
      "system",
      "notetaker",
      "transcription",
      "ai",
      "library",
      "privacy",
      "about",
    ]) {
      win = await show(`settings/${section}`);
      await audit(`settings-${section}-${theme}`, win.webContents);
    }
    await captureAccountScreens(m, show, shoot, audit, theme, accountServer);
    nativeTheme.themeSource = theme;
    win = await show("dictionary");
    await d(win).clickText("Add word");
    await d(win).waitFor(sheet);
    await audit(`dialog-add-word-${theme}`, win.webContents);
    await d(win).key("Escape");
    win = await show("settings/system");
    await d(win).clickText("Reset…");
    await d(win).waitFor(`document.querySelector('[role="alertdialog"]')`);
    await audit(`dialog-reset-${theme}`, win.webContents);
    await d(win).key("Escape");
    win = await show("history");
    const first = await win.webContents.executeJavaScript(
      `Boolean(document.querySelector("[data-row-button]"))`,
    );
    if (first) {
      await win.webContents.executeJavaScript(
        `document.querySelector("[data-row-button]").click()`,
      );
      await d(win).waitFor(sheet);
      await audit(`dialog-history-detail-${theme}`, win.webContents);
      await d(win).key("Escape");
    }
    // A row with a stored recording: its Play button (revealed by keyboard focus) and the sheet.
    win = await show("history");
    const playButton = `document.querySelector("[data-recording-button]")`;
    const hasPlay = await win.webContents.executeJavaScript(
      `(() => { const b = ${playButton}; b?.focus(); return Boolean(b); })()`,
    );
    await audit(`history-play-button-${theme}`, win.webContents);
    if (!hasPlay)
      results[`history-play-button-${theme}`].push({
        id: "play-button-missing",
        impact: "serious",
        help: "A History row with a recording shows no Play button",
        nodes: [],
      });
    else {
      await win.webContents.executeJavaScript(
        `${playButton}.closest("li").querySelector("[data-row-button]").click()`,
      );
      await d(win).waitFor(sheet);
      await audit(`dialog-history-recording-${theme}`, win.webContents);
      await d(win).key("Escape");
    }
    // Onboarding, every screen of the longest path (Notetaker chosen, one practice dictation
    // delivered as the main process would) in this throwaway profile; setup is restored at the end.
    m.settings.update({ onboardingCompleted: false });
    win = await show("onboarding");
    await reloadPage(win);
    nativeTheme.themeSource = theme;
    const ob = d(win);
    // Chips toggle, so choose only what isn't chosen yet (the second theme starts from saved answers).
    const choose = (...labels: string[]) =>
      ob.js(
        `${JSON.stringify(labels)}.forEach((t) => { const b = [...document.querySelectorAll("[data-chip]")].find((x) => x.textContent.trim() === t); if (b && b.getAttribute("aria-pressed") !== "true") b.click(); })`,
      );
    const press = (text: string) => ob.clickText(text);
    const pressStarting = (text: string) =>
      ob.js(
        `[...document.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith(${JSON.stringify(text)}))?.click()`,
      );
    const practiceText = (fieldId: string, text: string) =>
      win.webContents.send("hub:practiceText", {
        fieldId,
        text,
        words: text.split(/\s+/).length,
        durationMs: 3000,
      });
    const none = async () => {};
    const onboardingSteps: [
      string,
      () => Promise<unknown>,
      () => Promise<unknown>,
    ][] = [
      ["account", none, () => press("Continue without an account")],
      ["heard", () => choose("A web search"), () => press("Continue")],
      [
        "help",
        () => choose("Dictating text anywhere", "Notes from my meetings"),
        () => press("Continue"),
      ],
      ["work", () => choose("Design"), () => press("Continue")],
      [
        "typing",
        () => choose("Email", "Chat and messages"),
        () => press("Continue"),
      ],
      ["tools", () => choose("In person"), () => press("Continue")],
      ["pain", () => choose("Staying focused"), () => press("Continue")],
      ["data", none, () => press("Continue")],
      ["permissions", none, () => press("Continue")],
      ["calendar", none, () => press("Skip for now")],
      ["transcription", none, () => pressStarting("Continue")],
      ["mic", none, () => press("Yes")],
      ["languages", none, () => press("Continue")],
      ["shortcut", none, () => press("Yes")],
      [
        "chat",
        async () =>
          practiceText(
            "practice-chat",
            "Yes, running ten minutes late. Start without me.",
          ),
        () => press("Continue"),
      ],
      ["email", none, () => press("Skip")],
      ["list", none, () => press("Skip")],
      ["speed", none, () => press("Continue")],
      ["savings", none, () => press("Continue")],
      ["referral", none, () => press("Finish")],
    ];
    for (const [name, prepare, advance] of onboardingSteps) {
      await sleep(450);
      await prepare();
      // Saving answers re-applies the stored appearance ("system"), so set the capture theme again.
      nativeTheme.themeSource = theme;
      await sleep(350);
      await win.webContents.executeJavaScript("document.activeElement?.blur()");
      await shoot(`onboarding-${name}-${theme}`, win);
      await audit(`onboarding-${name}-${theme}`, win.webContents);
      await advance();
    }
    await sleep(500);
    nativeTheme.themeSource = theme;
    await audit(`capsule-${theme}`, m.capsule.win.webContents);
  }
  const summary = Object.fromEntries(
    Object.entries(results).map(([k, v]) => [
      k,
      v.map((x) => `${x.impact}: ${x.id}`),
    ]),
  );
  writeFileSync(
    join(outDir, "a11y-audit.json"),
    JSON.stringify(
      { rules: "axe-core 4.13.0, WCAG 2.1 A + AA", summary, results },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `a11y: ${Object.values(results).reduce((n, v) => n + v.length, 0)} violation types across ${Object.keys(results).length} screens`,
  );
}

/** Throwaway sample meeting for screenshots and the audit (generic text, never personal data). */
function sampleMeeting(m: MurmurApp): string {
  const existing = m.notetaker.list({ search: "Sample planning meeting" })[0];
  if (existing) return existing.id;
  const start = Date.now() - 2 * 3_600_000;
  const meeting = m.notetaker.create({
    title: "Sample planning meeting",
    startedAt: start,
  });
  m.notetaker.update({ id: meeting.id, endedAt: start + 45 * 60_000 });
  m.notetaker.saveNotes({
    id: meeting.id,
    notes:
      "Agenda\n- Review last week\n- Plan the next release\n\nDecisions\n- Ship on Friday\n\nAction items\n- Write the release notes",
    revision: 1,
  });
  return meeting.id;
}

/** Notetaker screenshots: Set up Notetaker's first step, a meeting, Settings → Notetaker. */
async function shootNotetaker(
  m: MurmurApp,
  show: (route: string) => Promise<Electron.BrowserWindow>,
  shoot: (name: string, win: Electron.BrowserWindow) => Promise<void>,
  theme: "light" | "dark",
): Promise<void> {
  const before = m.settings.get().notetaker;
  m.settings.update({
    notetaker: { setupCompleted: false, setupCardDismissed: false },
  });
  let win = await show("notetaker/setup");
  await uiDriver(win).waitFor(`document.querySelector('[role="dialog"]')`);
  await sleep(400);
  await shoot(`notetaker-setup-${theme}`, win);
  await uiDriver(win).key("Escape");
  m.settings.update({ notetaker: before });
  win = await show(`notetaker/${sampleMeeting(m)}`);
  await uiDriver(win).waitFor(
    `document.querySelector("[data-meeting-detail]")`,
  );
  await sleep(300);
  await shoot(`notetaker-meeting-${theme}`, win);
  win = await show("settings/notetaker");
  await shoot(`settings-notetaker-${theme}`, win);
}
