// Home screen statistics. Everything is derived from the dictations stored in local History,
// so deleting rows, retention purges or turning History off lower the numbers; nothing is
// tracked anywhere else.

/** Counts over delivered dictations: inserted into an app or copied to the clipboard. */
export interface HistoryStats {
  dictations: number;
  words: number;
  /** Total recording time of those dictations. */
  speakingMs: number;
  /** Start of the oldest delivered dictation still in History. */
  firstAt: number | null;
  /** Rolling window: the last 7 × 24 hours. */
  lastWeek: { dictations: number; words: number };
  /**
   * Speaking speed over dictations that have the original transcript and a real recording
   * length (see `speakingWpm`); null when there are none.
   */
  wpm: number | null;
  /** Consecutive local calendar days with a delivered dictation (see `dayStreak`). */
  streakDays: number;
}

export const EMPTY_STATS: HistoryStats = {
  dictations: 0,
  words: 0,
  speakingMs: 0,
  firstAt: null,
  lastWeek: { dictations: 0, words: 0 },
  wpm: null,
  streakDays: 0,
};

/** Recordings shorter than this are taps or false starts, not speech to measure. */
export const MIN_WPM_RECORDING_MS = 1000;

/**
 * Words per minute while speaking: total spoken words ÷ total recording minutes, over every
 * dictation that has both. Spoken words are counted in the original transcript (before
 * cleanup, dictionary and snippets), so an expanded snippet doesn't count as speech. Weighted
 * by recording time, so one very short dictation can't swing the average. Rows without an
 * original transcript or with a recording under 1 s are left out, never estimated.
 */
export function speakingWpm(
  samples: { spokenWords: number; durationMs: number }[],
): number | null {
  let words = 0;
  let ms = 0;
  for (const s of samples)
    if (s.spokenWords > 0 && s.durationMs >= MIN_WPM_RECORDING_MS) {
      words += s.spokenWords;
      ms += s.durationMs;
    }
  return ms ? Math.round(words / (ms / 60_000)) : null;
}

/**
 * The calendar day a moment falls on, in a time zone (default: the system's). Days are always
 * worked out from the stored instant, so moving to another time zone re-buckets old
 * dictations by the new zone's calendar rather than keeping stale day numbers.
 */
export function localDayKey(ts: number, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ts));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** The calendar day before a "YYYY-MM-DD" key (pure date arithmetic, no time zone). */
function previousDay(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d - 1));
  return t.toISOString().slice(0, 10);
}

/**
 * Consecutive days with at least one delivered dictation, ending today, or yesterday when
 * today has none yet (a streak isn't broken until a whole day passes without dictating).
 */
export function dayStreak(
  timestamps: number[],
  now: number,
  timeZone?: string,
): number {
  const days = new Set(timestamps.map((t) => localDayKey(t, timeZone)));
  let day = localDayKey(now, timeZone);
  if (!days.has(day)) day = previousDay(day);
  let n = 0;
  while (days.has(day)) {
    n++;
    day = previousDay(day);
  }
  return n;
}

export const WEEK_MS = 7 * 86_400_000;

/**
 * Assumed typing speed for the time-saved estimate. 40 words per minute is the commonly cited
 * average for typing on a keyboard; it ignores corrections, so for most people it is generous
 * to typing and therefore conservative about the time saved.
 */
export const TYPING_WPM = 40;

/**
 * Estimated time saved: how long the same words would take to type at `typingWpm`, minus the
 * time actually spent speaking them. Never negative. It does not count time spent reviewing or
 * editing the inserted text, so it is an estimate, and the UI labels it as one.
 */
export function estimateTimeSavedMs(
  stats: Pick<HistoryStats, "words" | "speakingMs">,
  typingWpm = TYPING_WPM,
): number {
  const typingMs = (stats.words / typingWpm) * 60_000;
  return Math.max(0, Math.round(typingMs - stats.speakingMs));
}
