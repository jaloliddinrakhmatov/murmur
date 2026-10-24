// Smoke checks for Transforms (Stage 9C) in the real windows, against the throwaway profile.
// No AI request is made: the service's AI calls are replaced by a stand-in answer here. No real
// paste happens either: the smoke run's inserter only records what it was given.
import { execFileSync, spawnSync } from "node:child_process";
import { clipboard, type BrowserWindow } from "electron";
import type { MurmurApp } from "./app.ts";
import { uiDriver } from "./ui-driver.ts";

type Check = (name: string, ok: boolean, details?: unknown) => void;
type Record = (name: string, status: "NOT-TESTED", reason: string) => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const osa = (...lines: string[]) =>
  execFileSync(
    "osascript",
    lines.flatMap((l) => ["-e", l]),
  )
    .toString()
    .trim();

export async function runTransformChecks(
  m: MurmurApp,
  hubWin: BrowserWindow,
  inserted: () => { text: string; target: { appBundleId: string | null } }[],
  check: Check,
  record: Record,
): Promise<void> {
  const ui = uiDriver(hubWin);
  const text = () =>
    ui.js<string>(`document.querySelector("main#main").innerText`);
  await ui.emulateFocus(true);

  // ---- Page ------------------------------------------------------------------------------------
  m.hub!.show("transforms");
  await ui.waitFor(
    `document.querySelector("main#main h1")?.textContent.startsWith("Transforms")`,
  );
  await ui.sleep(400);
  const page = await text();
  check(
    "transforms page: title, Beta, Opt in (off), view-changes shortcut, banner, Polish, Prompt Engineer, Create your own",
    /Transforms\s*Beta/.test(page) &&
      (await ui.js<boolean>(
        `document.getElementById("transforms-opt-in").getAttribute("aria-checked") === "false"`,
      )) &&
      /to view changes/.test(page) &&
      /Transforms work anywhere you write/.test(page) &&
      /Polish/.test(page) &&
      /Prompt Engineer/.test(page) &&
      /Create your own/.test(page) &&
      m.settings.get().transforms.optIn === false,
    page.slice(0, 600),
  );

  // ---- Opt in registers the shortcuts; opting out releases them ----------------------------------
  await ui.click("#transforms-opt-in");
  await ui.waitFor(
    `document.getElementById("transforms-opt-in").getAttribute("aria-checked") === "true"`,
  );
  await sleep(300);
  const on = m.transforms.list();
  const registeredOn = on.filter((t) => t.status?.registered).map((t) => t.id);
  await ui.click("#transforms-opt-in");
  await sleep(300);
  const off = m.transforms.list();
  check(
    "opt in registers the Transform shortcuts; opting out releases them",
    m.settings.get().transforms.optIn === false &&
      off.every((t) => t.status === null) &&
      // Each default really registers; the only accepted failure is another app holding it
      // (⌥-only shortcuts, which macOS won't register without Input Monitoring, fail this).
      on.length === 2 &&
      on.every(
        (t) =>
          t.status?.registered === true ||
          /already used by another app/.test(t.status?.error ?? ""),
      ),
    {
      on: on.map((t) => [t.id, t.status]),
      off: off.map((t) => [t.id, t.status]),
    },
  );

  // ---- Create from a template; duplicate names refused; delete asks first --------------------------
  await ui.clickText("Create New");
  await ui.waitFor(
    `[...document.querySelectorAll('[role="dialog"] button')].some((b) => b.textContent === "Fix grammar")`,
  );
  await ui.clickText(
    "Fix grammar",
    `document.querySelector('[role="dialog"]')`,
  );
  for (
    let i = 0;
    i < 30 && !m.transforms.list().some((t) => t.name === "Fix grammar");
    i++
  )
    await sleep(100);
  const created = m.transforms.list().find((t) => t.name === "Fix grammar");
  await ui.waitFor(
    `document.querySelector('[role="dialog"] h2')?.textContent === "Fix grammar"`,
  );
  await ui.js(`document.getElementById("transform-name").focus()`);
  await ui.js(
    `(() => { const i = document.getElementById("transform-name"); i.select(); })()`,
  );
  await ui.type("polish");
  await sleep(900);
  const dupShown = await ui.waitFor(
    `document.querySelector('[role="dialog"]')?.innerText.includes("already exists")`,
  );
  check(
    "create: a template fills in and saves a custom Transform; a duplicate name is refused",
    Boolean(created) &&
      created!.prompt.startsWith("Correct grammar") &&
      dupShown &&
      m.transforms.list().filter((t) => t.name.toLowerCase() === "polish")
        .length === 1,
    { created: created?.name, dupShown },
  );
  await ui.clickText("Delete", `document.querySelector('[role="dialog"]')`);
  const asked = await ui.waitFor(
    `document.querySelector('[role="alertdialog"]')?.innerText.includes("can't be undone")`,
  );
  const stillThere = m.transforms.list().some((t) => t.id === created?.id);
  await ui.clickText(
    "Delete Transform",
    `document.querySelector('[role="alertdialog"]')`,
  );
  for (
    let i = 0;
    i < 20 && m.transforms.list().some((t) => t.id === created?.id);
    i++
  )
    await sleep(100);
  check(
    "delete asks first, then removes the custom Transform",
    asked &&
      stillThere &&
      !m.transforms.list().some((t) => t.id === created?.id),
  );
  await ui.key("Escape");
  await sleep(300);

  // ---- Polish rules save as they change; Reset to defaults restores them ---------------------------
  m.hub!.show("transforms");
  await sleep(300);
  await ui.js(
    `[...document.querySelectorAll('ul[aria-label="My Transforms"] button')].find((b) => b.textContent.includes("Polish")).click()`,
  );
  await ui.waitFor(`document.getElementById("rule-concise")`);
  await ui.click("#rule-concise");
  for (
    let i = 0;
    i < 20 && m.transforms.get({ id: "polish" })!.rules!.concise;
    i++
  )
    await sleep(100);
  const ruleOff = m.transforms.get({ id: "polish" })!.rules!.concise === false;
  await ui.key("Escape");
  await sleep(300);
  m.transforms.resetDefaults();
  check(
    "Polish rule switches save immediately; Reset to defaults restores them",
    ruleOff && m.transforms.get({ id: "polish" })!.rules!.concise === true,
  );

  // ---- The panel, with a stand-in AI answer ---------------------------------------------------------
  const t = m.transforms as unknown as {
    run: typeof m.transforms.run;
    aiStatus: typeof m.transforms.aiStatus;
  };
  const realRun = t.run;
  const realStatus = t.aiStatus;
  let consented = false;
  t.aiStatus = async () => ({
    ready: null,
    service: "Groq",
    provider: "groq",
    consented,
    summaryConsented: false,
  });
  t.run = async () => ({ text: "The draft text to polish.", name: "Polish" });
  const panel = () => m.transformPanel!;
  const panelText = () =>
    panel().window?.webContents.executeJavaScript("document.body.innerText") ??
    Promise.resolve("");
  const click = (label: string) =>
    panel().window!.webContents.executeJavaScript(
      `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(label)} || b.getAttribute("aria-label") === ${JSON.stringify(label)})?.click()`,
    );
  const waitPanel = async (re: RegExp, ms = 4000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(80))
      if (re.test(await panelText().catch(() => ""))) return true;
    return false;
  };

  try {
    // History "Transform with": consent first, then the review (Copy only; the dictation is kept).
    m.history.insert({
      id: "tr-1",
      startedAt: Date.now(),
      durationMs: 3000,
      status: "inserted",
      strategy: "clipboard-paste",
      rawText: "teh draft text to polish",
      finalText: "teh draft text to polish",
      wordCount: 5,
      appName: "Notes",
      appBundleId: null,
      error: null,
      provider: "smoke-fake",
      hasAudio: false,
    });
    const escBefore = m.native.registeredHotkeyCount?.() ?? null;
    await ui.js(`window.hub.transformDictation("tr-1", "polish")`);
    const consent = await waitPanel(/Allow Groq/);
    const escWhileOpen = m.native.registeredHotkeyCount?.() ?? null;
    const w = panel().window!;
    await click("Allow Groq");
    consented = true;
    const review = await waitPanel(/The draft text to polish\./);
    const body = await panelText();
    check(
      "panel: a non-focusable floating panel; consent before anything is sent; Before/After review; Esc armed while open",
      !w.isFocusable() &&
        w.isAlwaysOnTop() &&
        consent &&
        review &&
        /Copy result/.test(body) &&
        !/Replace/.test(body) &&
        m.settings.get().scratchpad.aiConsent.includes("groq") &&
        (escBefore === null || escWhileOpen === escBefore + 1),
      { escBefore, escWhileOpen, body: body.slice(0, 300) },
    );
    clipboard.writeText("before");
    await click("Copy result");
    const copied = await waitPanel(/Copied/);
    check(
      "panel Copy result puts the result on the clipboard and says so; the dictation is unchanged",
      copied &&
        (await clipboard.readText()) === "The draft text to polish." &&
        m.history.get("tr-1")!.finalText === "teh draft text to polish",
    );
    await click("Done");
    await sleep(200);
    m.runShortcutAction("transformViewChanges", "pressed");
    const past = await waitPanel(/Your last Transform/);
    await click("Close");
    await sleep(200);
    const escAfter = m.native.registeredHotkeyCount?.() ?? null;
    check(
      "view changes shows the last result again; closing releases Esc",
      past &&
        !panel().window!.isVisible() &&
        (escBefore === null || escAfter === escBefore),
      { past, visible: panel().window!.isVisible(), escBefore, escAfter },
    );
    await m.service.deleteDictation({ id: "tr-1" });

    // A real selection in TextEdit, read through Accessibility; Replace goes through the inserter once.
    try {
      const textEditRunning =
        spawnSync("pgrep", ["-x", "TextEdit"]).status === 0;
      if (textEditRunning)
        record(
          "transform a TextEdit selection",
          "NOT-TESTED",
          "TextEdit already running",
        );
      else if (!m.native.permissionStatus().accessibility)
        record(
          "transform a TextEdit selection",
          "NOT-TESTED",
          "Accessibility not granted to this process",
        );
      else {
        osa(
          'tell application "TextEdit" to activate',
          'tell application "TextEdit" to make new document with properties {text:"teh draft text to polish"}',
        );
        await sleep(1200);
        osa(
          'tell application "System Events" to keystroke "a" using command down',
        );
        await sleep(400);
        const before = inserted().length;
        // Someone using the Mac may bring another app forward; then nothing is read from it.
        const textEditInFront = () =>
          m.native.frontmostApp()?.bundleId === "com.apple.TextEdit";
        if (!textEditInFront()) {
          record(
            "transform a TextEdit selection",
            "NOT-TESTED",
            "TextEdit isn't in front (another app is in use)",
          );
          osa('tell application "TextEdit" to quit saving no');
          throw new SkipTextEdit();
        }
        // Stage E part 2: the bounded field read behind context awareness and auto-add.
        const around = m.native.readTextAround(null, 600, 200);
        const window = m.native.readTextAround(4, 0, 5);
        check(
          "TextEdit: reading around the cursor returns that text (and a window at a position exactly that stretch), never more",
          around.ok &&
            around.text === "teh draft text to polish" &&
            around.cursor === 0 &&
            window.ok &&
            window.text === "draft" &&
            window.start === 4,
          {
            around: {
              ok: around.ok,
              length: around.text?.length,
              cursor: around.cursor,
            },
            window: { ok: window.ok, text: window.text, start: window.start },
          },
        );
        // The real path: the Transform's own shortcut, pressed (⌃⌥1, key code 18 is "1").
        m.settings.update({ transforms: { optIn: true } });
        await sleep(300);
        const polishBound =
          m.transforms.list().find((t) => t.id === "polish")?.status
            ?.registered === true;
        let viaShortcut = false;
        if (polishBound) {
          osa(
            'tell application "System Events" to key code 18 using {control down, option down}',
          );
          viaShortcut = await waitPanel(
            /Replace|doesn't let|Copy result/,
            5000,
          );
        }
        if (!polishBound)
          record(
            "Transform shortcut pressed in TextEdit opens the panel",
            "NOT-TESTED",
            "⌃⌥1 is held by another app on this Mac",
          );
        else
          check(
            "Transform shortcut (⌃⌥1) pressed in TextEdit opens the panel with that selection",
            viaShortcut,
            { panel: (await panelText()).slice(0, 160) },
          );
        if (!viaShortcut) await m.sessions!.start("polish");
        m.settings.update({ transforms: { optIn: false } });
        const reviewed = await waitPanel(/Replace/);
        const front = m.native.frontmostApp()?.bundleId;
        await click("Replace");
        await waitPanel(
          /Pasted|Replaced|Nothing changed|nothing was replaced/i,
        );
        const done = await panelText();
        const calls = inserted().slice(before);
        check(
          "TextEdit: the selection is read (Accessibility), reviewed with TextEdit still in front, and Replace sends the result to the inserter once",
          reviewed &&
            front === "com.apple.TextEdit" &&
            calls.length === 1 &&
            calls[0].text === "The draft text to polish." &&
            calls[0].target.appBundleId === "com.apple.TextEdit" &&
            // The smoke run's inserter records instead of pasting, so TextEdit's selection is
            // unchanged afterwards and the honest outcome is "Nothing changed".
            /Nothing changed/.test(done),
          { reviewed, front, calls: calls.length, done: done.slice(0, 200) },
        );
        await click("Done");
        // The selection changes before Replace: nothing is replaced.
        osa(
          'tell application "System Events" to keystroke "a" using command down',
        );
        await sleep(300);
        await m.sessions!.start("polish");
        await waitPanel(/Replace/);
        osa('tell application "System Events" to key code 124'); // → collapses the selection
        await sleep(400);
        const sel = m.native.readSelection();
        const n = inserted().length;
        await click("Replace");
        const refused = await waitPanel(/selection changed/);
        const after = await panelText();
        check(
          "TextEdit: a selection that changed before Replace is not replaced; Copy is offered",
          refused && inserted().length === n && /Copy result/.test(after),
          {
            refused,
            pasted: inserted().length - n,
            selectionNow: {
              ok: sel.ok,
              textLength: sel.text?.length ?? null,
              range: [sel.rangeLocation, sel.rangeLength],
            },
            front: m.native.frontmostApp()?.bundleId,
            panel: after.slice(0, 160),
          },
        );
        await click("Close");
        try {
          osa('tell application "TextEdit" to quit saving no');
        } catch {
          /* already closed */
        }
      }
    } catch (e) {
      if (!(e instanceof SkipTextEdit)) throw e;
    }

    // Scratchpad: the shortcut in the note window transforms its selection there.
    m.notes!.show({ new: true }, { inactive: true });
    const nw = m.notes!.window!;
    const nui = uiDriver(nw);
    await nui.emulateFocus(true);
    await nui.waitFor(`document.getElementById("note-editor")`, 8000);
    await nui.js(`document.getElementById("note-editor").focus()`);
    await nui.type("teh draft text to polish");
    await nui.js(`document.getElementById("note-editor").select()`);
    nw.webContents.send("note:transform", "polish");
    const shown = await nui.waitFor(
      `document.querySelector('[role="dialog"]')?.innerText.includes("The draft text to polish.")`,
      4000,
    );
    await nui.js(
      `[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === "Replace")?.click()`,
    );
    const replaced = await nui.waitFor(
      `document.getElementById("note-editor").value === "The draft text to polish."`,
      3000,
    );
    check(
      "Scratchpad: a Transform shortcut in the note window transforms its selection, with preview and Replace",
      shown && replaced,
      { shown, replaced },
    );
    await nui.emulateFocus(false);
    m.notes!.hide();
    for (const n of m.scratchpad.list())
      m.scratchpad.delete({ id: n.id, confirm: true });
  } finally {
    t.run = realRun;
    t.aiStatus = realStatus;
    m.transformPanel?.hide();
    m.settings.update({ scratchpad: { aiConsent: [] } });
  }
  await ui.emulateFocus(false);
}

class SkipTextEdit extends Error {}
