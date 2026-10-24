// The Style page's cleanup levels (pure; unit-tested in test/style.test.ts). They are the
// existing `settings.cleanup.mode` values under the reference's names, not a second setting.
import { applyStyle, cleanup, type WritingStyle } from "@murmur/text";
import type { Settings } from "../../../shared/settings.ts";

type Mode = Settings["cleanup"]["mode"];

export interface StyleLevel {
  mode: Mode;
  name: "None" | "Light" | "Medium";
  description: string;
  /** What this level does to the sample sentence. */
  example: string;
  /** True when the example is produced by Murmur's own code rather than written by hand. */
  exampleIsReal: boolean;
}

/** One spoken sentence, as a speech service returns it. */
export const SAMPLE_DICTATION =
  "um so we're still on for coffee tomorrow i think we should uh leave a bit earlier there might be traffic";

export const STYLE_LEVELS: StyleLevel[] = [
  {
    mode: "off",
    name: "None",
    description: "Inserts exactly what the speech service returned.",
    example: cleanup(SAMPLE_DICTATION, "off").text,
    exampleIsReal: true,
  },
  {
    mode: "deterministic",
    name: "Light",
    description:
      "Removes filler words, fixes capitals and adds final punctuation. Runs on this Mac.",
    example: cleanup(SAMPLE_DICTATION, "light").text,
    exampleIsReal: true,
  },
  {
    mode: "ai",
    name: "Medium",
    description:
      "An AI service also fixes grammar and punctuation, keeping your words and meaning.",
    // AI output depends on the service; this is an illustration, labelled as such on the page.
    example:
      "So we're still on for coffee tomorrow. I think we should leave a bit earlier; there might be traffic.",
    exampleIsReal: false,
  },
];

export const levelFor = (mode: Mode): StyleLevel =>
  STYLE_LEVELS.find((l) => l.mode === mode) ?? STYLE_LEVELS[1];

// ---- Writing styles per kind of app (Stage E part 2) ---------------------------------------------

/** The Light example, styled: what each card shows is what Murmur would insert. */
const LIGHT_EXAMPLE = cleanup(SAMPLE_DICTATION, "light").text;

export const STYLE_CARDS: {
  style: WritingStyle;
  name: string;
  description: string;
  example: string;
}[] = [
  {
    style: "formal",
    name: "Formal",
    description: "Capitals and full stops, as cleaned up.",
    example: applyStyle(LIGHT_EXAMPLE, "formal"),
  },
  {
    style: "casual",
    name: "Casual",
    description: "Capitals kept; no full stop at the end, like a chat message.",
    example: applyStyle(LIGHT_EXAMPLE, "casual"),
  },
  {
    style: "veryCasual",
    name: "Very casual",
    description:
      "Lowercase sentence starts and no final full stop. “I”, acronyms and your dictionary's words keep their capitals.",
    example: applyStyle(LIGHT_EXAMPLE, "veryCasual"),
  },
];
