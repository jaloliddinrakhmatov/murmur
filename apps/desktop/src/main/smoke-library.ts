// Smoke checks for the Dictionary and Snippets screens in the real Hub window: real clicks,
// real key events and typed text, with results read back from the database through the service.
// Runs inside `npm run smoke` against its throwaway profile.
import type { BrowserWindow } from "electron";
import type { MurmurApp } from "./app.ts";
import { uiDriver } from "./ui-driver.ts";

type Check = (name: string, ok: boolean, details?: unknown) => void;

export async function runLibraryChecks(
  m: MurmurApp,
  win: BrowserWindow,
  check: Check,
): Promise<void> {
  const {
    js,
    sleep,
    waitFor,
    key,
    type,
    click,
    clickText,
    active,
    emulateFocus,
  } = uiDriver(win);
  const dialogOpen = () =>
    js<boolean>(
      `Boolean(document.querySelector('[role="dialog"],[role="alertdialog"]'))`,
    );
  const submitDisabled = () =>
    js<boolean>(
      `document.querySelector('[role="dialog"] button[type="submit"]').disabled`,
    );
  const text = () => js<string>("document.body.innerText");

  await emulateFocus(true);

  // ---- Shared: dialogs return focus to whatever opened them ----------------------------------
  m.hub!.show("dictionary");
  await sleep(400);
  await js(
    `(() => { const b = [...document.querySelectorAll('nav[aria-label="Main"] button')].find((x) => x.textContent.trim() === "Settings"); b.focus(); b.click(); })()`,
  );
  await waitFor(`document.getElementById("settings-section-title")`);
  await key("Escape");
  await waitFor(`!document.getElementById("settings-section-title")`);
  const fromSettings = await active();
  check(
    "settings sheet: Esc closes it and returns focus to the Settings button",
    fromSettings.text === "Settings",
    fromSettings,
  );

  // ---- Dictionary ----------------------------------------------------------------------------
  for (const r of m.service.listDictionary())
    m.service.deleteDictionaryEntry({ id: r.id });
  m.hub!.show("dictionary");
  await waitFor(`document.body.innerText.includes("No custom words yet")`);
  check(
    "dictionary: empty state with a working Add word action",
    (await text()).includes("No custom words yet") &&
      (await js<number>(
        `[...document.querySelectorAll("button")].filter((b) => b.textContent.trim() === "Add word").length`,
      )) === 2,
  );

  await clickText("Add word");
  await waitFor(`document.querySelector('[role="dialog"]')`);
  const first = await active();
  check(
    "dictionary dialog: opens with focus in the word field, Save disabled",
    first.label === "Word or phrase" && (await submitDisabled()),
    first,
  );
  await key("Return");
  check(
    "dictionary dialog: Enter on an empty form explains instead of saving",
    (await dialogOpen()) &&
      (await text()).includes("Enter the word or phrase."),
  );
  await type("Café Müller");
  await waitFor(
    `!document.querySelector('[role="dialog"] button[type="submit"]').disabled`,
  );
  await key("Escape");
  const asked = (await text()).includes("Discard your changes?");
  const keepFocused = (await active()).text === "Keep editing";
  await key("Escape");
  const back = await active();
  check(
    "dictionary dialog: Esc with unsaved text asks first; Esc again keeps editing",
    asked &&
      keepFocused &&
      (await dialogOpen()) &&
      back.label === "Word or phrase" &&
      back.value === "Café Müller",
    { asked, keepFocused, back },
  );
  await key("Return");
  await waitFor(`!document.querySelector('[role="dialog"]')`);
  const restored = await active();
  check(
    "dictionary: Enter saves; focus returns to Add word; row persisted",
    !(await dialogOpen()) &&
      restored.text === "Add word" &&
      m.service.findDictionaryPhrase("Café Müller")?.phrase === "Café Müller" &&
      (await text()).includes("Café Müller"),
    restored,
  );

  await clickText("Add word");
  await waitFor(`document.querySelector('[role="dialog"]')`);
  await type("CAFÉ MÜLLER");
  const dupShown = await waitFor(
    `document.querySelector('[role="dialog"]').innerText.includes("is already in your dictionary")`,
  );
  check(
    "dictionary dialog: duplicate (case and accents) is flagged, Save disabled",
    dupShown && (await submitDisabled()),
  );
  await key("Escape");
  await clickText("Discard");
  await waitFor(`!document.querySelector('[role="dialog"]')`);
  check(
    "dictionary dialog: Discard closes without saving",
    !(await dialogOpen()) && m.service.listDictionary().length === 1,
  );

  m.service.addDictionaryEntry({ phrase: "NestJS", misheardAs: "nest js" });
  await waitFor(`document.body.innerText.includes("2 words")`);
  await js(
    `document.querySelector('[aria-label="Search dictionary"]').click()`,
  );
  await waitFor(
    `document.activeElement?.matches('input[aria-label="Search dictionary"]')`,
  );
  await type("CAFÉ");
  const filtered = await text();
  await type("zzz");
  const none = await text();
  await clickText("Clear search");
  await sleep(200);
  const cleared = await active();
  check(
    "dictionary search: Unicode case-insensitive, no-results state, Clear search",
    filtered.includes("1 of 2 words") &&
      filtered.includes("Café Müller") &&
      !filtered.includes("NestJS") &&
      none.includes("No words match “CAFÉzzz”") &&
      cleared.label === "Search dictionary" &&
      cleared.value === "" &&
      (await text()).includes("2 words") &&
      m.service.listDictionary().length === 2,
    { cleared },
  );

  await click('button[role="switch"][aria-label="Apply Café Müller"]');
  await sleep(400);
  check(
    "dictionary row: the switch toggles only the entry, never opens the editor",
    !(await dialogOpen()) &&
      m.service.findDictionaryPhrase("Café Müller")?.enabled === false,
  );

  await click('button[aria-label="Edit Café Müller"]');
  await waitFor(`document.querySelector('[role="dialog"]')`);
  const editState = {
    title: await js<string>(
      `document.querySelector('[role="dialog"] h2').textContent`,
    ),
    value: (await active()).value,
    saveDisabled: await submitDisabled(),
  };
  await js(`document.querySelectorAll('[role="dialog"] input')[1].focus()`);
  await type("cafe muller");
  await key("Return");
  await waitFor(`!document.querySelector('[role="dialog"]')`);
  const afterEdit = await active();
  check(
    "dictionary edit: prefilled, Save waits for a change, saves, focus back on Edit",
    editState.title === "Edit word" &&
      editState.value === "Café Müller" &&
      editState.saveDisabled &&
      m.service.findDictionaryPhrase("Café Müller")?.misheardAs ===
        "cafe muller" &&
      afterEdit.label === "Edit Café Müller",
    { editState, afterEdit },
  );

  await click('button[aria-label="Delete NestJS"]');
  await waitFor(`document.querySelector('[role="alertdialog"]')`);
  const cancelFocused = (await active()).text === "Cancel";
  await key("Escape");
  await waitFor(`!document.querySelector('[role="alertdialog"]')`);
  const kept = await active();
  check(
    "dictionary delete: confirmation starts on Cancel; Esc keeps the word, focus returns",
    cancelFocused &&
      m.service.findDictionaryPhrase("NestJS") !== null &&
      kept.label === "Delete NestJS",
    kept,
  );
  await click('button[aria-label="Delete NestJS"]');
  await waitFor(`document.querySelector('[role="alertdialog"]')`);
  await clickText("Delete", `document.querySelector('[role="alertdialog"]')`);
  await waitFor(`!document.querySelector('[role="alertdialog"]')`);
  await sleep(300);
  const afterDelete = await active();
  check(
    "dictionary delete: confirmed delete removes the row; focus moves to search",
    m.service.findDictionaryPhrase("NestJS") === null &&
      !(
        await js<string>(
          `document.querySelector('ul[aria-label="Dictionary words"]').innerText`,
        )
      ).includes("NestJS") &&
      afterDelete.label === "Search dictionary",
    afterDelete,
  );
  await click('button[aria-label="Delete Café Müller"]');
  await waitFor(`document.querySelector('[role="alertdialog"]')`);
  await clickText("Delete", `document.querySelector('[role="alertdialog"]')`);
  await waitFor(`document.body.innerText.includes("No custom words yet")`);
  await sleep(300);
  check(
    "dictionary delete: deleting the last word shows the empty state, focus on Add word",
    (await active()).text === "Add word" &&
      m.service.listDictionary().length === 0,
  );

  // ---- Snippets ------------------------------------------------------------------------------
  for (const r of m.service.listSnippets())
    m.service.deleteSnippet({ id: r.id });
  m.hub!.show("snippets");
  await waitFor(
    `document.body.innerText.includes("Create your first snippet")`,
  );
  check(
    "snippets: empty state with a working Create snippet action",
    (await text()).includes("Create your first snippet"),
  );

  await clickText("Create snippet");
  await waitFor(`document.querySelector('[role="dialog"]')`);
  const sFirst = await active();
  const sDisabled = await submitDisabled();
  await type("my email");
  await key("Tab");
  const long = "Best regards,\nJaloliddin\n".repeat(160).slice(0, 4000);
  await type(long);
  await waitFor(
    `!document.querySelector('[role="dialog"] button[type="submit"]').disabled`,
  );
  const counter = await text();
  await key("Return", ["meta"]);
  await waitFor(`!document.querySelector('[role="dialog"]')`);
  const saved = m.service.listSnippets()[0];
  check(
    "snippet create: focus on trigger, Save disabled until valid, ⌘↩ saves 4,000 characters",
    sFirst.label === "Trigger phrase" &&
      sDisabled &&
      counter.includes("4,000 / 4,000") &&
      saved?.trigger === "my email" &&
      saved.replacement === long,
    { sFirst, saved: saved?.replacement.length },
  );

  const subtitle = await js<{ text: string; clipped: boolean }>(
    `(() => { const s = [...document.querySelectorAll('ul[aria-label="Snippets"] li')][0].querySelector(".truncate.text-ui"); return { text: s.textContent, clipped: s.scrollWidth > s.clientWidth }; })()`,
  );
  await click('button[aria-label="Edit snippet my email"]');
  await waitFor(`document.querySelector('[role="dialog"] textarea')`);
  const fullText = await js<string>(
    `document.querySelector('[role="dialog"] textarea').value`,
  );
  await key("Escape");
  await waitFor(`!document.querySelector('[role="dialog"]')`);
  check(
    "snippet row: long text is one truncated line; the editor has all of it; Esc closes unchanged",
    subtitle.text.length <= 160 &&
      subtitle.clipped &&
      fullText === long &&
      !(await dialogOpen()),
    { length: subtitle.text.length, clipped: subtitle.clipped },
  );

  await clickText("Create snippet");
  await waitFor(`document.querySelector('[role="dialog"]')`);
  await type("MY EMAIL");
  // The conflict check is asynchronous (IPC); 5 s like the other dialog checks, so a slow
  // moment on the Mac doesn't fail it (Stage 9C follow-up).
  const conflict = await waitFor(
    `document.querySelector('[role="dialog"]').innerText.includes("Another snippet already uses this trigger.")`,
    5000,
  );
  check(
    "snippet create: a conflicting trigger is flagged and Save stays disabled",
    conflict && (await submitDisabled()),
  );
  // Practice sentence: Enter previews, never saves.
  await js(`document.querySelectorAll('[role="dialog"] input')[0].select()`);
  await type("my phone");
  await key("Tab");
  await type("+998 90 000 00 00");
  await js(`document.querySelectorAll('[role="dialog"] input')[1].focus()`);
  await type("call my phone or my email");
  await key("Return");
  const previewShown = await waitFor(
    `document.querySelector('[role="dialog"]').innerText.includes("call +998 90 000 00 00 or Best regards,")`,
  );
  check(
    "snippet preview: shows the draft with saved snippets; Enter in Try it doesn't save",
    previewShown &&
      (await dialogOpen()) &&
      m.service.listSnippets().length === 1,
  );
  await key("Escape");
  await clickText("Discard");
  await waitFor(`!document.querySelector('[role="dialog"]')`);

  await click('button[role="switch"][aria-label="Use snippet my email"]');
  await sleep(400);
  check(
    "snippet row: the switch disables the snippet without opening the editor",
    !(await dialogOpen()) && m.service.listSnippets()[0].enabled === false,
  );

  m.service.addSnippet({
    trigger: "office address",
    replacement: "12 Example Street",
  });
  await waitFor(`document.body.innerText.includes("2 snippets")`);
  await js(`document.querySelector('[aria-label="Search snippets"]').click()`);
  await waitFor(
    `document.activeElement?.matches('input[aria-label="Search snippets"]')`,
  );
  await type("EXAMPLE STREET");
  const sFiltered = await text();
  await key("Escape");
  const escCleared = await js<string>(
    `document.querySelector('input[aria-label="Search snippets"]').value`,
  );
  check(
    "snippet search: matches the inserted text case-insensitively; Esc clears",
    sFiltered.includes("1 of 2 snippets") &&
      sFiltered.includes("office address") &&
      escCleared === "" &&
      m.service.listSnippets().length === 2,
  );

  await click('button[aria-label="Delete snippet office address"]');
  await waitFor(`document.querySelector('[role="alertdialog"]')`);
  await clickText("Delete", `document.querySelector('[role="alertdialog"]')`);
  await waitFor(`!document.querySelector('[role="alertdialog"]')`);
  check(
    "snippet delete: confirmed delete removes it from the database",
    m.service
      .listSnippets()
      .map((s) => s.trigger)
      .join() === "my email",
  );

  await emulateFocus(false);
}
