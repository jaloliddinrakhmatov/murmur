// You / Others labels (Stage 9D-3). With your microphone and your Mac's sound recorded apart,
// each track is transcribed with timestamps and the two are merged into one conversation:
// "You: …" for the microphone, "Others: …" for what the Mac played. Without headphones the
// microphone also hears the speakers; a microphone line that repeats what Others said at the
// same time is that echo, and is dropped.
import type { TranscriptSegment } from "@murmur/speech";

export type Speaker = "You" | "Others";

/** Share of a microphone line's words that, at the same time, Others said: above it, it's echo. */
const ECHO_SHARE = 0.6;

/** Words too common to show that two lines are the same (ignored when comparing). */
const COMMON = new Set(
  "a an and are as at be but by do for from i if in is it its me my of on or so that the this to we you your yes no okay ok um uh".split(
    " ",
  ),
);

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .normalize("NFC")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

const contentWords = (text: string): string[] => {
  const all = words(text);
  const content = all.filter((w) => !COMMON.has(w));
  return content.length ? content : all;
};

/** The length of the longest run of words that `a` and `b` share in the same order. */
function longestCommonRun(a: string[], b: string[]): number {
  let best = 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++)
      if (a[i - 1] === b[j - 1]) {
        row[j] = prev[j - 1] + 1;
        if (row[j] > best) best = row[j];
      }
    prev = row;
  }
  return best;
}

/** True when `mine` overlaps `theirs` in time and most of its words repeat theirs, in order. */
function isEcho(mine: TranscriptSegment, theirs: TranscriptSegment[]): boolean {
  const own = contentWords(mine.text);
  if (!own.length) return true;
  const heard = theirs
    .filter((t) => t.start < mine.end + 0.5 && t.end > mine.start - 0.5)
    .flatMap((t) => contentWords(t.text));
  if (!heard.length) return false;
  return longestCommonRun(own, heard) / own.length >= ECHO_SHARE;
}

/**
 * One batch's conversation: the segments of both tracks in time order, consecutive lines of
 * the same speaker joined, each line "You: …" or "Others: …". Echo is removed only between
 * timed segments (`timed`: both tracks came back with real timing); otherwise each track is a
 * single whole-section segment, so both are kept whole (You, then Others).
 */
export function mergeSpeakers(
  you: TranscriptSegment[],
  others: TranscriptSegment[],
  timed = true,
): string {
  const mine = you.map((s) => ({ ...s, speaker: "You" as Speaker }));
  const theirs = others.map((s) => ({ ...s, speaker: "Others" as Speaker }));
  const lines = timed
    ? [...mine.filter((s) => !isEcho(s, others)), ...theirs].sort(
        (a, b) => a.start - b.start || (a.speaker === "Others" ? -1 : 1),
      )
    : [...mine, ...theirs];
  const out: { speaker: Speaker; text: string }[] = [];
  for (const l of lines) {
    const last = out.at(-1);
    if (last && last.speaker === l.speaker) last.text += ` ${l.text}`;
    else out.push({ speaker: l.speaker, text: l.text });
  }
  return out.map((l) => `${l.speaker}: ${l.text}`).join("\n");
}

/** A track's segments, or its whole text as one segment when the service gave no timing. */
export function segmentsOf(
  result: { text: string; segments?: TranscriptSegment[] },
  durationSec: number,
): TranscriptSegment[] {
  if (result.segments?.length) return result.segments;
  const text = result.text.trim();
  return text ? [{ start: 0, end: durationSec, text }] : [];
}

/** Whether the service returned real timing for a track (an absent track needs none). */
export const isTimed = (
  result: { segments?: TranscriptSegment[] } | undefined,
): boolean => !result || Boolean(result.segments?.length);
