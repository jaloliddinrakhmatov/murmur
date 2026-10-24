// Scratchpad editor logic (Stage 9B), kept out of the components so it can be unit-tested:
// autosave (debounced, one save at a time, creates the note on its first text, never
// overwrites a newer saved copy), text insertion at the cursor, and tab bookkeeping.
import type { Note, SaveResult } from "../../../shared/notes.ts";

export interface NoteStore {
  create(body: string): Promise<Note>;
  save(id: string, body: string, revision: number): Promise<SaveResult>;
}

/** "unsaved": waiting for the pause after typing; "conflict": the saved copy is newer. */
export type SaveState =
  "empty" | "saved" | "unsaved" | "saving" | "error" | "conflict";

export interface AutosaverOptions {
  delayMs?: number;
  retryMs?: number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  onState?: (
    state: SaveState,
    detail: { note: Note | null; error?: string },
  ) => void;
}

/**
 * One per open note. `change` is called on every edit; the text is saved after a short pause,
 * and at once by `flush` (closing a tab, hiding the window, before an AI edit is applied).
 */
export class Autosaver {
  private readonly store: NoteStore;
  private readonly delayMs: number;
  private readonly retryMs: number;
  private readonly schedule: NonNullable<AutosaverOptions["schedule"]>;
  private readonly cancel: NonNullable<AutosaverOptions["cancel"]>;
  private readonly onState: NonNullable<AutosaverOptions["onState"]>;
  private note: Note | null;
  private body: string;
  private timer: unknown = null;
  private inFlight: Promise<void> | null = null;
  private state: SaveState;
  private conflictNote: Note | null = null;

  constructor(
    store: NoteStore,
    note: Note | null,
    options: AutosaverOptions = {},
  ) {
    this.store = store;
    this.note = note;
    this.body = note?.body ?? "";
    this.delayMs = options.delayMs ?? 400;
    this.retryMs = options.retryMs ?? 3000;
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel =
      options.cancel ??
      ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.onState = options.onState ?? (() => {});
    this.state = note ? "saved" : "empty";
  }

  get id(): string | null {
    return this.note?.id ?? null;
  }

  get current(): Note | null {
    return this.note;
  }

  get status(): SaveState {
    return this.state;
  }

  /** True while the latest text isn't stored yet. */
  get dirty(): boolean {
    return this.note ? this.body !== this.note.body : this.body.trim() !== "";
  }

  private set(state: SaveState, error?: string) {
    this.state = state;
    this.onState(state, { note: this.note, error });
  }

  change(body: string): void {
    this.body = body;
    if (this.state === "conflict") return;
    if (!this.dirty) {
      this.clearTimer();
      if (!this.inFlight) this.set(this.note ? "saved" : "empty");
      return;
    }
    this.set("unsaved");
    this.arm(this.delayMs);
  }

  /** Saves now (if anything changed) and waits until it is stored or has failed. */
  async flush(): Promise<void> {
    this.clearTimer();
    while (this.inFlight) await this.inFlight;
    if (this.dirty && this.state !== "conflict") await this.run();
  }

  /** After a conflict: keep the text on screen, saved on top of the newer copy. */
  async keepMine(): Promise<void> {
    if (!this.conflictNote) return;
    this.note = this.conflictNote;
    this.conflictNote = null;
    this.set("unsaved");
    await this.flush();
  }

  /** After a conflict: show the saved copy instead; returns its text. */
  useSaved(): string {
    if (this.conflictNote) {
      this.note = this.conflictNote;
      this.conflictNote = null;
    }
    this.body = this.note?.body ?? "";
    this.set(this.note ? "saved" : "empty");
    return this.body;
  }

  /** The note was renamed elsewhere: take the new title, keep the revision. */
  adopt(note: Note): void {
    if (
      this.note &&
      note.id === this.note.id &&
      note.revision === this.note.revision
    )
      this.note = {
        ...this.note,
        title: note.title,
        updatedAt: note.updatedAt,
      };
  }

  dispose(): void {
    this.clearTimer();
  }

  private clearTimer() {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
  }

  private arm(ms: number) {
    this.clearTimer();
    this.timer = this.schedule(() => {
      this.timer = null;
      if (this.inFlight) return; // run() re-arms when the save in flight ends
      if (!this.dirty) return; // a flush() stored this text while the timer waited
      void this.run();
    }, ms);
  }

  private run(): Promise<void> {
    const body = this.body;
    const task = (async () => {
      this.set("saving");
      try {
        if (!this.note) {
          this.note = await this.store.create(body);
        } else {
          const r = await this.store.save(
            this.note.id,
            body,
            this.note.revision,
          );
          if (!r.ok) {
            if (r.reason === "conflict") {
              this.conflictNote = r.note;
              this.set("conflict");
            } else this.set("error", NOTE_DELETED_ERROR);
            return;
          }
          this.note = r.note;
        }
        if (this.dirty) {
          this.set("unsaved");
          this.arm(this.delayMs);
        } else this.set("saved");
      } catch (e) {
        this.set("error", e instanceof Error ? e.message : String(e));
        this.arm(this.retryMs);
      }
    })();
    this.inFlight = task;
    void task.finally(() => {
      if (this.inFlight === task) this.inFlight = null;
    });
    return task;
  }
}

/** The save error for a note that no longer exists; nothing retries it. */
export const NOTE_DELETED_ERROR = "This note was deleted";

/** One sentence for a failed save: a deleted note is not retried, other failures are. */
export function saveErrorText(error: string | undefined): string {
  const reason = (error ?? "").trim().replace(/[.…]+$/, "");
  if (reason === NOTE_DELETED_ERROR)
    return "Not saved: this note was deleted. Copy your text if you want to keep it.";
  return `Not saved: ${reason || "unknown error"}. Murmur will try again.`;
}

export function saveStateLabel(state: SaveState): string {
  switch (state) {
    case "empty":
      return "";
    case "saved":
      return "Saved";
    case "unsaved":
    case "saving":
      return "Saving…";
    case "error":
      return "Not saved";
    case "conflict":
      return "Changed elsewhere";
  }
}

/**
 * Text for inserting dictation at the cursor: a space is added where the words would otherwise
 * run into the text before or after them; a selection is replaced.
 */
export function spacedInsertion(
  value: string,
  start: number,
  end: number,
  text: string,
): string {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const word = /[\p{L}\p{N}]/u;
  let out = text;
  const prev = before.at(-1);
  if (
    prev &&
    !/\s/.test(prev) &&
    !/[([{"'“‘/-]/.test(prev) &&
    word.test(out[0] ?? "")
  )
    out = ` ${out}`;
  const next = after[0];
  if (next && word.test(next) && !/\s$/.test(out)) out = `${out} `;
  return out;
}

/** Replaces [start, end) and returns the new text and the cursor after the inserted part. */
export function replaceRange(
  value: string,
  start: number,
  end: number,
  text: string,
): { value: string; cursor: number } {
  return {
    value: value.slice(0, start) + text + value.slice(end),
    cursor: start + text.length,
  };
}

export interface TabLike {
  key: string;
}

/** The tab to show after closing `key`: the one to its right, else to its left. */
export function nextActiveTab<T extends TabLike>(
  tabs: T[],
  closing: string,
  active: string,
): string | null {
  if (closing !== active) return active;
  const i = tabs.findIndex((t) => t.key === closing);
  const rest = tabs.filter((t) => t.key !== closing);
  if (!rest.length) return null;
  return rest[Math.min(i, rest.length - 1)].key;
}

/** Route in the note window's address: "#note/<id>" or "#new". */
export function parseNoteRoute(
  hash: string,
): { id: string } | { new: true } | { resume: true } {
  const h = hash.replace(/^#/, "");
  if (h === "new") return { new: true };
  const m = /^note\/([\w-]{1,64})$/.exec(h);
  return m ? { id: m[1] } : { resume: true };
}

/** Relative time for Recents: "Just now", "5 min ago", "Yesterday", or a date. */
export function noteWhen(ts: number, now: Date): string {
  const diff = now.getTime() - ts;
  if (diff < 60_000) return "Just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  const d = new Date(ts);
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay)
    return d.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}
