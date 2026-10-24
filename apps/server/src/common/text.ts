/**
 * User-chosen text (names) placed in an email body: control and format characters removed,
 * whitespace collapsed, length limited. Subjects never contain user text at all.
 */
export function plainForEmail(text: string, max = 40): string {
  const clean = text
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...clean];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : clean;
}
