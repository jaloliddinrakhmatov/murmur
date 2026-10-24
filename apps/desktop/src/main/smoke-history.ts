// Smoke checks for the History screen in the real Hub window: search, filters, keyboard, the
// detail sheet, copy, retry against real encrypted audio, unrecoverable rows, deletion and the
// effect on Home. Runs inside `npm run smoke` against its throwaway profile.
import type { BrowserWindow } from "electron";
import { encodeWav } from "@murmur/speech";
import type { MurmurApp } from "./app.ts";
import type { DictationRecord } from "./core/types.ts";
import { uiDriver } from "./ui-driver.ts";

type Check = (name: string, ok: boolean, details?: unknown) => void;

export const LONG_TRANSCRIPT = Array.from(
  { length: 40 },
  (_, i) =>
    `Paragraph ${i + 1}: the load from Chicago is confirmed for Thursday, the driver checks in at the dock at seven, and the Bill of Lading travels with the trailer.`,
).join("\n\n");

export async function runHistoryChecks(
  m: MurmurApp,
  win: BrowserWindow,
  provider: { text: string; fail: Error | null },
  check: Check,
): Promise<void> {
  const d = uiDriver(win);
  const { js, sleep, waitFor, key, type, click, clickText, active } = d;
  const text = () => js<string>("document.body.innerText");
  const sheet = `document.querySelector('[role="dialog"]')`;
  const now = Date.now();
  const add = (id: string, extra: Partial<DictationRecord>) =>
    m.history.insert({
      id,
      startedAt: now,
      durationMs: 4200,
      status: "inserted",
      strategy: "clipboard-paste",
      rawText: null,
      finalText: null,
      wordCount: 0,
      appName: "TextEdit",
      appBundleId: null,
      error: null,
      provider: "smoke-fake",
      hasAudio: false,
      ...extra,
    });

  await m.service.clearHistory();
  add("h-cafe", {
    startedAt: now - 60_000,
    rawText: "um meet at cafe muller at noon",
    finalText: "Meet at Café Müller at noon.",
    wordCount: 6,
    appName: "Slack",
  });
  add("h-long", {
    startedAt: now - 120_000,
    rawText: LONG_TRANSCRIPT,
    finalText: LONG_TRANSCRIPT,
    wordCount: LONG_TRANSCRIPT.split(/\s+/).length,
    appName: "Notes",
  });
  add("h-copied", {
    startedAt: now - 180_000,
    status: "copied",
    strategy: "clipboard-only",
    error: "target-changed",
    rawText: "send the invoice",
    finalText: "Send the invoice.",
    wordCount: 3,
    appName: "Mail",
  });
  add("h-fail", {
    startedAt: now - 240_000,
    status: "failed",
    strategy: null,
    error: "HTTP 503 upstream unavailable",
    hasAudio: true,
  });
  await m.vault.save(
    "h-fail",
    encodeWav(new Int16Array(16000).fill(3000), 16000),
  );
  add("h-expired", {
    startedAt: now - 300_000,
    status: "failed",
    strategy: null,
    error: "HTTP 503 upstream unavailable",
    hasAudio: false,
  });

  await d.emulateFocus(true);
  m.hub!.show("history");
  await waitFor(`document.body.innerText.includes("5 dictations")`);
  const body = await text();
  check(
    "history: compact list, one status per row, no duplicated status or error text",
    body.includes("5 dictations") &&
      !/Inserted\s*·\s*Inserted/.test(body) &&
      (body.match(/HTTP 503/g) ?? []).length === 0 &&
      (await js<number>(
        `document.querySelectorAll("[data-row-button]").length`,
      )) === 5,
  );

  // Search is an icon that opens into the field (reference toolbar).
  await click('[aria-label="Search history"]');
  await waitFor(
    `document.activeElement?.matches('input[aria-label="Search history"]')`,
  );
  await type("CAFÉ");
  await waitFor(`document.body.innerText.includes("1 of 5")`);
  const bySearch = await js<string[]>(
    `[...document.querySelectorAll("li[id^=dictation-]")].map((x) => x.id)`,
  );
  await key("Escape");
  await type("slack");
  await waitFor(`document.body.innerText.includes("1 of 5")`);
  const byApp = await js<string[]>(
    `[...document.querySelectorAll("li[id^=dictation-]")].map((x) => x.id)`,
  );
  await type("zzz");
  const none = await waitFor(
    `document.body.innerText.includes("Nothing matches")`,
  );
  await clickText("Clear search");
  await waitFor(`document.body.innerText.includes("5 dictations")`);
  check(
    "history search: Unicode text and app name in SQLite; no results; clear",
    bySearch.join() === "dictation-h-cafe" &&
      byApp.join() === "dictation-h-cafe" &&
      none &&
      (await active()).label === "Search history",
    { bySearch, byApp },
  );

  await click(
    '[role="radiogroup"][aria-label="Show"] [role="radio"]:nth-child(4)',
  );
  await waitFor(`document.body.innerText.includes("2 of 5")`);
  const issues = await js<string[]>(
    `[...document.querySelectorAll("li[id^=dictation-]")].map((x) => x.id)`,
  );
  await click(
    '[role="radiogroup"][aria-label="Show"] [role="radio"]:nth-child(1)',
  );
  await waitFor(`document.body.innerText.includes("5 dictations")`);
  check(
    "history filter: Issues shows only failed and not-inserted dictations",
    issues.join() === "dictation-h-fail,dictation-h-expired",
    issues,
  );

  await js(
    `document.querySelector("#dictation-h-cafe [data-row-button]").focus()`,
  );
  await key("Down");
  const second = await js<string>(`document.activeElement.closest("li").id`);
  await key("Return");
  await waitFor(sheet);
  const inSheet = await js<boolean>(
    `${sheet}.contains(document.activeElement)`,
  );
  await key("Escape");
  await waitFor(`!${sheet}`);
  const back = await js<string>(
    `document.activeElement.closest("li")?.id ?? ""`,
  );
  check(
    "history keyboard: ↓ moves between rows, Enter opens details, Esc returns focus to the row",
    second === "dictation-h-long" && inSheet && back === "dictation-h-long",
    { second, inSheet, back },
  );

  await click('#dictation-h-cafe button[aria-label="Copy text"]');
  const copied = await waitFor(
    `document.body.innerText.includes("Copied to the clipboard")`,
  );
  check(
    "history row: Copy copies and confirms without opening the detail view",
    copied && !(await js<boolean>(`Boolean(${sheet})`)),
  );

  await click("#dictation-h-cafe [data-row-button]");
  await waitFor(sheet);
  const refined = await js<string>(`${sheet}.innerText`);
  await clickText("Original", sheet);
  await sleep(200);
  const original = await js<string>(`${sheet}.innerText`);
  await clickText("Both", sheet);
  await sleep(200);
  const both = await js<string>(`${sheet}.innerText`);
  await key("Escape");
  await waitFor(`!${sheet}`);
  check(
    "history detail: refined, original and both versions with app, length and status",
    refined.includes("Meet at Café Müller at noon.") &&
      refined.includes("Slack") &&
      refined.includes("4.2 s") &&
      original.includes("um meet at cafe muller at noon") &&
      original.includes("Copy original") &&
      both.includes("Meet at Café Müller at noon.") &&
      both.includes("um meet at cafe muller at noon"),
  );

  await click("#dictation-h-long [data-row-button]");
  await waitFor(sheet);
  const long = await js<{
    full: boolean;
    scrolls: boolean;
    overflowX: boolean;
  }>(
    `(() => { const p = document.querySelector('[role="dialog"] p[data-selectable]'); const body = p.closest(".overflow-y-auto"); return { full: p.textContent === ${JSON.stringify(LONG_TRANSCRIPT)}, scrolls: body.scrollHeight > body.clientHeight, overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth || body.scrollWidth > body.clientWidth }; })()`,
  );
  await key("Escape");
  await waitFor(`!${sheet}`);
  check(
    "history detail: a long transcript is complete, selectable and scrolls without overflow",
    long.full && long.scrolls && !long.overflowX,
    long,
  );

  provider.fail = new Error("HTTP 503 still down");
  await click("#dictation-h-fail [data-row-button]");
  await waitFor(sheet);
  const failedView = await js<string>(`${sheet}.innerText`);
  await clickText("Retry transcription", sheet);
  await waitFor(`${sheet}.innerText.includes("Retry failed")`, 5000);
  const afterFail = m.history.get("h-fail");
  check(
    "history retry failure: says so, keeps the row failed and the recording stored",
    failedView.includes("had a problem on its side") &&
      (await js<string>(`${sheet}.innerText`)).includes("Retry failed") &&
      afterFail?.status === "failed" &&
      afterFail.hasAudio === true &&
      (await m.vault.load("h-fail")) !== null,
    afterFail,
  );

  provider.fail = null;
  provider.text = "um recovered words";
  await clickText("Retry transcription", sheet);
  await waitFor(`${sheet}.innerText.includes("Transcribed again")`, 5000);
  const recovered = m.history.get("h-fail");
  check(
    "history retry success: transcribes the stored audio, copies (never pastes), shows the text",
    recovered?.status === "copied" &&
      recovered.strategy === "clipboard-only" &&
      (await js<string>(`${sheet}.innerText`)).includes(
        recovered.finalText ?? "∅",
      ),
    recovered,
  );

  const statsBefore = m.service.historyStats();
  await clickText("Delete…", sheet);
  await waitFor(`document.querySelector('[role="alertdialog"]')`);
  const warns = await js<string>(
    `document.querySelector('[role="alertdialog"]').innerText`,
  );
  await clickText("Delete", `document.querySelector('[role="alertdialog"]')`);
  await waitFor(`!document.querySelector('[role="alertdialog"]') && !${sheet}`);
  check(
    "history delete: confirmation mentions the recording; row and encrypted audio removed",
    warns.includes("encrypted recording") &&
      m.history.get("h-fail") === null &&
      (await m.vault.load("h-fail")) === null &&
      m.history.get("h-cafe") !== null &&
      m.service.historyStats().dictations === statsBefore.dictations - 1,
  );

  await click("#dictation-h-expired [data-row-button]");
  await waitFor(sheet);
  const expired = await js<string>(`${sheet}.innerText`);
  await key("Escape");
  await waitFor(`!${sheet}`);
  check(
    "history unrecoverable: explains the recording is gone and offers no retry",
    expired.includes("can't be recovered") &&
      !expired.includes("Retry transcription"),
  );

  await js(
    `document.querySelector("#dictation-h-copied [data-row-button]").focus()`,
  );
  await key("Tab");
  await key("Tab");
  const menuLabel = (await active()).label;
  await key("Return");
  await waitFor(`document.querySelector('[role="menu"]')`);
  await js(
    `[...document.querySelectorAll('[role="menuitem"]')].find((x) => x.textContent.includes("Delete")).click()`,
  );
  await waitFor(`document.querySelector('[role="alertdialog"]')`);
  const plain = await js<string>(
    `document.querySelector('[role="alertdialog"]').innerText`,
  );
  await clickText("Delete", `document.querySelector('[role="alertdialog"]')`);
  await waitFor(`!document.querySelector('[role="alertdialog"]')`);
  await sleep(400);
  const focusAfter = await js<string>(
    `document.activeElement.closest("li")?.id ?? document.activeElement.getAttribute("aria-label") ?? ""`,
  );
  check(
    "history row menu: keyboard-opened ⋯ deletes after confirmation; focus moves to a neighbour",
    menuLabel === "More actions" &&
      !plain.includes("recording") &&
      m.history.get("h-copied") === null &&
      focusAfter.startsWith("dictation-h-"),
    { menuLabel, focusAfter },
  );

  m.hub!.show("home");
  await sleep(600);
  const home = await text();
  const stats = m.service.historyStats();
  check(
    "home reflects deletions and retries (totals from History)",
    home.includes(stats.words.toLocaleString()) && stats.dictations === 2,
    stats,
  );

  m.hub!.show("history");
  await waitFor(`document.body.innerText.includes("3 dictations")`);
  await click('button[aria-label="More history actions"]');
  await key("Return");
  await waitFor(`document.querySelector('[role="menu"]')`);
  await js(
    `[...document.querySelectorAll('[role="menuitem"]')].find((x) => x.textContent.includes("Delete all")).click()`,
  );
  await waitFor(`document.querySelector('[role="alertdialog"]')`);
  await clickText(
    "Delete all",
    `document.querySelector('[role="alertdialog"]')`,
  );
  await waitFor(
    `document.body.innerText.includes("Your first dictation is one shortcut away")`,
  );
  check(
    "history: Delete all history empties it and shows the first-run state",
    m.history.count() === 0 &&
      (await text()).includes("Your first dictation is one shortcut away"),
  );
  await d.emulateFocus(false);
}
