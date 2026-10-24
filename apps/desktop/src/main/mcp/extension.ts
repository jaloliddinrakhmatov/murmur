// Claude Desktop "Desktop Extension" (.mcpb) for Murmur: a zip with a manifest and a tiny Node
// script that Claude runs with its own bundled Node. The script only forwards MCP messages to the
// local server (127.0.0.1) with the access token; it holds no data. Claude shows its own install
// and consent screen, keeps the extension's settings itself, and runs the script only while it
// is open, so Murmur.app is never started as a long-lived helper.
//
// The token is the extension's one setting (`user_config.token`, marked sensitive). It is
// offered as the setting's default so the install screen is pre-filled; it is never written
// into the script, and the .mcpb is created in a private temporary folder that is deleted
// after Claude has had time to open it (see McpService).
import { deflateRawSync } from "node:zlib";
import { MCP_SERVER_NAME } from "../../shared/mcp.ts";
import { TOKEN_ENV, URL_ENV } from "./config-files.ts";

export const EXTENSION_FILE = "Murmur-meetings.mcpb";
export const EXTENSION_SCRIPT_PATH = "server/index.mjs";

/** The script Claude runs. Self-contained (no imports but Node's own), plain JavaScript. */
export const EXTENSION_SCRIPT = `// Murmur MCP bridge for Claude Desktop: stdio <-> the local Murmur server.
import { createInterface } from "node:readline";

const url = process.env.${URL_ENV};
const token = process.env.${TOKEN_ENV};
const local = (() => {
  try {
    const u = new URL(url ?? "");
    return u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
})();
if (!local || !token) {
  process.stderr.write("Murmur extension: the server address or access token is missing. Add Murmur again from Murmur > Settings > MCP.\\n");
  process.exit(2);
}

const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const isRequest = (m) =>
  typeof m === "object" && m !== null && "method" in m && "id" in m &&
  (typeof m.id === "string" || typeof m.id === "number");
const fail = (message, text) => {
  if (isRequest(message)) write({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: text } });
};

async function forward(message) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer " + token,
      },
      body: JSON.stringify(message),
      redirect: "error",
      signal: AbortSignal.timeout(60000),
    });
  } catch {
    return fail(message, "Murmur isn't reachable. Open Murmur and turn on Settings > MCP, then try again.");
  }
  if (res.status === 401) return fail(message, "Murmur refused this access token (it was revoked). Add Murmur again from Settings > MCP.");
  if (res.status === 202 || res.status === 204) return;
  if (!res.ok) return fail(message, "Murmur answered with status " + res.status + ".");
  const text = await res.text();
  if (!text.trim()) return;
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    for (const line of text.split("\\n"))
      if (line.startsWith("data:") && line.slice(5).trim()) process.stdout.write(line.slice(5).trim() + "\\n");
    return;
  }
  try {
    write(JSON.parse(text));
  } catch {
    fail(message, "Murmur sent a reply that couldn't be read.");
  }
}

const pending = new Set();
createInterface({ input: process.stdin, crlfDelay: Infinity })
  .on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const p = forward(message).finally(() => pending.delete(p));
    pending.add(p);
  })
  .once("close", () => Promise.all(pending).then(() => process.exit(0)));
`;

export interface ExtensionInput {
  /** The local MCP endpoint, e.g. http://127.0.0.1:47821/mcp. */
  url: string;
  token: string;
  version: string;
}

/** manifest.json for the .mcpb format (manifest_version 0.2). */
export function extensionManifest(i: ExtensionInput): Record<string, unknown> {
  return {
    manifest_version: "0.2",
    name: "murmur-meetings",
    display_name: "Murmur meetings",
    version: i.version,
    description:
      "Lets Claude read your Murmur Notetaker meetings (read-only, on this Mac).",
    long_description:
      "Connects Claude to the local server in the Murmur app on this Mac. Claude can list, search and read your Notetaker meetings (titles, times, notes, transcripts, summaries). It cannot change anything and never sees your dictations, History, Scratchpad notes, audio, settings or keys. Murmur must be open with Settings > MCP turned on.",
    author: { name: "Murmur" },
    server: {
      type: "node",
      entry_point: EXTENSION_SCRIPT_PATH,
      mcp_config: {
        command: "node",
        args: ["${__dirname}/" + EXTENSION_SCRIPT_PATH],
        env: {
          [URL_ENV]: i.url,
          [TOKEN_ENV]: "${user_config.token}",
        },
      },
    },
    user_config: {
      token: {
        type: "string",
        title: "Murmur access token",
        description:
          "Created by Murmur for this extension. Revoke it any time in Murmur > Settings > MCP.",
        sensitive: true,
        required: true,
        default: i.token,
      },
    },
    compatibility: { platforms: ["darwin"] },
    keywords: [MCP_SERVER_NAME, "meetings", "notes"],
  };
}

// ---- A minimal zip writer (deflate) -------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip archive of the given files (names use "/"; fixed timestamp, so output is reproducible). */
export function zip(files: { name: string; data: Buffer }[]): Buffer {
  const DOS_TIME = 0;
  const DOS_DATE = (2026 - 1980) * 512 + 1 * 32 + 1;
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const packed = deflateRawSync(f.data);
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(0x031e, 4); // made by: Unix, 3.0
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(f.data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attributes: regular file, 0644
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

/** The .mcpb file's bytes. */
export function buildExtension(i: ExtensionInput): Buffer {
  return zip([
    {
      name: "manifest.json",
      data: Buffer.from(
        JSON.stringify(extensionManifest(i), null, 2) + "\n",
        "utf8",
      ),
    },
    {
      name: EXTENSION_SCRIPT_PATH,
      data: Buffer.from(EXTENSION_SCRIPT, "utf8"),
    },
  ]);
}
