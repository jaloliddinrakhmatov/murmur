// Approximate Uzbek Cyrillic → Latin transliteration, extended with the Kazakh letters that Whisper
// emits for Uzbek speech (ә і ң ү ұ ө һ). Used only to separate "wrong script" from "wrong words"
// when scoring: FLEURS references are Latin, Whisper's Uzbek output is Cyrillic.
const MAP: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "yo",
  ж: "j",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "x",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "sh",
  ъ: "'",
  ы: "i",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
  ў: "o'",
  қ: "q",
  ғ: "g'",
  ҳ: "h",
  ә: "a",
  і: "i",
  ң: "ng",
  ү: "u",
  ұ: "u",
  ө: "o'",
  һ: "h",
};

export function latinizeUzbek(text: string): string {
  let out = "";
  for (const ch of text) {
    const lower = ch.toLowerCase();
    const mapped = MAP[lower];
    if (mapped === undefined) {
      out += ch;
    } else if (ch !== lower && mapped) {
      out += mapped[0].toUpperCase() + mapped.slice(1);
    } else {
      out += mapped;
    }
  }
  return out;
}
