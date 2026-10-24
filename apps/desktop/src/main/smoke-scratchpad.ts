// Smoke checks for Scratchpad (Stage 9B) in the real Hub and note windows, against the
// throwaway profile: the page, a note typed and saved, Unicode, undo/redo, dictation at the
// cursor, reload restoring the note, tabs, Copy, AI without a configured service (nothing
// sent), delete with confirmation, the global shortcut, open behaviour, and the Esc order
// (dialog, then notification, then page). No real AI or paste requests are made.
import { clipboard, type BrowserWindow } from "electron";
import type { MurmurApp } from "./app.ts";
import { uiDriver } from "./ui-driver.ts";

type Check = (name: string, ok: boolean, details?: unknown) => void;

export async function runScratchpadChecks(
  m: MurmurApp,
  hubWin: BrowserWindow,
  check: Check,
): Promise<void> {
  const hubUi = uiDriver(hubWin);
  for (const n of m.scratchpad.list())
    m.scratchpad.delete({ id: n.id, confirm: true });

  // ---- Page ------------------------------------------------------------------------------------
  m.hub!.show("scratchpad");
  await hubUi.waitFor(
    `document.querySelector("main#main h1")?.textContent.startsWith("Scratchpad")`,
  );
  await hubUi.sleep(300);
  const page = await hubUi.js<string>(
    `document.querySelector("main#main").innerText`,
  );
  check(
    "scratchpad page: title, Beta, shortcut field, Start new note, Recents with an honest empty state",
    /Scratchpad\s*Beta/.test(page) &&
      /Click to enable shortcut/.test(page) &&
      /Start new note/.test(page) &&
      /Recents/.test(page) &&
      /No notes found/.test(page),
    page.slice(0, 500),
  );

  // ---- Start a note from the page --------------------------------------------------------------
  await hubUi.clickText(
    "Start new note",
    `document.querySelector("main#main")`,
  );
  for (let i = 0; i < 60 && !m.notes?.window; i++) await hubUi.sleep(100);
  const opened = Boolean(m.notes?.window);
  const win = m.notes!.window!;
  const ui = uiDriver(win);
  await ui.emulateFocus(true);
  const editorReady = await ui.waitFor(
    `document.getElementById("note-editor")`,
    8000,
  );
  check(
    "Start new note opens the note window with an empty editor",
    opened &&
      editorReady &&
      win.isVisible() &&
      (await ui.js<string>(`document.getElementById("note-editor").value`)) ===
        "",
  );
  const focusEditor = () =>
    ui.js(`document.getElementById("note-editor").focus()`);
  const editorValue = () =>
    ui.js<string>(`document.getElementById("note-editor").value`);
  const saved = async (body: string) => {
    for (let i = 0; i < 40; i++) {
      const notes = m.scratchpad.list();
      if (notes.length && m.scratchpad.get({ id: notes[0].id })?.body === body)
        return notes[0].id;
      await ui.sleep(100);
    }
    return null;
  };

  // ---- Typing, autosave, Unicode ---------------------------------------------------------------
  await focusEditor();
  await ui.type("Hello world");
  const firstId = await saved("Hello world");
  await ui.type("\nCafé 👋 Привет — 東京");
  const unicode = await saved("Hello world\nCafé 👋 Привет — 東京");
  // The database is written first; the window's status follows when the save's reply arrives.
  await ui.waitFor(
    `/Saved/.test(document.querySelector("main").innerText)`,
    3000,
  );
  const status = await ui.js<string>(
    `document.querySelector("main").innerText`,
  );
  check(
    "typing saves on its own: one note, Unicode and emoji intact, status says Saved",
    Boolean(firstId) &&
      unicode === firstId &&
      m.scratchpad.list().length === 1 &&
      /Saved/.test(status),
    { list: m.scratchpad.list(), status },
  );

  // ---- Undo and redo ---------------------------------------------------------------------------
  win.webContents.undo();
  await ui.sleep(300);
  const afterUndo = await editorValue();
  win.webContents.redo();
  await ui.sleep(300);
  const afterRedo = await editorValue();
  check(
    "undo and redo (Edit menu) restore the text",
    afterUndo === "Hello world" &&
      afterRedo === "Hello world\nCafé 👋 Привет — 東京",
    { afterUndo, afterRedo },
  );

  // ---- Dictation at the cursor -----------------------------------------------------------------
  await ui.js(
    `(() => { const e = document.getElementById("note-editor"); e.focus(); e.setSelectionRange(5, 5); })()`,
  );
  const atCursor = await m.notes!.insert("big");
  const body1 = await editorValue();
  await ui.js(
    `(() => { const e = document.getElementById("note-editor"); e.focus(); e.setSelectionRange(10, 15); })()`,
  );
  const replaced = await m.notes!.insert("there");
  const body2 = await editorValue();
  const savedNow = m.scratchpad.get({ id: firstId! })?.body;
  check(
    "dictated text lands at the cursor with a space, replaces a selection, and is saved at once",
    atCursor &&
      replaced &&
      body1.startsWith("Hello big world") &&
      body2.startsWith("Hello big there") &&
      savedNow === body2,
    { body1, body2, savedNow },
  );
  win.webContents.undo();
  await ui.sleep(250);
  check(
    "a dictated insertion is one undo step",
    (await editorValue()).startsWith("Hello big world"),
    await editorValue(),
  );
  await ui.sleep(700);

  // ---- Reload (crash or restart of the page) restores the note -------------------------------
  const before = m.scratchpad.get({ id: firstId! })!.body;
  await new Promise<void>((r) => {
    win.webContents.once("did-finish-load", () => r());
    win.webContents.reload();
  });
  await ui.emulateFocus(true);
  await ui.waitFor(
    `document.getElementById("note-editor")?.value.length > 0`,
    8000,
  );
  check(
    "after the page reloads, the last note opens with its saved text",
    (await editorValue()) === before,
    { before, now: await editorValue() },
  );

  // ---- Tabs and a second note ------------------------------------------------------------------
  await ui.key("N", ["meta"]);
  await ui.waitFor(`document.querySelectorAll('[data-note-tab]').length === 2`);
  await focusEditor();
  await ui.type("Second note about the shipment");
  const second = await saved("Second note about the shipment");
  const tabs = await ui.js<string[]>(
    `[...document.querySelectorAll('[data-note-tab]')].map((t) => t.textContent)`,
  );
  check(
    "⌘N opens a new tab; its note is saved separately and named by its first line",
    Boolean(second) &&
      second !== firstId &&
      m.scratchpad.list().length === 2 &&
      tabs[1] === "Second note about the shipment",
    tabs,
  );

  // Recents on the page shows both, and search narrows them.
  m.hub!.show("scratchpad");
  await hubUi.waitFor(
    `document.querySelectorAll('ul[aria-label="Notes"] > li').length === 2`,
    4000,
  );
  await hubUi.js(
    `document.querySelector('button[aria-label="Search notes"]').click()`,
  );
  await hubUi.sleep(200);
  await hubUi.type("shipment");
  const filtered = await hubUi.waitFor(
    `document.querySelectorAll('ul[aria-label="Notes"] > li').length === 1`,
    3000,
  );
  check("Recents lists both notes; search finds the right one", filtered);
  await hubUi.key("Escape");
  await hubUi.key("Escape");

  // ---- Copy ------------------------------------------------------------------------------------
  clipboard.writeText("before");
  await ui.js(
    `[...document.querySelectorAll("main button")].find((b) => b.textContent.trim() === "Copy").click()`,
  );
  const copiedToast = await ui.waitFor(
    `document.body.innerText.includes("Copied")`,
  );
  check(
    "Copy puts the whole note on the clipboard and says so",
    copiedToast &&
      (await clipboard.readText()) === "Second note about the shipment",
  );
  await ui.js(
    `[...document.querySelectorAll('button[aria-label="Dismiss"]')].forEach((b) => b.click())`,
  );

  // ---- AI without a configured service: nothing is sent ------------------------------------------
  const ai = await m.scratchpad.aiStatus();
  let refused = "";
  try {
    await m.scratchpad.ai({
      requestId: "smoke",
      transformId: "polish",
      text: "hello",
    });
  } catch (e) {
    refused = (e as Error).message;
  }
  await ui.js(
    `document.querySelector('button[aria-label="AI edits"]').dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }))`,
  );
  await ui.sleep(400);
  const menu = await ui.js<string>(
    `document.querySelector('[role="menu"]')?.innerText ?? ""`,
  );
  await ui.key("Escape");
  check(
    "AI edits without an AI service: the menu says so and offers setup; a request is refused before sending",
    ai.ready !== null &&
      /isn't set up/.test(menu) &&
      /Set up AI service/.test(menu) &&
      /Nothing was sent/.test(refused),
    { ai, menu, refused },
  );

  // ---- AI edit applied: a stand-in AI answer, Replace, then ⌘Z ---------------------------------
  // No real AI request: the service's AI calls are replaced for this check only.
  const sp = m.scratchpad as unknown as {
    aiStatus: typeof m.scratchpad.aiStatus;
    ai: typeof m.scratchpad.ai;
  };
  const realStatus = sp.aiStatus;
  const realAi = sp.ai;
  const original = await editorValue();
  const edited = "Second note about the delivery.";
  sp.aiStatus = async () => ({
    ready: null,
    service: "Groq",
    provider: "groq",
    consented: true,
    summaryConsented: false,
  });
  sp.ai = async () => ({ text: edited, name: "Polish" });
  try {
    await ui.js(
      `document.querySelector('button[aria-label="AI edits"]').dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }))`,
    );
    await ui.waitFor(
      `[...document.querySelectorAll('[role="menuitem"]')].some((b) => b.textContent === "Polish" && !b.hasAttribute("data-disabled"))`,
    );
    await ui.js(
      `[...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent === "Polish").click()`,
    );
    const shown = await ui.waitFor(
      `document.querySelector('[role="dialog"]')?.innerText.includes(${JSON.stringify(edited)})`,
      4000,
    );
    await ui.js(
      `[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === "Replace").click()`,
    );
    const replaced = await ui.waitFor(
      `document.getElementById("note-editor").value === ${JSON.stringify(edited)}`,
      3000,
    );
    const confirmed = await ui.waitFor(
      `document.body.innerText.includes("Replaced")`,
    );
    const savedEdit = await saved(edited);
    await focusEditor();
    win.webContents.undo();
    await ui.sleep(300);
    const undone = (await editorValue()) === original;
    await saved(original);
    check(
      "AI edit: the result is shown first; Replace changes the note, is saved, and ⌘Z undoes it",
      shown && replaced && confirmed && Boolean(savedEdit) && undone,
      { shown, replaced, confirmed, savedEdit, now: await editorValue() },
    );
  } finally {
    sp.aiStatus = realStatus;
    sp.ai = realAi;
  }
  await ui.js(
    `[...document.querySelectorAll('button[aria-label="Dismiss"]')].forEach((b) => b.click())`,
  );

  // ---- Esc in the editor never closes the window or loses text --------------------------------
  await focusEditor();
  await ui.key("Escape");
  await ui.sleep(200);
  check(
    "Esc in the note window keeps the window and the text",
    win.isVisible() &&
      (await editorValue()) === "Second note about the shipment",
  );

  // ---- Delete with confirmation ----------------------------------------------------------------
  await ui.js(
    `document.querySelector('button[aria-label="More note actions"]').dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }))`,
  );
  await ui.sleep(300);
  await ui.js(
    `[...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.startsWith("Delete")).click()`,
  );
  const asked = await ui.waitFor(
    `document.querySelector('[role="alertdialog"]')?.innerText.includes("can't be undone")`,
  );
  const stillThere = m.scratchpad.list().length === 2;
  await ui.js(
    `[...document.querySelectorAll('[role="alertdialog"] button')].find((b) => b.textContent === "Delete note").click()`,
  );
  const deleted = await ui.waitFor(
    `document.querySelectorAll('[data-note-tab]').length === 1`,
    3000,
  );
  check(
    "Delete asks first, then removes the note and its tab",
    asked && stillThere && deleted && m.scratchpad.list().length === 1,
  );

  // ---- Close hides the window; the note stays ---------------------------------------------------
  await ui.js(
    `document.querySelector('button[aria-label="Close Scratchpad"]').click()`,
  );
  for (let i = 0; i < 20 && win.isVisible(); i++) await ui.sleep(100);
  const hidden = !win.isVisible();
  m.notes!.show({ resume: true }, { inactive: true });
  await ui.sleep(400);
  check(
    "Close hides the window; opening it again shows the same note",
    hidden &&
      win.isVisible() &&
      (await editorValue()).startsWith("Hello big world"),
  );

  // ---- Global shortcut ---------------------------------------------------------------------------
  // A combination nothing on this Mac holds (Carbon refuses one that is taken).
  const combo =
    ["ctrl+cmd+6", "ctrl+cmd+5", "ctrl+opt+cmd+j"].find((c) => {
      const r = m.native.registerHotkey(97, c, { exclusive: true }, () => {});
      if (r.ok) m.native.unregisterHotkey(97);
      return r.ok;
    }) ?? null;
  if (combo) {
    const r = await m.service.setActionShortcut({
      action: "openScratchpad",
      shortcut: combo,
    });
    const bound = m.hotkeys.actions.openScratchpad?.registered === true;
    m.notes!.hide();
    m.runShortcutAction("openScratchpad", "pressed");
    await ui.sleep(400);
    const shown = win.isVisible();
    await m.service.setActionShortcut({
      action: "openScratchpad",
      shortcut: null,
    });
    check(
      "the Open Scratchpad shortcut registers, opens the window, and can be removed",
      Boolean(r) &&
        bound &&
        shown &&
        m.settings.get().shortcuts.openScratchpad === null,
    );
  } else
    check(
      "the Open Scratchpad shortcut (no free combination to test with)",
      true,
    );

  // ---- Open behaviour ----------------------------------------------------------------------------
  const resume = m.scratchpad.initial()?.id;
  m.settings.update({ scratchpad: { openBehavior: "new" } });
  const fresh = m.scratchpad.initial();
  m.settings.update({ scratchpad: { openBehavior: "resume" } });
  check(
    "open behaviour: resume shows the last note, new starts empty",
    resume === firstId && fresh === null,
  );
  m.notes!.hide();
  await ui.emulateFocus(false);

  // ---- Esc order: dialog first, then the notice, then the page ----------------------------------
  m.history.insert({
    id: "esc-order",
    startedAt: Date.now(),
    durationMs: 3000,
    status: "inserted",
    strategy: "clipboard-paste",
    rawText: "esc order",
    finalText: "Esc order.",
    wordCount: 2,
    appName: "Notes",
    appBundleId: null,
    error: null,
    provider: "smoke-fake",
    hasAudio: false,
  });
  m.service.notifyHistory();
  m.hub!.show("home");
  await hubUi.emulateFocus(true);
  await hubUi.waitFor(
    `document.querySelector('#dictation-esc-order button[aria-label="Copy text"]')`,
    4000,
  );
  await hubUi.js(
    `[...document.querySelectorAll('nav[aria-label="Main"] button')].find((b) => b.textContent.trim() === "Settings").click()`,
  );
  await hubUi.waitFor(`document.getElementById("settings-section-title")`);
  await hubUi.sleep(400);
  // A notice appears while Settings is open (the History row behind it copies its text).
  await hubUi.js(
    `document.querySelector('#dictation-esc-order button[aria-label="Copy text"]').click()`,
  );
  const noticeShown = await hubUi.waitFor(
    `document.body.innerText.includes("Copied to the clipboard")`,
  );
  await hubUi.key("Escape");
  const settingsClosed = !(await hubUi.js<boolean>(
    `Boolean(document.getElementById("settings-section-title"))`,
  ));
  const noticeKept = await hubUi.js<boolean>(
    `document.body.innerText.includes("Copied to the clipboard")`,
  );
  await hubUi.key("Escape");
  const noticeGone = !(await hubUi.js<boolean>(
    `document.body.innerText.includes("Copied to the clipboard")`,
  ));
  check(
    "Esc order: the open dialog closes first (even with a newer notice), then the notice",
    noticeShown && settingsClosed && noticeKept && noticeGone,
    { noticeShown, settingsClosed, noticeKept, noticeGone },
  );
  await m.service.deleteDictation({ id: "esc-order" });

  for (const n of m.scratchpad.list())
    m.scratchpad.delete({ id: n.id, confirm: true });
}
