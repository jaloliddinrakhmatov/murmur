// Settings → MCP behind the Hub: starts and stops the local server with `settings.mcp`, keeps the
// clients, and adds Murmur to Claude Desktop's and Cursor's config files (only on the person's
// confirmed request). Off by default; nothing listens until it is turned on.
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings } from "../../shared/settings.ts";
import {
  MCP_APP_LABELS,
  MCP_PATH,
  McpAppSchema,
  McpClientIdSchema,
  McpCopySchema,
  McpNewClientSchema,
  McpRemoveSchema,
  type McpAppKind,
  type McpClientInfo,
  type McpConfigPreview,
  type McpConfigResult,
  type McpServerState,
  type McpStatus,
} from "../../shared/mcp.ts";
import { McpClients, type TokenVault } from "./clients.ts";
import {
  addEntry,
  backupsWithEntry,
  ConfigFileError,
  configTarget,
  inspect,
  removeEntry,
  serverEntry,
  stripBackups,
  type Launch,
} from "./config-files.ts";
import { buildExtension, EXTENSION_FILE } from "./extension.ts";
import { McpHttpServer } from "./server.ts";
import type { MeetingsPort } from "./tools.ts";

const HIDDEN = "mmr_•••• (hidden)";
const EXTENSION_DIR_PREFIX = "murmur-mcpb-";
/** How long the extension file may exist: long enough for Claude to read it, no longer. */
const EXTENSION_LIFETIME_MS = 10 * 60_000;

export interface McpServiceDeps {
  clientsFile: string;
  home: string;
  settings: { get(): Settings; onChange(cb: (s: Settings) => void): unknown };
  meetings: MeetingsPort;
  vault: TokenVault;
  /** Reads the saved secrets once the Keychain answers; false if it didn't. */
  unlock(): Promise<boolean>;
  launch(): Launch;
  /** Opens the extension file with Claude Desktop (Claude shows its own install screen). */
  openExtension(file: string): Promise<void>;
  /** Where the temporary extension folder goes (default: the system temp folder). */
  tempDir?: string;
  copy(text: string): void;
  notify(): void;
  version: string;
  log: (event: string, data?: Record<string, unknown>) => void;
  now?: () => number;
}

export class McpService {
  private state: McpServerState = "off";
  private running: Promise<void> = Promise.resolve();
  private readonly clients: McpClients;
  private readonly server: McpHttpServer;
  private port = 0;
  private readonly extensionDirs = new Map<string, NodeJS.Timeout>();
  private readonly d: McpServiceDeps;

  constructor(deps: McpServiceDeps) {
    this.d = deps;
    this.clients = new McpClients(deps.clientsFile, deps.vault, deps.now);
    this.server = new McpHttpServer({
      meetings: deps.meetings,
      tokens: () => this.clients.tokens(),
      onAccess: (id) => {
        this.clients.recordAccess(id);
        this.d.notify();
      },
      version: deps.version,
      log: deps.log,
    });
    deps.settings.onChange(() => void this.apply());
  }

  /** Brings the server in line with the settings (one change at a time). */
  apply(): Promise<void> {
    this.running = this.running.then(() => this.reconcile()).catch(() => {});
    return this.running;
  }

  private async reconcile(): Promise<void> {
    const { enabled, port } = this.d.settings.get().mcp;
    if (!enabled) {
      for (const folder of [...this.extensionDirs.keys()])
        this.dropExtension(folder);
      await this.server.stop();
      this.set("off");
      return;
    }
    if (this.server.listening && this.port === port) return;
    await this.server.stop();
    this.set("starting");
    if (!(await this.d.unlock())) return this.set("locked");
    try {
      this.port = await this.server.start(port);
      this.set("running");
      this.d.log("mcp.started", { port: this.port });
    } catch (err) {
      const busy = (err as NodeJS.ErrnoException).code === "EADDRINUSE";
      this.d.log("mcp.start-failed", {
        code: (err as NodeJS.ErrnoException).code,
      });
      this.set(busy ? "port-busy" : "error");
    }
  }

  private set(state: McpServerState): void {
    this.state = state;
    this.d.notify();
  }

  private url(): string {
    return `http://127.0.0.1:${this.d.settings.get().mcp.port}${MCP_PATH}`;
  }

  status(): McpStatus {
    const { enabled, port } = this.d.settings.get().mcp;
    return {
      enabled,
      state: enabled ? this.state : "off",
      port,
      url: this.url(),
      clients: this.clients.list(),
      apps: (["claude", "cursor"] as const).map((kind) => {
        const t = configTarget(kind, this.d.home);
        const s = inspect(t);
        return {
          kind,
          label: MCP_APP_LABELS[kind],
          installed: s.installed,
          configPath: t.file,
          // Claude's extension lives in Claude, not in a file Murmur can read: its token says so.
          added:
            s.added ||
            (kind === "claude" && this.clients.ofKind(kind) !== null),
          backupsWithEntry: backupsWithEntry(t),
        };
      }),
    };
  }

  preview(input: unknown): McpConfigPreview {
    const kind = McpAppSchema.parse(input);
    const t = configTarget(kind, this.d.home);
    const s = inspect(t);
    this.requireReady(kind, s.installed);
    if (kind === "claude")
      return {
        kind,
        label: t.label,
        configPath: t.file,
        method: "extension",
        fileExists: s.fileExists,
        backupNote: s.added
          ? "An older Murmur entry in Claude's config file is removed first (a backup copy is saved next to it)."
          : "Claude's config file isn't changed.",
        entry: JSON.stringify(
          {
            extension: EXTENSION_FILE,
            runs: "a small script that Claude runs only while it is open",
            talksTo: this.url(),
            token: HIDDEN,
          },
          null,
          2,
        ),
        replaces: s.added,
      };
    const entry = serverEntry(kind, {
      url: this.url(),
      token: HIDDEN,
      launch: this.d.launch(),
    });
    return {
      kind,
      label: t.label,
      configPath: t.file,
      method: "config-file",
      fileExists: s.fileExists,
      backupNote: s.fileExists
        ? "A copy of the current file is saved first, next to it, as a .bak file with the time in its name."
        : "The file doesn't exist yet; it will be created.",
      entry: JSON.stringify(entry, null, 2),
      replaces: s.added,
    };
  }

  private requireReady(kind: McpAppKind, installed: boolean): void {
    if (!this.d.settings.get().mcp.enabled)
      throw new ConfigFileError("Turn on MCP first.");
    if (!installed)
      throw new ConfigFileError(
        `${MCP_APP_LABELS[kind]} doesn't seem to be installed, so there is nothing to add Murmur to.`,
      );
  }

  async install(input: unknown): Promise<McpConfigResult> {
    const kind = McpAppSchema.parse(input);
    const t = configTarget(kind, this.d.home);
    this.requireReady(kind, inspect(t).installed);
    if (!(await this.d.unlock()))
      throw new ConfigFileError(
        "Murmur's secure storage (the Keychain) isn't available, so it can't create an access token.",
      );
    let client = this.clients.ofKind(kind);
    let token = client ? this.clients.token(client.id) : null;
    if (client && !token) {
      await this.clients.revoke(client.id);
      client = null;
    }
    if (!client) {
      client = await this.clients.create(MCP_APP_LABELS[kind], kind);
      token = this.clients.token(client.id);
    }
    if (!token) throw new ConfigFileError("Couldn't save an access token.");
    if (kind === "claude") return this.installExtension(t, token);
    const written = addEntry(
      t,
      serverEntry(kind, { url: this.url(), token, launch: this.d.launch() }),
      (this.d.now ?? Date.now)(),
    );
    this.d.log("mcp.config.added", { app: kind });
    this.d.notify();
    return {
      kind,
      configPath: written.configPath,
      backupPath: written.backupPath,
      opened: false,
      cleanedBackups: 0,
    };
  }

  /**
   * Claude Desktop: a Desktop Extension (.mcpb) that Claude itself installs, after its own
   * consent screen. The file holds the token, so it lives in a private temporary folder that is
   * deleted after a few minutes, when MCP is turned off and when Murmur quits.
   */
  private async installExtension(
    t: ReturnType<typeof configTarget>,
    token: string,
  ): Promise<McpConfigResult> {
    this.sweepExtensions();
    const folder = mkdtempSync(
      join(this.d.tempDir ?? tmpdir(), EXTENSION_DIR_PREFIX),
    ); // mkdtemp creates it as 0700
    const file = join(folder, EXTENSION_FILE);
    writeFileSync(
      file,
      buildExtension({ url: this.url(), token, version: this.d.version }),
      { mode: 0o600 },
    );
    const timer = setTimeout(
      () => this.dropExtension(folder),
      EXTENSION_LIFETIME_MS,
    );
    timer.unref();
    this.extensionDirs.set(folder, timer);
    // An older version put a command entry (and a token) in Claude's config file: take it out.
    let backupPath: string | null = null;
    try {
      backupPath = removeEntry(t, (this.d.now ?? Date.now)()).backupPath;
    } catch {
      // A config file Murmur can't edit is left alone; the extension doesn't need it.
    }
    try {
      await this.d.openExtension(file);
    } catch {
      this.dropExtension(folder);
      throw new ConfigFileError(
        "Couldn't open Claude. Open it once, then try again.",
      );
    }
    this.d.log("mcp.extension.opened", { app: "claude" });
    this.d.notify();
    return {
      kind: "claude",
      configPath: t.file,
      backupPath,
      opened: true,
      cleanedBackups: 0,
    };
  }

  private dropExtension(folder: string): void {
    clearTimeout(this.extensionDirs.get(folder));
    this.extensionDirs.delete(folder);
    rmSync(folder, { recursive: true, force: true });
  }

  /** Deletes extension folders left by an earlier run (Murmur quit before the timer). */
  private sweepExtensions(): void {
    const root = this.d.tempDir ?? tmpdir();
    for (const name of readdirSync(root)) {
      if (!name.startsWith(EXTENSION_DIR_PREFIX)) continue;
      const folder = join(root, name);
      try {
        if (
          this.extensionDirs.has(folder) ||
          Date.now() - statSync(folder).mtimeMs > EXTENSION_LIFETIME_MS
        )
          this.dropExtension(folder);
      } catch {
        // Gone already.
      }
    }
  }

  /** Takes Murmur out of the app's config and revokes the token that entry used. */
  async remove(input: unknown): Promise<McpConfigResult> {
    const { kind, cleanBackups } =
      typeof input === "string"
        ? { kind: McpAppSchema.parse(input), cleanBackups: false }
        : McpRemoveSchema.parse(input);
    const t = configTarget(kind, this.d.home);
    const written = removeEntry(t, (this.d.now ?? Date.now)());
    const client = this.clients.ofKind(kind);
    if (client) await this.clients.revoke(client.id);
    const cleanedBackups = cleanBackups ? stripBackups(t) : 0;
    this.d.log("mcp.config.removed", { app: kind });
    this.d.notify();
    return {
      kind,
      configPath: t.file,
      backupPath: written.backupPath,
      opened: false,
      cleanedBackups,
    };
  }

  async createClient(input: unknown): Promise<McpClientInfo> {
    const { name } = McpNewClientSchema.parse(input);
    if (!(await this.d.unlock()))
      throw new ConfigFileError(
        "Murmur's secure storage (the Keychain) isn't available.",
      );
    const client = await this.clients.create(name, "other");
    this.d.notify();
    return client;
  }

  async revokeClient(input: unknown): Promise<void> {
    const { id } = McpClientIdSchema.parse(input);
    await this.clients.revoke(id);
    this.d.log("mcp.client.revoked");
    this.d.notify();
  }

  /**
   * For Reset: revokes every client token and deletes the clients file. The server itself stops
   * when the settings return to "off". Claude's and Cursor's config files are never edited; the
   * names of the apps that had Murmur added are returned so the person can be told.
   */
  async resetAll(): Promise<{ apps: string[] }> {
    const apps = this.status()
      .apps.filter((a) => a.added)
      .map((a) => a.label);
    await this.clients.revokeAll();
    this.d.log("mcp.reset", {});
    this.d.notify();
    return { apps };
  }

  /** Puts a token or a ready config on the clipboard; they never go to the page. */
  copy(input: unknown): void {
    const { id, what } = McpCopySchema.parse(input);
    const token = this.clients.token(id);
    if (!token) throw new ConfigFileError("That access token isn't available.");
    const conn = { url: this.url(), token, launch: this.d.launch() };
    const wrap = (kind: McpAppKind) =>
      JSON.stringify(
        { mcpServers: { murmur: serverEntry(kind, conn) } },
        null,
        2,
      );
    this.d.copy(
      what === "token" ? token : wrap(what === "http" ? "cursor" : "claude"),
    );
  }

  async dispose(): Promise<void> {
    for (const folder of [...this.extensionDirs.keys()])
      this.dropExtension(folder);
    this.clients.flush();
    await this.server.stop();
  }
}
