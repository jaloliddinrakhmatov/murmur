/** Typical-estimate arithmetic behind the speed comparison. These are rules of thumb, not measurements of Murmur. */

export const TYPING_WPM = 40;
export const SPEAKING_WPM = 150;

export function secondsFor(wordCount: number, wpm: number): number {
  if (wordCount < 0 || wpm <= 0)
    throw new RangeError("wordCount must be >= 0 and wpm > 0");
  return Math.round((wordCount / wpm) * 60);
}

export function speedup(
  speakingWpm = SPEAKING_WPM,
  typingWpm = TYPING_WPM,
): number {
  return Math.round((speakingWpm / typingWpm) * 10) / 10;
}

export function formatDuration(seconds: number): string {
  if (seconds < 90) return `${seconds} sec`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} sec`;
}
