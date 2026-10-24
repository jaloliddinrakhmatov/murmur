// Scores one meeting summary against its case (pure; unit-tested in test/summary.test.ts).
import type { SummaryCase } from "./summary-cases.ts";

export const SECTIONS = [
  "Summary",
  "Decisions",
  "Action items",
  "Open questions",
] as const;

export interface SummaryScore {
  pass: boolean;
  missingSections: string[];
  missingFacts: string[];
  forbidden: string[];
  sectionsNotEmpty: string[];
  wrongScript: boolean;
}

/** The text of one Markdown section (from its heading to the next `## `). */
function section(summary: string, name: string): string | null {
  const re = new RegExp(
    `^#{1,4}\\s*${name.replace(/ /g, "\\s+")}\\s*$([\\s\\S]*?)(?=^#{1,4}\\s|(?![\\s\\S]))`,
    "im",
  );
  return re.exec(summary)?.[1]?.trim() ?? null;
}

const NOTHING =
  /none mentioned|ничего|не упоминал|yo['‘’]q|mavjud emas|^-?\s*none\.?$/i;

export function scoreSummary(c: SummaryCase, summary: string): SummaryScore {
  const lower = summary.toLowerCase();
  // Uzbek and Russian summaries may translate the headings; only English ones are required.
  const missingSections =
    c.script === "cyrillic" || c.id === "uzbek"
      ? []
      : SECTIONS.filter((s) => section(summary, s) === null);
  const missingFacts = c.mustInclude
    .filter((alts) => !alts.some((a) => lower.includes(a.toLowerCase())))
    .map((alts) => alts.join(" / "));
  const forbidden = c.mustNotInclude.filter((f) =>
    lower.includes(f.toLowerCase()),
  );
  const sectionsNotEmpty = (c.emptySections ?? []).filter((name) => {
    const body = section(summary, name);
    return body !== null && !NOTHING.test(body);
  });
  let wrongScript = false;
  if (c.script) {
    const cyr = (summary.match(/\p{Script=Cyrillic}/gu) ?? []).length;
    const lat = (summary.match(/\p{Script=Latin}/gu) ?? []).length;
    wrongScript = c.script === "cyrillic" ? cyr < lat : lat < cyr;
  }
  return {
    pass:
      !missingSections.length &&
      !missingFacts.length &&
      !forbidden.length &&
      !sectionsNotEmpty.length &&
      !wrongScript,
    missingSections,
    missingFacts,
    forbidden,
    sectionsNotEmpty,
    wrongScript,
  };
}
