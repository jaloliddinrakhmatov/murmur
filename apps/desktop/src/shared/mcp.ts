// Settings → MCP: the local MCP server that lets AI apps on this Mac read Notetaker meetings.
// Shared types and the Hub's input checks. Only meetings are ever served: never dictations,
// History, Scratchpad notes, audio, settings or keys.
import { z } from "zod";

export const MCP_DEFAULT_PORT = 47821;
export const MCP_PATH = "/mcp";
export const MCP_SERVER_NAME = "murmur";

/** Apps Murmur can add itself to; "other" is a token for any other MCP client. */
export const MCP_CLIENT_KINDS = ["claude", "cursor", "other"] as const;
export type McpClientKind = (typeof MCP_CLIENT_KINDS)[number];
export type McpAppKind = Exclude<McpClientKind, "other">;

export const MCP_APP_LABELS: Record<McpClientKind, string> = {
  claude: "Claude Desktop",
  cursor: "Cursor",
  other: "Other app",
};

export const McpAppSchema = z.enum(["claude", "cursor"]);
export const McpInstallSchema = z.object({
  kind: McpAppSchema,
  /** The person has seen the preview and agreed. */
  confirm: z.literal(true),
});
export const McpRemoveSchema = z.object({
  kind: McpAppSchema,
  /** Also take Murmur's entry (and its token) out of Murmur's older backup copies. */
  cleanBackups: z.boolean().default(false),
});
export const McpClientIdSchema = z.object({ id: z.string().min(1).max(64) });
export const McpNewClientSchema = z.object({
  name: z.string().trim().min(1).max(60),
});

export interface McpClientInfo {
  id: string;
  name: string;
  kind: McpClientKind;
  createdAt: number;
  /** Counts and times only; what was read is never recorded. */
  lastAccessAt: number | null;
  requests: number;
}

export type McpServerState =
  "off" | "starting" | "running" | "locked" | "port-busy" | "error";

/** Where an app's config file lives and whether Murmur is already in it. */
export interface McpAppInfo {
  kind: McpAppKind;
  label: string;
  /** The app's settings folder exists (so the app seems to be installed). */
  installed: boolean;
  configPath: string;
  /** The "murmur" entry is in the config file (Claude: or an extension was sent to it). */
  added: boolean;
  /** Murmur's older backup copies of the config file that still hold a "murmur" entry. */
  backupsWithEntry: number;
}

export interface McpStatus {
  enabled: boolean;
  state: McpServerState;
  port: number;
  url: string;
  clients: McpClientInfo[];
  apps: McpAppInfo[];
}

/** What adding Murmur to an app's config would change (nothing is written yet). */
export interface McpConfigPreview {
  kind: McpAppKind;
  label: string;
  configPath: string;
  /**
   * "config-file": Murmur edits the app's config file (Cursor). "extension": Murmur creates a
   * Desktop Extension file and opens it with the app, which shows its own install screen (Claude).
   */
  method: "config-file" | "extension";
  /** The file exists now; if so, a backup copy is made first. */
  fileExists: boolean;
  backupNote: string;
  /** The "murmur" entry as it will be written, with the token hidden. */
  entry: string;
  /** An entry named "murmur" is already there and will be replaced. */
  replaces: boolean;
}

export interface McpConfigResult {
  kind: McpAppKind;
  configPath: string;
  backupPath: string | null;
  /** Extension method: the app was asked to open the extension. */
  opened: boolean;
  /** Backup copies whose "murmur" entry was removed. */
  cleanedBackups: number;
}

export const MCP_COPY_WHAT = ["token", "http", "stdio"] as const;
export type McpCopyWhat = (typeof MCP_COPY_WHAT)[number];
export const McpCopySchema = z.object({
  id: z.string().min(1).max(64),
  what: z.enum(MCP_COPY_WHAT),
});

export interface McpHub {
  mcpStatus(): Promise<McpStatus>;
  mcpPreview(kind: McpAppKind): Promise<McpConfigPreview>;
  mcpInstall(kind: McpAppKind): Promise<McpConfigResult>;
  mcpRemove(kind: McpAppKind, cleanBackups?: boolean): Promise<McpConfigResult>;
  mcpCreateClient(name: string): Promise<McpClientInfo>;
  mcpRevokeClient(id: string): Promise<void>;
  /**
   * Copies one client's token, a URL-and-headers config or a command config to the clipboard
   * (through the main process; the token never reaches the page).
   */
  mcpCopy(id: string, what: McpCopyWhat): Promise<void>;
  onMcpChanged(cb: () => void): () => void;
}
