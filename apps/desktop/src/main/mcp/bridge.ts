// `Murmur --mcp-stdio`: a stdio MCP server for clients that can only run a local command (Claude
// Desktop). It holds no data and opens no window: it forwards each JSON-RPC message from stdin to
// the running app's local HTTP endpoint with the bearer token, and writes the replies to stdout.
// If Murmur isn't running (or MCP is off, or the token was revoked) the client gets a clear
// JSON-RPC error instead of a hang. The token comes from the environment, never from argv.
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { URL_ENV, TOKEN_ENV } from "./config-files.ts";

export const BRIDGE_FLAG = "--mcp-stdio";

export interface BridgeOptions {
  env: Record<string, string | undefined>;
  input: Readable;
  output: Writable;
  errors: Writable;
  fetchImpl?: typeof fetch;
}

const isRequest = (m: unknown): m is { id: string | number } =>
  typeof m === "object" &&
  m !== null &&
  "method" in m &&
  "id" in m &&
  (typeof (m as { id: unknown }).id === "string" ||
    typeof (m as { id: unknown }).id === "number");

function loopbackUrl(value: string | undefined): URL | null {
  try {
    const u = new URL(value ?? "");
    return u.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)
      ? u
      : null;
  } catch {
    return null;
  }
}

/** Runs until stdin closes and every forwarded message has been answered. Returns an exit code. */
export async function runStdioBridge(o: BridgeOptions): Promise<number> {
  const url = loopbackUrl(o.env[URL_ENV]);
  const token = o.env[TOKEN_ENV];
  if (!url || !token) {
    o.errors.write(
      `Murmur MCP bridge: ${URL_ENV} must be a local http address and ${TOKEN_ENV} must be set. Add Murmur again from Settings → MCP.\n`,
    );
    return 2;
  }
  const doFetch = o.fetchImpl ?? fetch;
  const write = (message: unknown) =>
    o.output.write(`${JSON.stringify(message)}\n`);
  const fail = (message: unknown, text: string) => {
    if (isRequest(message))
      write({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: text },
      });
  };

  const forward = async (message: unknown) => {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      return fail(
        message,
        "Murmur isn't reachable. Open Murmur and turn on Settings → MCP, then try again.",
      );
    }
    if (res.status === 401)
      return fail(
        message,
        "Murmur refused this access token (it was revoked). Add Murmur again from Settings → MCP.",
      );
    if (res.status === 202 || res.status === 204) return;
    if (!res.ok)
      return fail(message, `Murmur answered with status ${res.status}.`);
    const text = await res.text();
    if (!text.trim()) return;
    if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      for (const line of text.split("\n"))
        if (line.startsWith("data:") && line.slice(5).trim())
          o.output.write(`${line.slice(5).trim()}\n`);
      return;
    }
    try {
      write(JSON.parse(text));
    } catch {
      fail(message, "Murmur sent a reply that couldn't be read.");
    }
  };

  const pending = new Set<Promise<void>>();
  const lines = createInterface({ input: o.input, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const p = forward(message).finally(() => pending.delete(p));
    pending.add(p);
  });
  await new Promise<void>((resolve) => lines.once("close", resolve));
  await Promise.all(pending);
  return 0;
}
