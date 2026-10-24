// The MCP half of the Hub's window.hub (Settings → MCP); see McpHub in shared/mcp.ts.
import { ipcRenderer } from "electron";
import type { McpHub } from "../shared/mcp.ts";

export const mcpBridge: McpHub = {
  mcpStatus: () => ipcRenderer.invoke("hub:mcpStatus"),
  mcpPreview: (kind) => ipcRenderer.invoke("hub:mcpPreview", kind),
  mcpInstall: (kind) =>
    ipcRenderer.invoke("hub:mcpInstall", { kind, confirm: true }),
  mcpRemove: (kind, cleanBackups = false) =>
    ipcRenderer.invoke("hub:mcpRemove", { kind, cleanBackups }),
  mcpCreateClient: (name) => ipcRenderer.invoke("hub:mcpCreateClient", name),
  mcpRevokeClient: (id) => ipcRenderer.invoke("hub:mcpRevokeClient", id),
  mcpCopy: (id, what) => ipcRenderer.invoke("hub:mcpCopy", { id, what }),
  onMcpChanged: (cb) => {
    const listener = () => cb();
    ipcRenderer.on("hub:mcpChanged", listener);
    return () => ipcRenderer.removeListener("hub:mcpChanged", listener);
  },
};
