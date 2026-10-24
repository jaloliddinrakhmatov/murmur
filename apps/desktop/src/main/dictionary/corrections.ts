// Auto-add to dictionary (Stage E part 2, System → Extras; off by default). After a dictation
// was pasted, Murmur locates it just before the cursor. Later (20 s on, or when the next
// dictation starts), if the same field still has the focus, it reads that stretch once and
// adds any word you re-spelled to your dictionary, with what it had heard as “misheard as”.
// Only the dictated stretch (plus a little after it) is read; nothing read is kept or logged.
import { correctedWords } from "@murmur/text";
import type { TargetSnapshot } from "../core/types.ts";
import { isNoReadApp } from "../../shared/sensitive-apps.ts";

export interface FieldRead {
  ok: boolean;
  pid?: number | null;
  isSecure: boolean;
  text?: string | null;
  start?: number | null;
  cursor?: number | null;
  elementKey?: string | null;
}

export interface CorrectionDeps {
  enabled: () => boolean;
  /**
   * Nothing may be read right now: Secure Event Input is on, or the app in front is Murmur
   * itself, a terminal or a password manager. (The field's own secure flag is checked too.)
   */
  blocked: () => boolean;
  /** Murmur's own process id: its windows are never read. */
  ownPid: number;
  /** native.readTextAround: a bounded window of the focused field. */
  read: (location: number | null, before: number, after: number) => FieldRead;
  /** True when the dictionary already has this phrase. */
  known: (phrase: string) => boolean;
  add: (phrase: string, misheardAs: string) => void;
  notify: (message: string) => void;
  log: (event: string, data?: Record<string, unknown>) => void;
  now: () => number;
  later: (ms: number, fn: () => void) => () => void;
}

/** ⌘V is posted, not awaited: give the app a moment to paste before looking. */
const LOCATE_AFTER_MS = 500;
const CHECK_AFTER_MS = 20_000;
const GIVE_UP_MS = 120_000;
/** Read a little past the dictation, in case a correction made it longer. */
const SLACK = 40;
/** Text read just before the dictation, to find it again if an earlier edit moved it. */
const CONTEXT = 30;
/** At most this many words are added automatically per day (per run of the app). */
export const MAX_AUTO_ADDS_PER_DAY = 5;

interface Watched {
  pid: number;
  elementKey: string;
  start: number;
  /** What stood right before the dictated stretch when it was located (may be empty). */
  context: string;
  text: string;
  until: number;
}

export class CorrectionWatcher {
  private readonly d: CorrectionDeps;
  private watched: Watched | null = null;
  private cancelTimer: (() => void) | null = null;
  private day = "";
  private addedToday = 0;

  constructor(deps: CorrectionDeps) {
    this.d = deps;
  }

  /** A dictation was pasted into `target`: once the app has taken the paste, find it. */
  inserted(text: string, target: TargetSnapshot): void {
    this.stop();
    if (!this.d.enabled() || target.secure || !text.trim()) return;
    if (
      (target.pid != null && target.pid === this.d.ownPid) ||
      isNoReadApp(target.appBundleId)
    )
      return;
    this.cancelTimer = this.d.later(LOCATE_AFTER_MS, () =>
      this.locate(text, target),
    );
  }

  /** The pasted text just before the cursor, in the same app. */
  private locate(text: string, target: TargetSnapshot): void {
    this.cancelTimer = null;
    if (this.d.blocked()) return;
    const r = this.d.read(null, text.length + CONTEXT, 0);
    if (
      !r.ok ||
      r.isSecure ||
      r.cursor == null ||
      r.pid == null ||
      r.pid === this.d.ownPid ||
      !r.elementKey
    )
      return;
    if (r.pid !== target.pid && target.pid) return;
    // The text before the cursor must be what was pasted, or there is nothing to watch.
    const read = r.text ?? "";
    if (!read.endsWith(text)) return;
    this.watched = {
      pid: r.pid,
      elementKey: r.elementKey,
      start: r.cursor - text.length,
      context: read.slice(
        Math.max(0, read.length - text.length - CONTEXT),
        -text.length,
      ),
      text,
      until: this.d.now() + GIVE_UP_MS,
    };
    this.cancelTimer = this.d.later(CHECK_AFTER_MS, () => this.check());
  }

  /** The next dictation is starting: check the previous one's field while it still has focus. */
  dictationStarting(): void {
    if (this.watched) this.check();
  }

  /** Reads the watched stretch if its field has the focus; adds re-spelled words. */
  check(): void {
    const w = this.watched;
    if (!w) return;
    if (!this.d.enabled() || this.d.now() > w.until) return this.stop();
    if (this.d.blocked()) return;
    // With text before the stretch, read around it and find it again by that text (an edit
    // earlier in the field moves it); without any, it sits at the start of what is read.
    const lead = w.context.length ? w.context.length + SLACK : 0;
    const r = this.d.read(
      Math.max(0, w.start - lead),
      0,
      lead + w.text.length + SLACK * (w.context.length ? 2 : 1),
    );
    // Another field or app in front: try again at the next dictation, until it expires.
    if (!r.ok || r.isSecure || r.pid !== w.pid || r.elementKey !== w.elementKey)
      return;
    this.stop();
    const added: string[] = [];
    const day = new Date(this.d.now()).toDateString();
    if (day !== this.day) {
      this.day = day;
      this.addedToday = 0;
    }
    const stretch = w.context.length
      ? this.relocate(w, r.text ?? "", Math.max(0, w.start - lead))
      : (r.text ?? "");
    // correctedWords already limits each word to a small edit distance from what was heard.
    for (const { heard, corrected } of stretch === null
      ? []
      : correctedWords(w.text, stretch)) {
      if (this.addedToday >= MAX_AUTO_ADDS_PER_DAY) break;
      if (isFragment(corrected, heard)) continue;
      if (this.d.known(corrected)) continue;
      try {
        this.d.add(corrected, heard);
        added.push(corrected);
        this.addedToday += 1;
      } catch {
        // A duplicate or invalid phrase: nothing to add.
      }
    }
    this.d.log("dictionary.auto-added", { count: added.length });
    if (added.length === 1) {
      const word =
        added[0].length > 20 ? `${added[0].slice(0, 19)}…` : added[0];
      this.d.notify(`Added “${word}” to your dictionary`);
    } else if (added.length > 1)
      this.d.notify(`Added ${added.length} words to your dictionary`);
  }

  /** The dictated stretch inside `read`, found after its context; null when that moved away. */
  private relocate(w: Watched, read: string, from: number): string | null {
    const expected = w.start - from - w.context.length;
    let best = -1;
    for (
      let i = read.indexOf(w.context);
      i >= 0;
      i = read.indexOf(w.context, i + 1)
    )
      if (best < 0 || Math.abs(i - expected) < Math.abs(best - expected))
        best = i;
    if (best < 0) return null;
    return read.slice(
      best + w.context.length,
      best + w.context.length + w.text.length + SLACK,
    );
  }

  stop(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.watched = null;
  }
}

/** A cut-off piece of the heard word ("bernetes" of "Kubernetes") is not a correction. */
function isFragment(corrected: string, heard: string): boolean {
  const c = corrected.toLowerCase();
  const h = heard.toLowerCase();
  return c.length < h.length && (h.startsWith(c) || h.endsWith(c));
}
