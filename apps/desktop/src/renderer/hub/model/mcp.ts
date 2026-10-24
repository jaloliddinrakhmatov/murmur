// Settings → MCP page logic (pure; unit-tested in test/mcp.test.ts).
import type { McpClientInfo, McpServerState } from "../../../shared/mcp.ts";
import { noteWhen } from "./scratchpad.ts";

export function serverStatus(
  enabled: boolean,
  state: McpServerState,
  port: number,
): { tone: "neutral" | "success" | "warning" | "danger"; text: string } {
  if (!enabled) return { tone: "neutral", text: "Off" };
  switch (state) {
    case "running":
      return { tone: "success", text: `On, listening on 127.0.0.1:${port}` };
    case "starting":
    case "off":
      return { tone: "neutral", text: "Starting…" };
    case "locked":
      return {
        tone: "warning",
        text: "Waiting for the macOS Keychain (needed for access tokens)",
      };
    case "port-busy":
      return {
        tone: "danger",
        text: `Port ${port} is in use by another program. Choose another port.`,
      };
    case "error":
      return { tone: "danger", text: "Couldn't start. Try another port." };
  }
}

/** "Last used 5 min ago · 12 requests", or "Never used". Counts and times only. */
export function clientActivity(c: McpClientInfo, now: Date): string {
  if (c.lastAccessAt === null) return "Never used";
  return `Last used ${noteWhen(c.lastAccessAt, now)} · ${c.requests} ${c.requests === 1 ? "request" : "requests"}`;
}

export function isValidPort(n: number): boolean {
  return Number.isInteger(n) && n >= 1024 && n <= 65535;
}
