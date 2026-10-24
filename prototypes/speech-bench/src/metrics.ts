const APOSTROPHES = /[‘’ʻʼ`´']/g;

/** Lowercases, unifies apostrophes (Uzbek o‘/g‘ variants), and strips punctuation. */
export function normalize(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(APOSTROPHES, "'")
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .replace(/(^|\s)'+|'+(?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function editDistance<T>(a: T[], b: T[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

export interface ErrorCounts {
  wordEdits: number;
  refWords: number;
  charEdits: number;
  refChars: number;
}

export function errorCounts(
  reference: string,
  hypothesis: string,
): ErrorCounts {
  const r = normalize(reference);
  const h = normalize(hypothesis);
  const rw = r ? r.split(" ") : [];
  const hw = h ? h.split(" ") : [];
  return {
    wordEdits: editDistance(rw, hw),
    refWords: rw.length,
    charEdits: editDistance([...r], [...h]),
    refChars: [...r].length,
  };
}

/** Share of letters that are Cyrillic: Uzbek can come back in Cyrillic instead of Latin script. */
export function cyrillicShare(text: string): number {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return 0;
  return (
    letters.filter((c) => /\p{Script=Cyrillic}/u.test(c)).length /
    letters.length
  );
}
