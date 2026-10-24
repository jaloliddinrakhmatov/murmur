// Dictation into the Scratchpad note window (Stage 9B). Murmur's own windows are normally not a
// paste target (the text is copied instead), but the note window is a text editor: when it was
// focused at release and still is, the text goes straight into the note at the cursor through
// IPC — no clipboard, no ⌘V. Anything else (another app, the Hub, focus moved away during
// transcription, the window not answering) goes through the normal inserter unchanged.
import type { Inserter, InsertOutcome, TargetSnapshot } from "../core/types.ts";

export interface NoteTarget {
  /** True when the note window has been focused, without interruption, since `takenAt`. */
  acceptsDictation(takenAt: number): boolean;
  /** Inserts at the editor's cursor (replacing a selection); false when it couldn't. */
  insert(text: string): Promise<boolean>;
}

export class ScratchpadAwareInserter implements Inserter {
  private readonly inner: Inserter;
  private readonly note: NoteTarget;
  private readonly ownPid: number;
  private readonly secureNow: () => boolean;
  private readonly log: (event: string, data?: Record<string, unknown>) => void;

  constructor(
    inner: Inserter,
    note: NoteTarget,
    log: ScratchpadAwareInserter["log"],
    /** Secure Event Input right now (a password prompt took the keyboard). */
    secureNow: () => boolean = () => false,
    ownPid = process.pid,
  ) {
    this.inner = inner;
    this.note = note;
    this.log = log;
    this.secureNow = secureNow;
    this.ownPid = ownPid;
  }

  async insert(text: string, target: TargetSnapshot): Promise<InsertOutcome> {
    // Secure input (at release or now) goes to the normal inserter, which refuses it.
    if (target.pid !== this.ownPid || target.secure || this.secureNow())
      return this.inner.insert(text, target);
    if (!this.note.acceptsDictation(target.takenAt))
      return this.inner.insert(text, target);
    const ok = await this.note.insert(text).catch(() => false);
    this.log("insert.scratchpad", { ok });
    if (ok) return { strategy: "direct" };
    return this.inner.insert(text, target);
  }
}
