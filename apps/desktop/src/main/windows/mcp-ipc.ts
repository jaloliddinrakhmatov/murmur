// The Hub's MCP channels (Settings → MCP). Only the Hub page may call them; McpService validates
// every input. Config files are written only by hub:mcpInstall / hub:mcpRemove, which the page
// sends after the person confirmed the preview.
import { ipcMain } from "electron";
import { McpInstallSchema, McpRemoveSchema } from "../../shared/mcp.ts";
import { ConfigFileError } from "../mcp/config-files.ts";
import type { McpService } from "../mcp/service.ts";
import { fromHub } from "./hub.ts";

/** A message safe to show; anything unexpected becomes a generic one. */
const shown = async <T>(fn: () => T | Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    throw new Error(
      err instanceof ConfigFileError ? err.message : "That didn't work.",
    );
  }
};

export function registerMcpIpc(mcp: McpService): void {
  const handle = (channel: string, fn: (input: unknown) => unknown) =>
    ipcMain.handle(channel, (e, input: unknown) => {
      if (!fromHub(e)) throw new Error("not allowed");
      return shown(() => fn(input));
    });
  handle("hub:mcpStatus", () => mcp.status());
  handle("hub:mcpPreview", (kind) => mcp.preview(kind));
  handle("hub:mcpInstall", (input) =>
    mcp.install(McpInstallSchema.parse(input).kind),
  );
  handle("hub:mcpRemove", (input) => mcp.remove(McpRemoveSchema.parse(input)));
  handle("hub:mcpCreateClient", (name) => mcp.createClient({ name }));
  handle("hub:mcpRevokeClient", (id) => mcp.revokeClient({ id }));
  handle("hub:mcpCopy", (input) => mcp.copy(input));
}
