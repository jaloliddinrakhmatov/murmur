// Vibe coding in the dictation pipeline (Settings → Vibe coding). Both features are off by
// default and work only in VS Code, Cursor and Windsurf. Nothing read is logged beyond counts or
// kept beyond the dictation (identifiers) and a minute (file names).
import {
  applyIdentifiers,
  identifiersIn,
  tagFileMentions,
  type Identifier,
} from "@murmur/text";
import { isVibeEditor } from "../../shared/vibe-apps.ts";
import { WorkspaceFiles, type WorkspaceFs } from "./workspace.ts";

export interface VibeDeps {
  settings: () => { fileTagging: boolean; variables: boolean };
  /** Secure input, Murmur itself, a terminal or a password manager in front. */
  readingBlocked: () => boolean;
  /** native.readTextAround at the cursor. */
  readAround: (
    before: number,
    after: number,
  ) => { ok: boolean; isSecure: boolean; text?: string };
  windowTitle: () => string | null;
  log: (event: string, data: Record<string, unknown>) => void;
  fs?: WorkspaceFs;
}

export class VibeCoding {
  private identifiers: Identifier[] = [];
  private readonly files: WorkspaceFiles;
  private readonly deps: VibeDeps;

  constructor(deps: VibeDeps) {
    this.deps = deps;
    this.files = new WorkspaceFiles({
      windowTitle: () => (deps.readingBlocked() ? null : deps.windowTitle()),
      fs: deps.fs,
    });
  }

  /** After the microphone opens: identifiers near the cursor (as spelling hints) and file names. */
  begin(bundleId: string | null): string[] {
    this.identifiers = [];
    if (!isVibeEditor(bundleId)) return [];
    const s = this.deps.settings();
    if (s.fileTagging) this.files.begin(bundleId);
    if (!s.variables || this.deps.readingBlocked()) return [];
    try {
      const r = this.deps.readAround(600, 200);
      if (!r.ok || r.isSecure || !r.text) return [];
      this.identifiers = identifiersIn(r.text);
      this.deps.log("vibe.identifiers", { count: this.identifiers.length });
      return this.identifiers.map((i) => i.name);
    } catch {
      return [];
    }
  }

  /** The dictated text with spoken identifiers and file names written as in the editor. */
  async apply(text: string, bundleId: string | null): Promise<string> {
    const s = this.deps.settings();
    if (!isVibeEditor(bundleId) || !text) return text;
    let out = text;
    if (s.variables) out = applyIdentifiers(out, this.identifiers);
    if (s.fileTagging && !this.deps.readingBlocked()) {
      const names = await this.files.names();
      out = tagFileMentions(out, names);
      this.deps.log("vibe.files", { names: names.length });
    }
    return out;
  }

  /** The dictation is over: nothing is kept. */
  end(): void {
    this.identifiers = [];
    this.files.names(0).catch(() => {});
  }
}
