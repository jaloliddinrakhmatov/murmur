// What the MCP server can do: three read-only tools over Notetaker meetings. Pure functions over
// a small port, so they are tested against a temp database. Output is size-capped, and every cut
// says so (`truncated`, `totalChars`, `nextOffset`).
import { searchKey } from "../../shared/search.ts";
import type { Meeting } from "../../shared/meetings.ts";

export const LIST_DEFAULT = 20;
export const LIST_MAX = 50;
export const SNIPPET_CHARS = 240;
export const NOTES_CAP = 30_000;
export const SUMMARY_CAP = 20_000;
export const TRANSCRIPT_CAP = 100_000;

/** The part of MeetingRepo the tools use. */
export interface MeetingsPort {
  find(q: {
    search?: string;
    from?: number;
    to?: number;
    limit: number;
    offset: number;
  }): { rows: Meeting[]; total: number };
  get(id: string): Meeting | null;
}

export interface ListArgs {
  limit?: number;
  offset?: number;
  /** ISO date or date-time; a plain date means that day in the Mac's time zone. */
  from?: string;
  to?: string;
}

export interface SearchArgs extends ListArgs {
  query: string;
}

export interface GetArgs {
  id: string;
  /** Where to continue reading a transcript that was cut (the previous `nextOffset`). */
  transcriptOffset?: number;
}

/** A user-facing error: the message is safe to show the AI app. */
export class ToolError extends Error {}

const iso = (ms: number | null) =>
  ms === null ? null : new Date(ms).toISOString();

/** A date ("2026-10-01") or date-time; `end` makes a plain date mean the end of that day. */
export function parseWhen(value: string, end: boolean): number {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const ms = day
    ? end
      ? new Date(+day[1], +day[2] - 1, +day[3], 23, 59, 59, 999).getTime()
      : new Date(+day[1], +day[2] - 1, +day[3]).getTime()
    : Date.parse(value);
  if (!Number.isFinite(ms))
    throw new ToolError(
      `"${value.slice(0, 40)}" isn't a date. Use 2026-10-01 or 2026-10-01T09:30:00Z.`,
    );
  return ms;
}

function page(args: ListArgs) {
  const limit = Math.min(
    Math.max(Math.trunc(args.limit ?? LIST_DEFAULT), 1),
    LIST_MAX,
  );
  const offset = Math.max(Math.trunc(args.offset ?? 0), 0);
  const from =
    args.from === undefined ? undefined : parseWhen(args.from, false);
  const to = args.to === undefined ? undefined : parseWhen(args.to, true);
  if (from !== undefined && to !== undefined && to < from)
    throw new ToolError("`to` is before `from`.");
  return { limit, offset, from, to };
}

function head(m: Meeting) {
  return {
    id: m.id,
    title: m.title,
    startedAt: iso(m.startedAt),
    endedAt: iso(m.endedAt),
    createdAt: iso(m.createdAt),
    status: m.status,
    hasNotes: m.notes.trim().length > 0,
    hasTranscript: m.transcript.trim().length > 0,
    hasSummary: m.summary.trim().length > 0,
  };
}

export function listMeetings(port: MeetingsPort, args: ListArgs) {
  const p = page(args);
  const { rows, total } = port.find(p);
  return paged(rows.map(head), total, p);
}

function paged<T>(
  meetings: T[],
  total: number,
  p: { limit: number; offset: number },
) {
  const next = p.offset + meetings.length;
  return {
    total,
    offset: p.offset,
    count: meetings.length,
    nextOffset: next < total ? next : null,
    meetings,
  };
}

/** About SNIPPET_CHARS of `text` around the first match of `key`, or null when not in it. */
function snippet(text: string, key: string): string | null {
  const pattern = key
    .split(" ")
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  const norm = text.normalize("NFC");
  const at = new RegExp(pattern, "iu").exec(norm)?.index;
  if (at === undefined) return null;
  const start = Math.max(0, at - Math.floor(SNIPPET_CHARS / 3));
  const piece = norm
    .slice(start, start + SNIPPET_CHARS)
    .replace(/\s+/g, " ")
    .trim();
  return `${start > 0 ? "…" : ""}${piece}${start + SNIPPET_CHARS < norm.length ? "…" : ""}`;
}

export function searchMeetings(port: MeetingsPort, args: SearchArgs) {
  const query = args.query.trim();
  if (!query) throw new ToolError("`query` is empty.");
  const p = page(args);
  const key = searchKey(query);
  const { rows, total } = port.find({ ...p, search: query });
  return paged(
    rows.map((m) => {
      const fields = [
        ["title", m.title],
        ["notes", m.notes],
        ["transcript", m.transcript],
        ["summary", m.summary],
      ] as const;
      const matches = fields.flatMap(([name, text]) => {
        const s = snippet(text, key);
        return s === null ? [] : [{ in: name, snippet: s }];
      });
      return { ...head(m), matches };
    }),
    total,
    p,
  );
}

function section(text: string, cap: number, offset = 0) {
  const slice = text.slice(offset, offset + cap);
  const end = offset + slice.length;
  return {
    text: slice,
    totalChars: text.length,
    offset,
    truncated: end < text.length,
    nextOffset: end < text.length ? end : null,
  };
}

export function getMeeting(port: MeetingsPort, args: GetArgs) {
  const m = port.get(args.id);
  if (!m) throw new ToolError("No meeting has that id. Use list_meetings.");
  const offset = Math.max(Math.trunc(args.transcriptOffset ?? 0), 0);
  return {
    ...head(m),
    language:
      m.language === null ? "dictation language" : m.language || "automatic",
    recordedMinutes: Math.round(m.recordedMs / 60_000),
    notes: section(m.notes, NOTES_CAP),
    transcript: section(m.transcript, TRANSCRIPT_CAP, offset),
    summary: section(m.summary, SUMMARY_CAP),
  };
}
