// Smoke checks for Insights (Stage 9A) in the real Hub window against the throwaway profile:
// the figures on screen match History, categories, the streak calendar and its paging, Share,
// and the Your voice tab before and after 2,000 words (no AI request: no key in this profile).
import type { BrowserWindow } from "electron";
import type { MurmurApp } from "./app.ts";
import type { DictationRecord } from "./core/types.ts";
import { uiDriver } from "./ui-driver.ts";

type Check = (name: string, ok: boolean, details?: unknown) => void;

const DAY = 86_400_000;

export async function runInsightsChecks(
  m: MurmurApp,
  win: BrowserWindow,
  check: Check,
): Promise<void> {
  const d = uiDriver(win);
  const { js, sleep, waitFor, clickText } = d;
  const text = () =>
    js<string>(`document.querySelector("main#main").innerText`);
  const now = Date.now();
  let n = 0;
  const add = (extra: Partial<DictationRecord>) =>
    m.history.insert({
      id: `ins-${n++}`,
      startedAt: now,
      durationMs: 6000,
      status: "inserted",
      strategy: "clipboard-paste",
      rawText: "um send it",
      finalText: "Send it.",
      wordCount: 2,
      appName: "Slack",
      appBundleId: "com.tinyspeck.slackmacgap",
      error: null,
      provider: "smoke-fake",
      hasAudio: false,
      ...extra,
    });

  await m.service.clearHistory();
  m.hub!.show("insights");
  await waitFor(
    `document.querySelector("main#main h1")?.textContent === "Insights"`,
  );
  await sleep(300);
  check(
    "insights: empty History shows an empty state, not zeros",
    /Your insights start with your first dictation/.test(await text()),
  );

  // Three days in a row ending today, one older day, a failed row that must not count.
  add({
    startedAt: now - 2 * DAY,
    appName: "Mail",
    appBundleId: "com.apple.mail",
    wordCount: 10,
    finalText: "Thanks for the update, see you on Monday at the office.",
  });
  add({ startedAt: now - DAY, wordCount: 30 });
  add({
    startedAt: now,
    wordCount: 60,
    appName: "Notes",
    appBundleId: "com.apple.Notes",
  });
  add({
    startedAt: now - 40 * DAY,
    wordCount: 100,
    appName: "Some App",
    appBundleId: "com.example.some",
  });
  add({ startedAt: now, status: "failed", wordCount: 999, finalText: null });
  m.hub!.show("home");
  await sleep(200);
  m.hub!.show("insights");
  await waitFor(`document.querySelector('[aria-label="Streak"]')`);
  await sleep(300);

  const ins = m.service.insights();
  const shown = await text();
  check(
    "insights usage: totals, streaks and categories match History (failed rows left out)",
    ins.words === 200 &&
      ins.dictations === 4 &&
      ins.currentStreak === 3 &&
      /\b200\s+TOTAL WORDS DICTATED/.test(shown) &&
      /3 days streak/.test(shown) &&
      /LONGEST STREAK \| 3 DAYS/.test(shown) &&
      /TOTAL APPS USED \| 4/.test(shown) &&
      /50%\s*100 words · Other tasks/i.test(shown) &&
      /\b5%\s*10 words · Emails/i.test(shown),
    {
      ins: {
        words: ins.words,
        dictations: ins.dictations,
        streak: ins.currentStreak,
      },
      shown: shown.slice(0, 900),
    },
  );

  const cells = await js<number>(
    `document.querySelectorAll('[aria-label="Streak"] .grid-rows-7.flex-1 > span').length`,
  );
  const coloured = await js<number>(
    `document.querySelectorAll('[aria-label="Streak"] .grid-rows-7.flex-1 > span:not(.bg-surface-strong):not(.bg-transparent)').length`,
  );
  const canGoBack = await js<boolean>(
    `!document.querySelector('[aria-label="Earlier months"]').disabled`,
  );
  check(
    "insights calendar: 20 weeks × 7 days, one shaded cell per day with dictations; earlier months only when there is older data",
    cells === 140 && coloured === 4 && !canGoBack,
    { cells, coloured, canGoBack },
  );

  // Share copies the totals (no dictated words).
  await js(`document.querySelector('[aria-label="Share insights"]').click()`);
  const toasted = await waitFor(
    `document.body.innerText.includes("Insights copied")`,
  );
  // Close the confirmation so it can't outlive this section (it pauses while the window is
  // in the background) and catch the next section's Esc.
  await js(
    `[...document.querySelectorAll('button[aria-label="Dismiss"]')].forEach((b) => b.click())`,
  );
  await waitFor(`!document.body.innerText.includes("Insights copied")`);
  const { clipboard } = await import("electron");
  const copied = await clipboard.readText();
  check(
    "insights share: copies a totals summary without dictated text",
    toasted &&
      copied.startsWith("My Murmur insights") &&
      copied.includes("200 words") &&
      !copied.includes("Thanks for the update"),
    copied,
  );

  // Your voice: locked below 2,000 words, unlocked findings above it.
  await clickText("Your voice");
  await sleep(300);
  const locked = await text();
  const bar = await js<string | null>(
    `document.querySelector('main#main [role="progressbar"]')?.getAttribute("aria-valuenow") ?? null`,
  );
  check(
    "insights voice: locked with the real number of words left",
    /Unlocks in 1,800 words/.test(locked) && bar === "200",
    { bar, locked: locked.slice(0, 400) },
  );
  for (let i = 0; i < 20; i++)
    add({
      startedAt: now - (i % 3) * DAY,
      wordCount: 100,
      finalText:
        "Let me circle back on the shipment schedule tomorrow morning.",
    });
  m.hub!.show("home");
  await sleep(200);
  m.hub!.show("insights");
  await waitFor(`document.querySelector('[aria-label="Streak"]')`);
  await clickText("Your voice");
  await waitFor(`document.body.innerText.includes("Catchphrase")`);
  await sleep(500);
  const open = await text();
  check(
    "insights voice: unlocked findings from local History; the profile asks for an AI service before sending anything",
    !/Unlocks in/.test(open) &&
      /“[a-z' ]+” — the three words/.test(open) &&
      /You dictate most around/.test(open) &&
      /Set up AI service|Write my voice profile/.test(open) &&
      m.service.voiceProfile() === null,
    open.slice(0, 900),
  );

  await m.service.clearHistory();
}
