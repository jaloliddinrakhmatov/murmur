// Vibe coding: which file and workspace an editor window shows, and the names of the files in
// the workspace folder. Only the window title, the editor's list of recent folders and file
// NAMES are read (never file contents); the names are kept in memory only, for a minute.
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CODE_EXTENSIONS } from "@murmur/text";
import { editorSupportFolder } from "../../shared/vibe-apps.ts";

const APP_NAMES =
  /^(visual studio code( - insiders)?|vscodium|cursor|windsurf( next)?|code - insiders)$/i;

/** Most file names kept per workspace. */
export const MAX_FILES = 5000;
const MAX_DEPTH = 6;
const CACHE_MS = 60_000;
const MAX_WORKSPACES = 3;
const MAX_STORAGE_BYTES = 5_000_000;
const IGNORED_DIRS = new Set(
  "node_modules dist build out target coverage vendor pods deriveddata venv env __pycache__ bower_components".split(
    " ",
  ),
);

/**
 * “index.tsx — project — Cursor” → the open file and the folder name. The title's parts are
 * separated by “ — ”, “ – ” or “ - ”; the app name, “[…]” notes and unsaved marks are dropped.
 */
export function parseEditorTitle(title: string | null | undefined): {
  file: string | null;
  parts: string[];
} {
  if (!title) return { file: null, parts: [] };
  const parts = title
    .split(/\s[—–-]\s/u)
    .map((p) =>
      p
        .replace(/^[●•]\s*/u, "")
        .replace(/\s*\[[^\]]*\]\s*/gu, " ")
        .replace(/\s*\(Workspace\)$/iu, "")
        .trim(),
    )
    .filter((p) => p && !APP_NAMES.test(p));
  const first = parts[0] ?? "";
  const file =
    /^[^\s/\\]+\.([A-Za-z0-9]+)$/u.test(first) &&
    CODE_EXTENSIONS.has(first.split(".").pop()!.toLowerCase())
      ? first
      : null;
  return { file, parts };
}

/** Folder paths from an editor's storage.json (file:// URIs only), most recent first. */
export function folderPathsFromStorage(json: unknown): string[] {
  const uris: unknown[] = [];
  const o = (json ?? {}) as Record<string, any>;
  const win = o.windowsState ?? {};
  uris.push(win.lastActiveWindow?.folder);
  for (const w of Array.isArray(win.openedWindows) ? win.openedWindows : [])
    uris.push(w?.folder);
  for (const f of Array.isArray(o.backupWorkspaces?.folders)
    ? o.backupWorkspaces.folders
    : [])
    uris.push(f?.folderUri);
  for (const k of Object.keys(o.profileAssociations?.workspaces ?? {}))
    uris.push(k);
  const out: string[] = [];
  for (const u of uris) {
    if (typeof u !== "string" || !u.startsWith("file://")) continue;
    try {
      const p = fileURLToPath(u);
      if (!out.includes(p)) out.push(p);
    } catch {
      /* not a valid file URL */
    }
  }
  return out;
}

export interface WorkspaceFs {
  readStorage(supportFolder: string): Promise<unknown | null>;
  isDirectory(path: string): Promise<boolean>;
  /** Names of a directory's entries. */
  list(path: string): Promise<{ name: string; dir: boolean }[]>;
}

export const nodeWorkspaceFs: WorkspaceFs = {
  async readStorage(supportFolder) {
    try {
      const file = join(
        homedir(),
        "Library",
        "Application Support",
        supportFolder,
        "User",
        "globalStorage",
        "storage.json",
      );
      const s = await stat(file);
      if (s.size > MAX_STORAGE_BYTES) return null;
      return JSON.parse(await readFile(file, "utf8"));
    } catch {
      return null;
    }
  },
  async isDirectory(path) {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  },
  async list(path) {
    const entries = await readdir(path, { withFileTypes: true });
    // Symbolic links are never followed.
    return entries
      .filter((e) => e.isDirectory() || e.isFile())
      .map((e) => ({ name: e.name, dir: e.isDirectory() }));
  },
};

/** Workspace-relative paths of files with a known code extension (names only, bounded). */
export async function listFileNames(
  root: string,
  fs: WorkspaceFs,
  max = MAX_FILES,
): Promise<string[]> {
  const out: string[] = [];
  let level: string[] = [""];
  for (
    let depth = 0;
    depth <= MAX_DEPTH && level.length && out.length < max;
    depth++
  ) {
    const next: string[] = [];
    for (const rel of level) {
      let entries: { name: string; dir: boolean }[];
      try {
        entries = await fs.list(rel ? join(root, rel) : root);
      } catch {
        continue;
      }
      for (const e of entries) {
        if (out.length >= max) break;
        const path = rel ? `${rel}/${e.name}` : e.name;
        if (e.dir) {
          if (
            !e.name.startsWith(".") &&
            !IGNORED_DIRS.has(e.name.toLowerCase())
          )
            next.push(path);
        } else if (
          !e.name.startsWith(".") &&
          CODE_EXTENSIONS.has(e.name.split(".").pop()!.toLowerCase())
        )
          out.push(path);
      }
    }
    level = next;
  }
  return out;
}

/**
 * File names for the editor window in front, cached per workspace folder for a minute and
 * refreshed lazily. `begin` starts the work (call when a dictation starts); `names` returns what
 * is known, waiting at most `waitMs` for it.
 */
export class WorkspaceFiles {
  private cache = new Map<string, { at: number; files: string[] }>();
  private pending: Promise<string[]> | null = null;

  private readonly deps: {
    windowTitle: () => string | null;
    fs?: WorkspaceFs;
    now?: () => number;
  };

  constructor(deps: WorkspaceFiles["deps"]) {
    this.deps = deps;
  }

  begin(bundleId: string | null): void {
    this.pending = this.collect(bundleId).catch(() => []);
  }

  async names(waitMs = 400): Promise<string[]> {
    const p = this.pending;
    this.pending = null;
    if (!p) return [];
    return Promise.race([
      p,
      new Promise<string[]>((r) => setTimeout(() => r([]), waitMs).unref()),
    ]);
  }

  /** Drops everything held. */
  clear(): void {
    this.cache.clear();
    this.pending = null;
  }

  private async collect(bundleId: string | null): Promise<string[]> {
    const fs = this.deps.fs ?? nodeWorkspaceFs;
    const now = (this.deps.now ?? Date.now)();
    const { file, parts } = parseEditorTitle(this.deps.windowTitle());
    const open = file ? [file] : [];
    const support = editorSupportFolder(bundleId);
    if (!support || !parts.length) return open;
    const known = folderPathsFromStorage(await fs.readStorage(support));
    const root = known.find((p) => parts.includes(basename(p)));
    if (!root || !(await fs.isDirectory(root))) return open;
    let hit = this.cache.get(root);
    if (!hit || now - hit.at > CACHE_MS) {
      hit = { at: now, files: await listFileNames(root, fs) };
      this.cache.delete(root);
      this.cache.set(root, hit);
      while (this.cache.size > MAX_WORKSPACES)
        this.cache.delete(this.cache.keys().next().value!);
    }
    return [...open, ...hit.files];
  }
}
