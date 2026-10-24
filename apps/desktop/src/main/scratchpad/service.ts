// Scratchpad (Stage 9B): notes in the local database, Copy, Export and the AI edits. Every
// input from a renderer is validated here. Note text never reaches the log: only ids, sizes and
// outcomes. AI edits run only when the person picks one, on the text they chose.
import {
  NoteAiCancelSchema,
  NoteCopySchema,
  NoteCreateSchema,
  NoteDeleteSchema,
  NoteIdSchema,
  NoteRenameSchema,
  NoteSaveSchema,
  NoteSearchSchema,
  exportFileName,
  summarize,
  type Note,
  type NoteSummary,
  type SaveResult,
} from "../../shared/notes.ts";
import type { NoteRepo } from "../history/db.ts";
import type { AiStatus, TransformService } from "../transforms/service.ts";

export interface ScratchpadDeps {
  notes: NoteRepo;
  newId: () => string;
  openBehavior: () => "resume" | "new";
  /** Writes the clipboard and reads it back; false when the text didn't land. */
  copy: (text: string) => Promise<boolean>;
  /** AI edits go through Transforms (one AI path for the whole app). */
  transforms: TransformService;
  /** A native Save dialog; null when the person cancels. */
  chooseExportPath: (fileName: string) => Promise<string | null>;
  writeFile: (path: string, text: string) => Promise<void>;
  onChange: () => void;
  log?: (event: string, data?: Record<string, unknown>) => void;
  now?: () => number;
}

export class ScratchpadService {
  private readonly d: ScratchpadDeps;

  constructor(deps: ScratchpadDeps) {
    this.d = deps;
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  private log(event: string, data?: Record<string, unknown>): void {
    this.d.log?.(event, data);
  }

  list(input: unknown = {}): NoteSummary[] {
    const { search } = NoteSearchSchema.parse(input ?? {});
    return this.d.notes.summaries(search ?? "").map(summarize);
  }

  get(input: unknown): Note | null {
    const { id } = NoteIdSchema.parse(input);
    return this.d.notes.get(id);
  }

  /** Marks the note as the one to resume and returns it. */
  open(input: unknown): Note | null {
    const { id } = NoteIdSchema.parse(input);
    this.d.notes.markOpened(id, this.now());
    return this.d.notes.get(id);
  }

  /** What a newly opened Scratchpad shows: the last note, or nothing (a new note). */
  initial(): Note | null {
    return this.d.openBehavior() === "resume"
      ? this.d.notes.lastOpened()
      : null;
  }

  create(input: unknown): Note {
    const { body } = NoteCreateSchema.parse(input);
    const note = this.d.notes.create(this.d.newId(), body, this.now());
    this.log("note.created", { id: note.id, chars: body.length });
    this.d.onChange();
    return note;
  }

  save(input: unknown): SaveResult {
    const { id, body, revision } = NoteSaveSchema.parse(input);
    const r = this.d.notes.save(id, body, revision, this.now());
    if (!r.ok) this.log("note.save.refused", { id, reason: r.reason });
    else this.d.onChange();
    return r;
  }

  rename(input: unknown): Note {
    const { id, title } = NoteRenameSchema.parse(input);
    const note = this.d.notes.rename(id, title, this.now());
    if (!note) throw new Error("This note no longer exists.");
    this.d.onChange();
    return note;
  }

  delete(input: unknown): boolean {
    const { id } = NoteDeleteSchema.parse(input);
    const deleted = this.d.notes.delete(id);
    this.log("note.deleted", { id, deleted });
    if (deleted) this.d.onChange();
    return deleted;
  }

  /** Reset: every note. */
  deleteAll(): number {
    const n = this.d.notes.deleteAll();
    if (n) this.d.onChange();
    return n;
  }

  async copy(input: unknown): Promise<boolean> {
    const { text } = NoteCopySchema.parse(input);
    if (!text) return false;
    return this.d.copy(text);
  }

  /** Saves the note as a UTF-8 text file where the person chooses. */
  async export(input: unknown): Promise<{ saved: boolean; path?: string }> {
    const { id } = NoteIdSchema.parse(input);
    const note = this.d.notes.get(id);
    if (!note) throw new Error("This note no longer exists.");
    const path = await this.d.chooseExportPath(exportFileName(note));
    if (!path) return { saved: false };
    await this.d.writeFile(path, note.body);
    this.log("note.exported", { id, chars: note.body.length });
    return { saved: true, path };
  }

  aiStatus(): Promise<AiStatus> {
    return this.d.transforms.aiStatus();
  }

  /** The transforms the AI menu offers (Stage 9C: the same list as everywhere else). */
  transformsForMenu(): { id: string; name: string; description: string }[] {
    return this.d.transforms
      .list()
      .map(({ id, name, description }) => ({ id, name, description }));
  }

  /**
   * One AI edit on the given text, returned for the person to review; the note itself is never
   * changed here. `cancelAi` with the same request id stops it.
   */
  ai(input: unknown): Promise<{ text: string; name: string }> {
    return this.d.transforms.run(input);
  }

  cancelAi(input: unknown): boolean {
    const { requestId } = NoteAiCancelSchema.parse(input);
    return this.d.transforms.cancel(requestId);
  }
}
