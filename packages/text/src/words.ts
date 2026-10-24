/** Counts words; CJK/Thai-family scripts without spaces count each character (per PRODUCT_REQUIREMENTS F11). */
export function countWords(text: string): number {
  // Combining marks (Devanagari vowel signs, NFD accents) and Uzbek apostrophes (o‘, g‘, oʻ)
  // belong inside a word.
  const spaced =
    text.normalize("NFC").match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'’‘ʻʼ\-.]*/gu) ??
    [];
  let count = 0;
  for (const token of spaced) {
    const unspaced = token.match(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Khmer}\p{Script=Lao}]/gu,
    );
    count += unspaced
      ? unspaced.length + (token.length > unspaced.length ? 1 : 0)
      : 1;
  }
  return count;
}

/** Root-mean-square of 16-bit PCM samples, 0..1. */
export function rmsOfPcm16(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}
