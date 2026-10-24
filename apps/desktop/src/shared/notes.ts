// Scratchpad notes (Stage 9B): plain text kept in the local SQLite database, never in logs.
// Shared by the main process (storage, IPC validation, AI prompts) and both renderers.
import { z } from "zod";

/** Upper bound for one note (about 200,000 words); the editor stays responsive well past it. */
export const NOTE_MAX_CHARS = 1_000_000;
export const NOTE_TITLE_MAX = 120;

export interface Note {
  id: string;
  /** Set by renaming; null shows the first line instead. */
  title: string | null;
  body: string;
  createdAt: number;
  updatedAt: number;
  openedAt: number;
  /** Increases on every save; a save based on an older revision is refused. */
  revision: number;
}

export interface NoteSummary {
  id: string;
  title: string;
  /** The first lines after the title, for the Recents list. */
  preview: string;
  updatedAt: number;
}

const firstLine = (body: string) =>
  body
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean) ?? "";

/** The explicit title, else the first non-empty line (up to 60 characters), else "Untitled". */
export function noteTitle(note: Pick<Note, "title" | "body">): string {
  if (note.title?.trim()) return note.title.trim();
  const line = firstLine(note.body);
  if (!line) return "Untitled";
  return line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line;
}

export function notePreview(note: Pick<Note, "title" | "body">): string {
  const lines = note.body
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // Without an explicit title the first line is the title; don't repeat it.
  const rest = note.title?.trim() ? lines : lines.slice(1);
  const text = rest.join(" ");
  return text.length > 140 ? `${text.slice(0, 139).trimEnd()}…` : text;
}

export function countNoteWords(body: string): number {
  return (body.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
}

export function summarize(note: Note): NoteSummary {
  return {
    id: note.id,
    title: noteTitle(note),
    preview: notePreview(note),
    updatedAt: note.updatedAt,
  };
}

/** A file name for Export: the title without characters macOS or other systems reject. */
export function exportFileName(note: Pick<Note, "title" | "body">): string {
  const base = noteTitle(note)
    .replace(/…$/, "")
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${base || "Untitled"}.txt`;
}

// ---- IPC payloads (validated in the main process) ------------------------------------------------

export const NoteIdSchema = z.object({ id: z.string().min(1).max(64) });
export const NoteCreateSchema = z.object({
  body: z.string().max(NOTE_MAX_CHARS),
});
export const NoteSaveSchema = z.object({
  id: z.string().min(1).max(64),
  body: z.string().max(NOTE_MAX_CHARS),
  revision: z.number().int().min(1),
});
export const NoteRenameSchema = z.object({
  id: z.string().min(1).max(64),
  /** Empty clears the title (the first line shows again). */
  title: z.string().max(NOTE_TITLE_MAX),
});
export const NoteDeleteSchema = z.object({
  id: z.string().min(1).max(64),
  confirm: z.literal(true),
});
export const NoteSearchSchema = z.object({
  search: z.string().max(200).optional(),
});
export const NoteAiCancelSchema = z.object({
  requestId: z.string().min(1).max(64),
});
export const NoteCopySchema = z.object({
  text: z.string().max(NOTE_MAX_CHARS),
});

export type SaveResult =
  | { ok: true; note: Note }
  | { ok: false; reason: "conflict"; note: Note }
  | { ok: false; reason: "missing" };
