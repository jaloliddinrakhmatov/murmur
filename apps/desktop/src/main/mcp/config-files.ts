// Adding Murmur to another app's MCP config file (Claude Desktop, Cursor) and taking it out
// again. The file is changed only by merging one entry named "murmur" into `mcpServers`: other
// servers and other keys stay as they are, the original indentation is kept, and a timestamped
// backup copy is made before every write. Pure over paths, so tests use temp folders; the app
// passes the real home folder only after the person confirmed.
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  MCP_APP_LABELS,
  MCP_SERVER_NAME,
  type McpAppKind,
} from "../../shared/mcp.ts";

/** A problem the person can act on; the message is shown as is. */
export class ConfigFileError extends Error {}

export interface ConfigTarget {
  kind: McpAppKind;
  label: string;
  /** The app's settings folder: if it is missing, the app isn't installed. */
  dir: string;
  file: string;
}

export function configTarget(kind: McpAppKind, home: string): ConfigTarget {
  const dir =
    kind === "claude"
      ? join(home, "Library", "Application Support", "Claude")
      : join(home, ".cursor");
  return {
    kind,
    label: MCP_APP_LABELS[kind],
    dir,
    file: join(
      dir,
      kind === "claude" ? "claude_desktop_config.json" : "mcp.json",
    ),
  };
}

/** What a stdio client runs: Murmur's own program as a bridge to the running app. */
export interface Launch {
  command: string;
  args: string[];
}

export interface Connection {
  url: string;
  token: string;
  launch: Launch;
}

export const URL_ENV = "MURMUR_MCP_URL";
export const TOKEN_ENV = "MURMUR_MCP_TOKEN";

/**
 * The entry for each app. Cursor talks HTTP to the app directly (url + headers). Claude
 * Desktop's config file only runs local programs (remote servers are added in its own settings,
 * from Anthropic's cloud, which can't reach this Mac), so it runs Murmur's `--mcp-stdio` bridge.
 */
export function serverEntry(
  kind: McpAppKind,
  c: Connection,
): Record<string, unknown> {
  return kind === "cursor"
    ? { url: c.url, headers: { Authorization: `Bearer ${c.token}` } }
    : {
        command: c.launch.command,
        args: c.launch.args,
        env: { [URL_ENV]: c.url, [TOKEN_ENV]: c.token },
      };
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

interface Parsed {
  root: Json;
  /** Leading whitespace of one indentation level. */
  indent: string;
  newline: boolean;
}

function read(target: ConfigTarget): Parsed | null {
  let text: string;
  try {
    text = readFileSync(target.file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ConfigFileError(
      `Couldn't read ${target.label}'s config file. Nothing was changed.`,
    );
  }
  let root: unknown = {};
  if (text.trim()) {
    try {
      root = JSON.parse(text);
    } catch {
      throw new ConfigFileError(
        `${target.label}'s config file isn't valid JSON, so Murmur left it alone. Fix or remove it, then try again.`,
      );
    }
  }
  if (!isObject(root))
    throw new ConfigFileError(
      `${target.label}'s config file isn't a JSON object, so Murmur left it alone.`,
    );
  return {
    root,
    indent: /^([ \t]+)\S/m.exec(text)?.[1] ?? "  ",
    newline: text.endsWith("\n") || !text.trim(),
  };
}

export interface ConfigState {
  installed: boolean;
  fileExists: boolean;
  added: boolean;
}

/** Never throws: an unreadable file just reads as "not added". */
export function inspect(target: ConfigTarget): ConfigState {
  const installed = isDir(target.dir);
  try {
    const parsed = read(target);
    const servers = parsed?.root.mcpServers;
    return {
      installed,
      fileExists: parsed !== null,
      added: isObject(servers) && MCP_SERVER_NAME in servers,
    };
  } catch {
    return { installed, fileExists: existsSync(target.file), added: false };
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function requireInstalled(target: ConfigTarget): void {
  if (!isDir(target.dir))
    throw new ConfigFileError(
      `${target.label} doesn't seem to be installed (no ${target.dir} folder), so there is nothing to add Murmur to.`,
    );
}

/** The name of the backup copy: the file's name plus the time, e.g. mcp.json.20261020-101500.bak. */
export function backupName(file: string, at: number): string {
  const stamp = new Date(at)
    .toISOString()
    .replace(/\.\d+Z$/, "")
    .replace(/[-:]/g, "")
    .replace("T", "-");
  return `${file}.${stamp}.bak`;
}

/** Murmur keeps this many backup copies of one config file; older ones are deleted. */
export const MAX_BACKUPS = 5;

/**
 * The file that is really written. A config file that is a symbolic link (dotfiles managers do
 * this) is written through to its target; the link itself is never replaced.
 */
function realFile(target: ConfigTarget): string {
  try {
    return realpathSync(target.file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    let link = false;
    try {
      link = lstatSync(target.file).isSymbolicLink();
    } catch {
      // Not there at all: a new file.
    }
    if (link)
      throw new ConfigFileError(
        `${target.label}'s config file is a link to a file that doesn't exist, so Murmur left it alone.`,
      );
    return target.file;
  }
}

/** Murmur-made backups of this file, oldest first. */
function backupsOf(file: string): string[] {
  const prefix = `${basename(file)}.`;
  try {
    return readdirSync(dirname(file))
      .filter(
        (f) =>
          f.startsWith(prefix) &&
          /^\d{8}-\d{6}(-\d+)?\.bak$/.test(f.slice(prefix.length)),
      )
      .sort()
      .map((f) => join(dirname(file), f));
  } catch {
    return [];
  }
}

/**
 * A private copy of the file as it is now (it may hold a live token). An identical backup that
 * is already there is reused, and only the newest MAX_BACKUPS are kept.
 */
function backup(file: string, at: number): string | null {
  if (!existsSync(file)) return null;
  const content = readFileSync(file);
  const same = backupsOf(file).find((b) => {
    try {
      return readFileSync(b).equals(content);
    } catch {
      return false;
    }
  });
  if (same) {
    chmodSync(same, 0o600);
    return same;
  }
  let path = backupName(file, at);
  for (let n = 2; existsSync(path); n++)
    path = backupName(file, at).replace(/\.bak$/, `-${n}.bak`);
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
  for (const old of backupsOf(file).slice(0, -MAX_BACKUPS))
    rmSync(old, { force: true });
  return path;
}

/**
 * Removes Murmur's entry from Murmur's own backups of the file, so no copy of its token is left
 * lying around. Returns how many backups had one. Backups that aren't valid JSON are left alone.
 */
export function stripBackups(target: ConfigTarget): number {
  const file = realFile(target);
  let stripped = 0;
  for (const b of backupsOf(file)) {
    try {
      const text = readFileSync(b, "utf8");
      const root = JSON.parse(text) as unknown;
      const servers = isObject(root) ? root.mcpServers : undefined;
      if (
        !isObject(root) ||
        !isObject(servers) ||
        !(MCP_SERVER_NAME in servers)
      )
        continue;
      const { [MCP_SERVER_NAME]: _gone, ...rest } = servers;
      const indent = /^([ \t]+)\S/m.exec(text)?.[1] ?? "  ";
      writeFileSync(
        b,
        JSON.stringify({ ...root, mcpServers: rest }, null, indent) +
          (text.endsWith("\n") ? "\n" : ""),
        { mode: 0o600 },
      );
      chmodSync(b, 0o600);
      stripped++;
    } catch {
      // Unreadable or not JSON: not ours to change.
    }
  }
  return stripped;
}

/** How many of Murmur's backups still hold a "murmur" entry (shown before Remove). */
export function backupsWithEntry(target: ConfigTarget): number {
  let n = 0;
  try {
    for (const b of backupsOf(realFile(target))) {
      const root = JSON.parse(readFileSync(b, "utf8")) as unknown;
      const servers = isObject(root) ? root.mcpServers : undefined;
      if (isObject(servers) && MCP_SERVER_NAME in servers) n++;
    }
  } catch {
    // Counting only.
  }
  return n;
}

function serialize(p: Parsed): string {
  return JSON.stringify(p.root, null, p.indent) + (p.newline ? "\n" : "");
}

/** Writes through links, always private (0600) because the file may hold a token. */
function write(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.murmur-tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

export interface ConfigWrite {
  configPath: string;
  backupPath: string | null;
  changed: boolean;
}

/** Adds (or replaces) the "murmur" entry. Everything else in the file is kept. */
export function addEntry(
  target: ConfigTarget,
  entry: Record<string, unknown>,
  at: number = Date.now(),
): ConfigWrite {
  requireInstalled(target);
  const parsed = read(target) ?? { root: {}, indent: "  ", newline: true };
  const servers = parsed.root.mcpServers;
  if (servers !== undefined && !isObject(servers))
    throw new ConfigFileError(
      `${target.label}'s "mcpServers" isn't an object, so Murmur left the file alone.`,
    );
  const file = realFile(target);
  const before = existsSync(file) ? readFileSync(file, "utf8") : null;
  parsed.root.mcpServers = { ...(servers ?? {}), [MCP_SERVER_NAME]: entry };
  const text = serialize(parsed);
  if (before === text) {
    chmodSync(file, 0o600);
    return { configPath: target.file, backupPath: null, changed: false };
  }
  const backupPath = backup(file, at);
  write(file, text);
  return { configPath: target.file, backupPath, changed: true };
}

/** Removes the "murmur" entry; a file without it is left untouched (no backup, no write). */
export function removeEntry(
  target: ConfigTarget,
  at: number = Date.now(),
): ConfigWrite {
  const parsed = read(target);
  const servers = parsed?.root.mcpServers;
  if (!parsed || !isObject(servers) || !(MCP_SERVER_NAME in servers))
    return { configPath: target.file, backupPath: null, changed: false };
  const file = realFile(target);
  const backupPath = backup(file, at);
  const { [MCP_SERVER_NAME]: _removed, ...rest } = servers;
  parsed.root.mcpServers = rest;
  write(file, serialize(parsed));
  return { configPath: target.file, backupPath, changed: true };
}
