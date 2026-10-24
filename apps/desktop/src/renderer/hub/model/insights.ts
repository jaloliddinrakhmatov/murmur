// Insights page geometry and wording (pure, unit-tested): the streak calendar's weeks, the
// heat level of a day, the speed gauge and the category rows.
import {
  CATEGORY_LABELS,
  type AppCategory,
  type Insights,
} from "../../../shared/insights.ts";
import { TYPING_WPM } from "../../../shared/stats.ts";
import { localDayKey } from "../../../shared/stats.ts";

/** Weeks the calendar shows at a time (about five months, as in the reference). */
export const CALENDAR_WEEKS = 20;

export interface CalendarDay {
  key: string;
  /** Local midnight of the day. */
  date: Date;
  count: number;
  future: boolean;
}

export interface CalendarPage {
  /** Columns of seven days, Sunday first. */
  weeks: CalendarDay[][];
  /** Month labels and the column where each month starts. */
  months: { label: string; column: number }[];
  /** True when an earlier page could hold dictations. */
  hasEarlier: boolean;
  hasLater: boolean;
}

/**
 * The calendar page `offset` pages before the current one (0 = the page ending this week).
 * Built from local calendar dates, so daylight-saving changes don't shift days.
 */
export function calendarPage(
  days: Record<string, number>,
  now: Date,
  offset = 0,
): CalendarPage {
  const thisSunday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - now.getDay(),
  );
  const firstSunday = new Date(
    thisSunday.getFullYear(),
    thisSunday.getMonth(),
    thisSunday.getDate() - 7 * (CALENDAR_WEEKS * (offset + 1) - 1),
  );
  const todayKey = localDayKey(now.getTime());
  const weeks: CalendarDay[][] = [];
  const months: CalendarPage["months"] = [];
  for (let w = 0; w < CALENDAR_WEEKS; w++) {
    const week: CalendarDay[] = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(
        firstSunday.getFullYear(),
        firstSunday.getMonth(),
        firstSunday.getDate() + w * 7 + d,
      );
      const key = localDayKey(date.getTime());
      week.push({ key, date, count: days[key] ?? 0, future: key > todayKey });
      if (date.getDate() === 1 || (w === 0 && d === 0))
        months.push({
          label: date.toLocaleDateString("en-US", { month: "short" }),
          column: w,
        });
    }
    weeks.push(week);
  }
  // A month starting in the first column's later days would print over the first label.
  const merged = months.filter(
    (m, i) => i === 0 || m.column > months[i - 1].column + 1,
  );
  const firstKey = weeks[0][0].key;
  return {
    weeks,
    months:
      merged.length > 1 && merged[1].column <= 1 ? merged.slice(1) : merged,
    hasEarlier: Object.keys(days).some((k) => k < firstKey),
    hasLater: offset > 0,
  };
}

/** 0 = none, then four shades (the legend's "Less" to "More"). */
export function heatLevel(count: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count <= 3) return 2;
  if (count <= 6) return 3;
  return 4;
}

/** The gauge's full scale: four times typing speed. */
export const GAUGE_MAX_WPM = TYPING_WPM * 4;

export function gaugeFraction(wpm: number | null): number {
  if (wpm === null || wpm <= 0) return 0;
  return Math.min(wpm / GAUGE_MAX_WPM, 1);
}

/** "2.1× typing": speaking speed against the typing speed the time-saved estimate uses. */
export function versusTyping(wpm: number | null): string | null {
  if (wpm === null || wpm <= 0) return null;
  const x = wpm / TYPING_WPM;
  return `${x >= 10 ? Math.round(x) : x.toFixed(1)}× typing`;
}

/** Reference order: other tasks first, then the five named categories. */
export const CATEGORY_ORDER: AppCategory[] = [
  "other",
  "ai",
  "email",
  "work",
  "personal",
  "documents",
];

export function categoryRows(ins: Insights): {
  category: AppCategory;
  label: string;
  words: number;
  percent: number;
}[] {
  return CATEGORY_ORDER.map((category) => ({
    category,
    label: CATEGORY_LABELS[category],
    words: ins.categories[category],
    percent: ins.words
      ? Math.round((ins.categories[category] / ins.words) * 100)
      : 0,
  }));
}

export function wordsToUnlock(ins: Insights): number {
  return Math.max(ins.voice.unlockAt - ins.words, 0);
}
