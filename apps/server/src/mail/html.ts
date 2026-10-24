const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ESCAPES[c]);

/**
 * A minimal HTML version of a plain-text email: every paragraph escaped, and `highlight` (the
 * code the reader must copy) shown large and selectable. No links, images or scripts.
 */
export function renderHtml(text: string, highlight?: string): string {
  const paragraphs = text.split(/\n{2,}/).map((p) => {
    const lines = p.split("\n").map((line) => {
      if (highlight && line.includes(highlight)) {
        const [before, ...rest] = line.split(highlight);
        return (
          escapeHtml(before) +
          rest
            .map(
              (after) =>
                `<span style="font-size:28px;font-weight:700;letter-spacing:3px;font-family:Menlo,Consolas,monospace">${escapeHtml(highlight)}</span>${escapeHtml(after)}`,
            )
            .join("")
        );
      }
      return escapeHtml(line);
    });
    return `<p style="margin:0 0 16px">${lines.join("<br>")}</p>`;
  });
  return `<!doctype html><html><body style="font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a">${paragraphs.join("")}</body></html>`;
}
