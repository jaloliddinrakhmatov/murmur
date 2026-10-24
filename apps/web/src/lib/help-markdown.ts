/**
 * A small, safe Markdown reader for help answers: paragraphs, bullet and numbered lists, bold,
 * italics, inline code, code blocks and links. It produces a plain data tree; the component turns
 * that into React elements, so no HTML is ever parsed or injected. Anything it does not know is
 * kept as plain text.
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "br" }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "link"; href: string; external: boolean; c: Inline[] };

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "ul"; items: Inline[][] }
  | { t: "ol"; start: number; items: Inline[][] }
  | { t: "pre"; v: string };

export type SafeHref = { href: string; external: boolean };

/** Only http(s) links and paths on this site (/x, /#faq) are links; everything else is not. */
export function safeHref(raw: string): SafeHref | null {
  const value = raw.trim();
  if (!value || /[\u0000-\u001f\u007f\s\\]/.test(value)) return null;
  if (value.startsWith("/")) {
    return value.startsWith("//") ? null : { href: value, external: false };
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.hostname) return null;
    return { href: url.href, external: true };
  } catch {
    return null;
  }
}

const MAX_DEPTH = 4;
const isAlnum = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);

function pushText(out: Inline[], v: string) {
  if (!v) return;
  const last = out[out.length - 1];
  if (last && last.t === "text") last.v += v;
  else out.push({ t: "text", v });
}

/** Finds the closing marker for an emphasis run that starts after `from`. */
function closer(s: string, marker: string, from: number): number {
  let i = from;
  while (i < s.length) {
    if (s[i] === "\\") {
      i += 2;
      continue;
    }
    if (s[i] === "`") {
      const end = s.indexOf("`", i + 1);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    if (s.startsWith(marker, i)) {
      const before = s[i - 1];
      const after = s[i + marker.length];
      const spaced = before === undefined || /\s/.test(before);
      const word = marker.startsWith("_") && isAlnum(after);
      if (!spaced && !word && !(marker.length === 1 && after === marker)) {
        return i;
      }
    }
    i++;
  }
  return -1;
}

export function parseInline(s: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\n") {
      out.push({ t: "br" });
      i++;
      continue;
    }
    if (
      c === "\\" &&
      i + 1 < s.length &&
      /[\\`*_[\]()#+\-.!>]/.test(s[i + 1])
    ) {
      pushText(out, s[i + 1]);
      i += 2;
      continue;
    }
    if (c === "`") {
      const end = s.indexOf("`", i + 1);
      if (end > i + 1) {
        out.push({ t: "code", v: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (depth < MAX_DEPTH && (c === "*" || c === "_")) {
      const double = s[i + 1] === c;
      const marker = double ? c + c : c;
      const next = s[i + marker.length];
      const startOk =
        next !== undefined &&
        !/\s/.test(next) &&
        !(c === "_" && isAlnum(s[i - 1]));
      if (startOk) {
        const end = closer(s, marker, i + marker.length + 1);
        if (end > i + marker.length) {
          const inner = parseInline(s.slice(i + marker.length, end), depth + 1);
          out.push(double ? { t: "strong", c: inner } : { t: "em", c: inner });
          i = end + marker.length;
          continue;
        }
      }
    }
    if (c === "[" && depth < MAX_DEPTH) {
      const m = /^\[([^\]\n]+)\]\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)\)/.exec(
        s.slice(i),
      );
      if (m) {
        const target = safeHref(m[2]);
        const label = parseInline(m[1], depth + 1);
        if (target) out.push({ t: "link", ...target, c: label });
        else out.push(...label);
        i += m[0].length;
        continue;
      }
    }
    if (
      (c === "h" || c === "H") &&
      !isAlnum(s[i - 1]) &&
      /^https?:\/\//i.test(s.slice(i, i + 8))
    ) {
      const m = /^https?:\/\/[^\s<>]*[^\s<>.,;:!?'")\]]/i.exec(s.slice(i));
      const target = m ? safeHref(m[0]) : null;
      if (m && target) {
        out.push({
          t: "link",
          ...target,
          c: [{ t: "text", v: m[0] }],
        });
        i += m[0].length;
        continue;
      }
    }
    pushText(out, c);
    i++;
  }
  return out;
}

const BULLET = /^\s{0,6}[-*•]\s+(.*)$/;
const NUMBER = /^\s{0,6}(\d{1,3})[.)]\s+(.*)$/;
const FENCE = /^\s{0,3}(```|~~~)/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;

/** Reads Markdown (possibly unfinished, while an answer is still streaming) into blocks. */
export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { kind: "ul" | "ol"; start: number; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ t: "p", c: parseInline(paragraph.join("\n")) });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((item) => parseInline(item));
    blocks.push(
      list.kind === "ul"
        ? { t: "ul", items }
        : { t: "ol", start: list.start, items },
    );
    list = null;
  };

  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    const fence = FENCE.exec(line);
    if (fence) {
      flushParagraph();
      flushList();
      const body: string[] = [];
      n++;
      while (n < lines.length && !lines[n].trimStart().startsWith(fence[1])) {
        body.push(lines[n]);
        n++;
      }
      blocks.push({ t: "pre", v: body.join("\n") });
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({
        t: "p",
        c: [{ t: "strong", c: parseInline(heading[1]) }],
      });
      continue;
    }
    const bullet = BULLET.exec(line);
    const number = bullet ? null : NUMBER.exec(line);
    if (bullet || number) {
      flushParagraph();
      const kind = bullet ? "ul" : "ol";
      if (list && list.kind !== kind) flushList();
      if (!list) {
        list = {
          kind,
          start: number ? Number(number[1]) : 1,
          items: [],
        };
      }
      list.items.push(bullet ? bullet[1] : number![2]);
      continue;
    }
    if (list && /^\s+\S/.test(line)) {
      list.items[list.items.length - 1] += `\n${line.trim()}`;
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return blocks;
}
