// Insights (Stage 9A): everything is derived from the dictations in local History on every call —
// no stored counters, no data about other people (so no percentiles), nothing sent anywhere.
import { dayStreak, localDayKey } from "./stats.ts";

export type AppCategory =
  "ai" | "email" | "work" | "personal" | "documents" | "other";

export const CATEGORY_LABELS: Record<AppCategory, string> = {
  ai: "AI prompts",
  email: "Emails",
  work: "Work messages",
  personal: "Personal messages",
  documents: "Documents",
  other: "Other tasks",
};

/**
 * Category by the app's bundle id (or name). Only apps Murmur can recognise for certain; a
 * browser could be anything, so it counts as "other" rather than a guess.
 */
const CATEGORY_BY_BUNDLE: [RegExp, AppCategory][] = [
  [
    /^com\.openai\.chat|^com\.anthropic\.claudefordesktop|^ai\.perplexity|^com\.todesktop\.230313mzl4w4u92|^dev\.warp|^com\.exafunction\.windsurf/i,
    "ai",
  ],
  [
    /^com\.apple\.mail$|^com\.microsoft\.outlook|^com\.readdle\.smartemail|^com\.superhuman|^com\.mimestream|^it\.bloop\.airmail/i,
    "email",
  ],
  [
    /^com\.tinyspeck\.slackmacgap|^com\.microsoft\.teams|^com\.linear|^notion\.id|^com\.atlassian|^com\.hnc\.discord/i,
    "work",
  ],
  [
    /^com\.apple\.(ichat|MobileSMS)$|^net\.whatsapp|^ru\.keepcoder\.telegram|^com\.tdesktop\.telegram|^org\.whispersystems\.signal|^com\.facebook\.archon|^com\.viber/i,
    "personal",
  ],
  [
    /^com\.apple\.(TextEdit|Notes|iWork\.Pages)$|^com\.microsoft\.Word|^md\.obsidian|^com\.literatureandlatte|^pro\.writer\.mac|^net\.shinyfrog\.bear|^com\.ulyssesapp|^com\.google\.Chrome\.app\.docs/i,
    "documents",
  ],
];

export function categorizeApp(
  bundleId: string | null,
  name: string | null,
): AppCategory {
  const id = bundleId ?? "";
  for (const [re, cat] of CATEGORY_BY_BUNDLE) if (re.test(id)) return cat;
  const n = (name ?? "").toLowerCase();
  if (/^(chatgpt|claude|perplexity|cursor)$/.test(n)) return "ai";
  if (/^(mail|outlook|spark|superhuman)$/.test(n)) return "email";
  if (/^(slack|microsoft teams|linear|notion|discord)$/.test(n)) return "work";
  if (/^(messages|whatsapp|telegram|signal|messenger|viber)$/.test(n))
    return "personal";
  if (/^(textedit|notes|pages|microsoft word|obsidian|bear|ulysses)$/.test(n))
    return "documents";
  return "other";
}

export interface InsightRow {
  startedAt: number;
  durationMs: number;
  rawText: string | null;
  finalText: string | null;
  wordCount: number;
  appName: string | null;
  appBundleId: string | null;
}

/** Words of at least 2,000 dictated unlock the voice findings (enough text to say anything). */
export const VOICE_UNLOCK_WORDS = 2000;

export interface Insights {
  dictations: number;
  words: number;
  wpm: number | null;
  /** Dictionary corrections and snippet expansions applied, and dictations Murmur tidied. */
  fixes: { dictionary: number; snippets: number; tidied: number };
  apps: { name: string; words: number; category: AppCategory }[];
  categories: Record<AppCategory, number>;
  /** Dictations per local day ("YYYY-MM-DD"). */
  days: Record<string, number>;
  currentStreak: number;
  longestStreak: number;
  voice: {
    unlockAt: number;
    /** Dictations per hour of the day (0–23, local time). */
    hours: number[];
    peakHour: number | null;
    topApp: string | null;
    topWords: { word: string; count: number }[];
    /** The most repeated three-word phrase (at least 3 times), if any. */
    catchphrase: string | null;
  };
}

/** Longest run of consecutive local days with at least one dictation. */
export function longestStreak(dayKeys: Iterable<string>): number {
  const days = [...new Set(dayKeys)].sort();
  let best = 0;
  let run = 0;
  let prev: number | null = null;
  for (const key of days) {
    const t = Date.UTC(
      +key.slice(0, 4),
      +key.slice(5, 7) - 1,
      +key.slice(8, 10),
    );
    run = prev !== null && t - prev === 86_400_000 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = t;
  }
  return best;
}

const STOP_WORDS = new Set(
  (
    "a an the and or but so if then than to of in on at by for with from as is are was were be " +
    "been being am i you he she it we they me him her us them my your his its our their this " +
    "that these those there here what which who whom whose when where why how all any both each " +
    "few more most other some such no nor not only own same too very can will just do does did " +
    "doing have has had having would should could um uh like okay ok yeah yes also about into " +
    "over again once up down out off let let's i'm it's don't that's"
  ).split(" "),
);

function words(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []).filter(
    (w) => w.length > 1,
  );
}

export function computeInsights(
  rows: InsightRow[],
  usage: { dictionary: number; snippets: number; wpm: number | null },
  now = Date.now(),
  timeZone?: string,
): Insights {
  const categories: Record<AppCategory, number> = {
    ai: 0,
    email: 0,
    work: 0,
    personal: 0,
    documents: 0,
    other: 0,
  };
  const apps = new Map<
    string,
    { name: string; words: number; category: AppCategory }
  >();
  const days: Record<string, number> = {};
  const hours = new Array<number>(24).fill(0);
  const wordCounts = new Map<string, number>();
  const phraseCounts = new Map<string, number>();
  const hourFmt = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hourCycle: "h23",
    timeZone,
  });
  let tidied = 0;
  for (const r of rows) {
    const category = categorizeApp(r.appBundleId, r.appName);
    categories[category] += r.wordCount;
    const appName = r.appName ?? "Unknown app";
    const a = apps.get(appName) ?? { name: appName, words: 0, category };
    a.words += r.wordCount;
    apps.set(appName, a);
    const day = localDayKey(r.startedAt, timeZone);
    days[day] = (days[day] ?? 0) + 1;
    hours[Number(hourFmt.format(r.startedAt)) % 24]++;
    if (r.rawText && r.finalText && r.rawText.trim() !== r.finalText.trim())
      tidied++;
    const ws = words(r.finalText ?? "");
    for (const w of ws)
      if (!STOP_WORDS.has(w)) wordCounts.set(w, (wordCounts.get(w) ?? 0) + 1);
    for (let i = 0; i + 2 < ws.length; i++) {
      const p = `${ws[i]} ${ws[i + 1]} ${ws[i + 2]}`;
      phraseCounts.set(p, (phraseCounts.get(p) ?? 0) + 1);
    }
  }
  const totalWords = rows.reduce((t, r) => t + r.wordCount, 0);
  const peak = Math.max(...hours);
  const sortedApps = [...apps.values()].sort(
    (a, b) => b.words - a.words || a.name.localeCompare(b.name),
  );
  const topPhrase = [...phraseCounts.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return {
    dictations: rows.length,
    words: totalWords,
    // The same figure as the Dictation page (HistoryDb.stats), not a second calculation.
    wpm: usage.wpm,
    fixes: { dictionary: usage.dictionary, snippets: usage.snippets, tidied },
    apps: sortedApps,
    categories,
    days,
    currentStreak: dayStreak(
      rows.map((r) => r.startedAt),
      now,
      timeZone,
    ),
    longestStreak: longestStreak(Object.keys(days)),
    voice: {
      unlockAt: VOICE_UNLOCK_WORDS,
      hours,
      peakHour: rows.length ? hours.indexOf(peak) : null,
      topApp: sortedApps[0]?.name ?? null,
      topWords: [...wordCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 8)
        .map(([word, count]) => ({ word, count })),
      catchphrase: topPhrase ? topPhrase[0] : null,
    },
  };
}

/** "10 AM", "12 PM", "7 PM": the hour of the day, in the reference's 12-hour style. */
export function hourLabel(hour: number): string {
  const h = hour % 12 || 12;
  return `${h} ${hour < 12 ? "AM" : "PM"}`;
}

/** The text Share copies: only totals and categories, never words or phrases from dictations. */
export function insightsSummary(ins: Insights): string {
  const lines = [
    "My Murmur insights",
    `${ins.words.toLocaleString("en-US")} words dictated in ${ins.dictations.toLocaleString("en-US")} ${ins.dictations === 1 ? "dictation" : "dictations"}`,
  ];
  if (ins.wpm !== null) lines.push(`${ins.wpm} words per minute`);
  lines.push(
    `${ins.currentStreak} day streak (longest ${ins.longestStreak} ${ins.longestStreak === 1 ? "day" : "days"})`,
  );
  const used = (Object.keys(ins.categories) as AppCategory[])
    .filter((c) => ins.categories[c] > 0)
    .sort((a, b) => ins.categories[b] - ins.categories[a])
    .map(
      (c) =>
        `${CATEGORY_LABELS[c]} ${Math.round((ins.categories[c] / ins.words) * 100)}%`,
    );
  if (used.length) lines.push(used.join(" · "));
  return lines.join("\n");
}
