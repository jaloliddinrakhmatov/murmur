// Settings → MCP: the local MCP server over Notetaker meetings. Off by default; tools against a
// temp database; auth, Host and Origin checks; size caps; one real end-to-end run with the SDK
// client; config-file merge, backup and removal in temp folders (never the real config files);
// the stdio bridge; and the service wiring.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { inflateRawSync } from "node:zlib";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { HistoryDb, MeetingRepo } from "../src/main/history/db.ts";
import { SettingsSchema, type Settings } from "../src/shared/settings.ts";
import { MCP_DEFAULT_PORT } from "../src/shared/mcp.ts";
import {
  bearerToken,
  hostAllowed,
  matchToken,
  newToken,
  originAllowed,
} from "../src/main/mcp/guard.ts";
import {
  getMeeting,
  listMeetings,
  NOTES_CAP,
  searchMeetings,
  ToolError,
  TRANSCRIPT_CAP,
} from "../src/main/mcp/tools.ts";
import { MAX_BODY_BYTES, McpHttpServer } from "../src/main/mcp/server.ts";
import { McpClients, type TokenVault } from "../src/main/mcp/clients.ts";
import {
  addEntry,
  backupsWithEntry,
  ConfigFileError,
  configTarget,
  inspect,
  MAX_BACKUPS,
  removeEntry,
  serverEntry,
  stripBackups,
} from "../src/main/mcp/config-files.ts";
import {
  buildExtension,
  EXTENSION_SCRIPT,
  EXTENSION_SCRIPT_PATH,
  extensionManifest,
} from "../src/main/mcp/extension.ts";
import { runStdioBridge } from "../src/main/mcp/bridge.ts";
import { McpService } from "../src/main/mcp/service.ts";
import {
  clientActivity,
  isValidPort,
  serverStatus,
} from "../src/renderer/hub/model/mcp.ts";

const dir = (p: string) => mkdtempSync(join(tmpdir(), `murmur-${p}-`));
const DAY = 86_400_000;

function memoryVault(): TokenVault & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: (n) => data.get(n) ?? null,
    set: async (n, v) => void (v ? data.set(n, v) : data.delete(n)),
  };
}

function seeded() {
  const db = new HistoryDb(join(dir("mcp-db"), "h.sqlite"));
  const repo = new MeetingRepo(db.db);
  const t0 = new Date(2026, 9, 10, 10).getTime();
  repo.create({
    id: "a",
    title: "Budget review",
    startedAt: t0,
    notes: "Quarterly CAFÉ budget",
  });
  repo.create({
    id: "b",
    title: "Design sync",
    startedAt: t0 + 5 * DAY,
    notes: "",
  });
  repo.create({ id: "c", title: "Untimed", startedAt: null }, t0 + 9 * DAY);
  repo.saveTranscript(
    "b",
    "We talked about the onboarding flow and pricing.",
    t0,
  );
  repo.saveSummary("b", "Onboarding needs work.", t0);
  return { db, repo, t0 };
}

test("MCP is off by default, on port 47821", () => {
  const s = SettingsSchema.parse({});
  assert.equal(s.mcp.enabled, false);
  assert.equal(s.mcp.port, MCP_DEFAULT_PORT);
});

test("guard: Host, Origin, bearer, constant-time match", () => {
  assert.ok(hostAllowed("127.0.0.1:47821"));
  assert.ok(hostAllowed("localhost"));
  assert.ok(hostAllowed("[::1]:47821"));
  assert.ok(!hostAllowed("evil.example:47821"));
  assert.ok(!hostAllowed("127.0.0.1.evil.example"));
  assert.ok(!hostAllowed(undefined));
  assert.ok(originAllowed(undefined));
  assert.ok(originAllowed("http://localhost:3000"));
  assert.ok(!originAllowed("https://evil.example"));
  assert.ok(!originAllowed("null"));
  assert.equal(bearerToken("Bearer abc.DEF-1"), "abc.DEF-1");
  assert.equal(bearerToken("Basic abc"), null);
  assert.equal(bearerToken(undefined), null);
  const t = newToken();
  assert.match(t, /^mmr_[A-Za-z0-9_-]{43}$/);
  const tokens = new Map([
    ["one", newToken()],
    ["two", t],
  ]);
  assert.equal(matchToken(t, tokens), "two");
  assert.equal(matchToken("mmr_nope", tokens), null);
});

test("tools: list is newest first, paged, with a date range", () => {
  const { repo, t0 } = seeded();
  const all = listMeetings(repo, {});
  assert.deepEqual(
    all.meetings.map((m) => m.id),
    ["c", "b", "a"],
  );
  assert.equal(all.total, 3);
  assert.equal(all.nextOffset, null);
  const first = listMeetings(repo, { limit: 2 });
  assert.equal(first.count, 2);
  assert.equal(first.nextOffset, 2);
  assert.deepEqual(
    listMeetings(repo, { limit: 2, offset: 2 }).meetings.map((m) => m.id),
    ["a"],
  );
  const range = listMeetings(repo, { from: "2026-10-12", to: "2026-10-16" });
  assert.deepEqual(
    range.meetings.map((m) => m.id),
    ["b"],
  );
  // A plain `to` date includes that whole day.
  assert.deepEqual(
    listMeetings(repo, { to: "2026-10-10" }).meetings.map((m) => m.id),
    ["a"],
  );
  assert.equal(new Date(t0).getFullYear(), 2026);
  assert.throws(() => listMeetings(repo, { from: "soon" }), ToolError);
  assert.throws(
    () => listMeetings(repo, { from: "2026-10-12", to: "2026-10-01" }),
    ToolError,
  );
  const fields = JSON.stringify(all);
  assert.ok(
    !fields.includes("onboarding flow"),
    "the list carries no meeting text",
  );
});

test("tools: search folds like the app and finds transcripts and summaries", () => {
  const { repo } = seeded();
  const cafe = searchMeetings(repo, { query: "café" });
  assert.deepEqual(
    cafe.meetings.map((m) => m.id),
    ["a"],
  );
  assert.equal(cafe.meetings[0].matches[0].in, "notes");
  assert.match(cafe.meetings[0].matches[0].snippet, /budget/);
  const flow = searchMeetings(repo, { query: "ONBOARDING   flow" });
  assert.deepEqual(
    flow.meetings.map((m) => m.id),
    ["b"],
  );
  assert.equal(flow.meetings[0].matches[0].in, "transcript");
  assert.equal(searchMeetings(repo, { query: "zzz" }).total, 0);
  assert.throws(() => searchMeetings(repo, { query: "  " }), ToolError);
});

test("tools: get_meeting returns the text and caps it, saying so", () => {
  const { repo } = seeded();
  const m = getMeeting(repo, { id: "b" });
  assert.equal(m.title, "Design sync");
  assert.equal(
    m.transcript.text,
    "We talked about the onboarding flow and pricing.",
  );
  assert.equal(m.transcript.truncated, false);
  assert.equal(m.summary.text, "Onboarding needs work.");
  assert.throws(() => getMeeting(repo, { id: "nope" }), ToolError);

  const big = "x".repeat(TRANSCRIPT_CAP + 500);
  repo.saveTranscript("a", big, 1);
  const cut = getMeeting(repo, { id: "a" });
  assert.equal(cut.transcript.text.length, TRANSCRIPT_CAP);
  assert.equal(cut.transcript.truncated, true);
  assert.equal(cut.transcript.totalChars, big.length);
  assert.equal(cut.transcript.nextOffset, TRANSCRIPT_CAP);
  const rest = getMeeting(repo, { id: "a", transcriptOffset: TRANSCRIPT_CAP });
  assert.equal(rest.transcript.text.length, 500);
  assert.equal(rest.transcript.truncated, false);
  assert.ok(NOTES_CAP > 0);
});

function liveServer(tokens: Map<string, string>) {
  const { repo } = seeded();
  const accessed: string[] = [];
  const logs: string[] = [];
  const server = new McpHttpServer({
    meetings: repo,
    tokens: () => tokens,
    onAccess: (id) => accessed.push(id),
    version: "0.0.0-test",
    log: (e, d) => logs.push(e + JSON.stringify(d ?? {})),
  });
  return { server, accessed, logs };
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "t", version: "1" },
  },
};
const post = (url: string, headers: Record<string, string>, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("server: 401 without, with a wrong or with a revoked token; 200 with a good one", async () => {
  const good = newToken();
  const tokens = new Map([["c1", good]]);
  const { server, accessed } = liveServer(tokens);
  const port = await server.start(0);
  const url = `http://127.0.0.1:${port}/mcp`;
  try {
    assert.equal((await post(url, {}, INIT)).status, 401);
    const wrong = await post(url, { Authorization: "Bearer mmr_wrong" }, INIT);
    assert.equal(wrong.status, 401);
    assert.match(wrong.headers.get("www-authenticate") ?? "", /Bearer/);
    assert.equal(
      accessed.length,
      0,
      "refused requests aren't counted as access",
    );
    const ok = await post(url, { Authorization: `Bearer ${good}` }, INIT);
    assert.equal(ok.status, 200);
    assert.equal(
      ((await ok.json()) as { result: { serverInfo: { name: string } } }).result
        .serverInfo.name,
      "murmur",
    );
    assert.deepEqual(accessed, ["c1"]);
    tokens.delete("c1");
    assert.equal(
      (await post(url, { Authorization: `Bearer ${good}` }, INIT)).status,
      401,
    );
  } finally {
    await server.stop();
  }
});

test("server: Host, Origin, path, method and size checks", async () => {
  const good = newToken();
  const { server } = liveServer(new Map([["c1", good]]));
  const port = await server.start(0);
  const auth = { Authorization: `Bearer ${good}` };
  const url = `http://127.0.0.1:${port}/mcp`;
  try {
    assert.equal(
      (await post(url, { ...auth, Origin: "https://evil.example" }, INIT))
        .status,
      403,
    );
    assert.equal(
      (await post(url, { ...auth, Origin: "http://localhost:5173" }, INIT))
        .status,
      200,
    );
    assert.equal(
      (await post(`http://127.0.0.1:${port}/other`, auth, INIT)).status,
      404,
    );
    assert.equal((await fetch(url, { headers: auth })).status, 405);
    assert.equal((await post(url, auth, "{not json")).status, 400);
    const huge = await post(url, auth, " ".repeat(MAX_BODY_BYTES + 10));
    assert.equal(huge.status, 413);
    // A forged Host header (DNS rebinding) is refused before anything else.
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const r = request(
        {
          host: "127.0.0.1",
          port,
          path: "/mcp",
          method: "POST",
          headers: {
            ...auth,
            Host: "evil.example",
            "Content-Type": "application/json",
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      r.on("error", reject);
      r.end(JSON.stringify(INIT));
    });
    assert.equal(status, 403);
  } finally {
    await server.stop();
  }
});

test("end to end: the SDK client lists, searches and reads meetings", async () => {
  const good = newToken();
  const { server } = liveServer(new Map([["c1", good]]));
  const port = await server.start(0);
  const client = new Client({ name: "e2e", version: "1" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    {
      requestInit: { headers: { Authorization: `Bearer ${good}` } },
    },
  );
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((t) => t.name).sort(), [
      "get_meeting",
      "list_meetings",
      "search_meetings",
    ]);
    assert.ok(tools.tools.every((t) => t.annotations?.readOnlyHint === true));
    const list = await client.callTool({
      name: "list_meetings",
      arguments: { limit: 2 },
    });
    const listed = list.structuredContent as {
      total: number;
      meetings: { id: string }[];
    };
    assert.equal(listed.total, 3);
    assert.equal(listed.meetings.length, 2);
    const found = await client.callTool({
      name: "search_meetings",
      arguments: { query: "pricing" },
    });
    assert.equal(
      (found.structuredContent as { meetings: { id: string }[] }).meetings[0]
        .id,
      "b",
    );
    const got = await client.callTool({
      name: "get_meeting",
      arguments: { id: "b" },
    });
    assert.match(JSON.stringify(got.structuredContent), /onboarding flow/);
    const missing = await client.callTool({
      name: "get_meeting",
      arguments: { id: "zzz" },
    });
    assert.equal(missing.isError, true);
  } finally {
    await client.close();
    await server.stop();
  }
});

test("clients: tokens live only in the vault; revoke removes them; access is counts and times", async () => {
  const vault = memoryVault();
  const file = join(dir("mcp-clients"), "mcp-clients.json");
  let t = 1000;
  const clients = new McpClients(file, vault, () => t);
  const c = await clients.create("Claude Desktop", "claude");
  assert.equal(vault.data.size, 1);
  const token = clients.token(c.id)!;
  assert.match(token, /^mmr_/);
  clients.recordAccess(c.id);
  t = 2000;
  clients.recordAccess(c.id);
  clients.flush();
  const text = readFileSync(file, "utf8");
  assert.ok(!text.includes(token), "the token is not in the clients file");
  assert.equal(statSync(file).mode & 0o077, 0, "the clients file is private");
  const again = new McpClients(file, vault, () => t);
  assert.equal(again.list()[0].requests, 2);
  assert.equal(again.list()[0].lastAccessAt, 2000);
  assert.equal(again.tokens().get(c.id), token);
  assert.equal(await again.revoke(c.id), true);
  assert.equal(vault.data.size, 0);
  assert.equal(again.tokens().size, 0);
  assert.equal(await again.revoke(c.id), false);
});

const conn = {
  url: "http://127.0.0.1:47821/mcp",
  token: "mmr_secret",
  launch: {
    command: "/Applications/Murmur.app/Contents/MacOS/Murmur",
    args: ["--mcp-stdio"],
  },
};

test("config files: Cursor entry merges, keeps other servers and indentation, backs up", () => {
  const home = dir("mcp-home");
  const t = configTarget("cursor", home);
  assert.throws(
    () => addEntry(t, serverEntry("cursor", conn)),
    ConfigFileError,
    "not installed",
  );
  assert.equal(
    existsSync(t.dir),
    false,
    "an uninstalled app's folder is not created",
  );
  mkdirSync(t.dir);
  const original =
    JSON.stringify(
      { mcpServers: { other: { command: "x" } }, theme: 1 },
      null,
      4,
    ) + "\n";
  writeFileSync(t.file, original);
  const r = addEntry(
    t,
    serverEntry("cursor", conn),
    Date.UTC(2026, 9, 20, 10, 15, 0),
  );
  assert.match(r.backupPath!, /mcp\.json\.20261020-101500\.bak$/);
  assert.equal(readFileSync(r.backupPath!, "utf8"), original);
  const text = readFileSync(t.file, "utf8");
  assert.ok(text.startsWith('{\n    "mcpServers"'), "4-space indentation kept");
  assert.ok(text.endsWith("}\n"));
  const parsed = JSON.parse(text);
  assert.deepEqual(parsed.mcpServers.other, { command: "x" });
  assert.equal(parsed.theme, 1);
  assert.deepEqual(parsed.mcpServers.murmur, {
    url: conn.url,
    headers: { Authorization: "Bearer mmr_secret" },
  });
  assert.equal(inspect(t).added, true);
  const out = removeEntry(t, Date.UTC(2026, 9, 20, 10, 16, 0));
  assert.ok(out.changed && out.backupPath);
  assert.deepEqual(JSON.parse(readFileSync(t.file, "utf8")), {
    mcpServers: { other: { command: "x" } },
    theme: 1,
  });
  const none = removeEntry(t);
  assert.equal(none.changed, false);
  assert.equal(none.backupPath, null);
  assert.equal(readdirSync(t.dir).filter((f) => f.endsWith(".bak")).length, 2);
});

test("config files: Claude entry is a stdio command; a new file is created; bad JSON is left alone", () => {
  const home = dir("mcp-home");
  const t = configTarget("claude", home);
  assert.equal(
    t.file,
    join(
      home,
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    ),
  );
  mkdirSync(t.dir, { recursive: true });
  addEntry(t, serverEntry("claude", conn));
  const parsed = JSON.parse(readFileSync(t.file, "utf8"));
  assert.deepEqual(parsed.mcpServers.murmur, {
    command: conn.launch.command,
    args: ["--mcp-stdio"],
    env: { MURMUR_MCP_URL: conn.url, MURMUR_MCP_TOKEN: "mmr_secret" },
  });
  assert.equal(
    readdirSync(t.dir).some((f) => f.endsWith(".bak")),
    false,
    "nothing to back up",
  );
  writeFileSync(t.file, "{ broken");
  assert.throws(
    () => addEntry(t, serverEntry("claude", conn)),
    /isn't valid JSON/,
  );
  assert.equal(readFileSync(t.file, "utf8"), "{ broken");
  writeFileSync(t.file, JSON.stringify({ mcpServers: [] }));
  assert.throws(
    () => addEntry(t, serverEntry("claude", conn)),
    ConfigFileError,
  );
});

test("bridge: forwards messages with the token; errors clearly when Murmur is away", async () => {
  const good = newToken();
  const { server } = liveServer(new Map([["c1", good]]));
  const port = await server.start(0);
  const run = async (env: Record<string, string>, lines: unknown[]) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (d) => chunks.push(String(d)));
    const done = runStdioBridge({
      env,
      input,
      output,
      errors: new PassThrough(),
    });
    for (const l of lines) input.write(JSON.stringify(l) + "\n");
    input.end();
    const code = await done;
    return {
      code,
      out: chunks
        .join("")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    };
  };
  try {
    const env = {
      MURMUR_MCP_URL: `http://127.0.0.1:${port}/mcp`,
      MURMUR_MCP_TOKEN: good,
    };
    const ok = await run(env, [
      INIT,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);
    assert.equal(ok.code, 0);
    assert.equal(ok.out.length, 2, "a notification gets no reply");
    assert.ok(ok.out.find((m) => m.id === 2).result.tools.length === 3);
    const bad = await run({ ...env, MURMUR_MCP_TOKEN: "mmr_wrong" }, [INIT]);
    assert.match(bad.out[0].error.message, /refused this access token/);
  } finally {
    await server.stop();
  }
  const away = await run2({
    MURMUR_MCP_URL: `http://127.0.0.1:${port}/mcp`,
    MURMUR_MCP_TOKEN: good,
  });
  assert.match(away.error.message, /isn't reachable/);
  const refused = await runStdioBridge({
    env: { MURMUR_MCP_URL: "http://evil.example/mcp", MURMUR_MCP_TOKEN: "x" },
    input: new PassThrough(),
    output: new PassThrough(),
    errors: new PassThrough(),
  });
  assert.equal(refused, 2, "a non-local URL is never used");
});

async function run2(env: Record<string, string>) {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on("data", (d) => chunks.push(String(d)));
  const done = runStdioBridge({
    env,
    input,
    output,
    errors: new PassThrough(),
  });
  input.write(JSON.stringify(INIT) + "\n");
  input.end();
  await done;
  return JSON.parse(chunks.join("").trim());
}

test("service: nothing listens until turned on; install needs confirmation inputs and a temp home", async () => {
  const { repo } = seeded();
  const home = dir("mcp-home");
  mkdirSync(join(home, ".cursor"));
  let settings = SettingsSchema.parse({});
  const listeners: ((s: Settings) => void)[] = [];
  const vault = memoryVault();
  const copied: string[] = [];
  const svc = new McpService({
    clientsFile: join(dir("mcp-svc"), "mcp-clients.json"),
    home,
    settings: {
      get: () => settings,
      onChange: (cb) => void listeners.push(cb),
    },
    meetings: repo,
    vault,
    unlock: async () => true,
    launch: () => conn.launch,
    openExtension: async () => {},
    copy: (t) => void copied.push(t),
    notify: () => {},
    version: "t",
    log: () => {},
  });
  await svc.apply();
  assert.equal(svc.status().state, "off");
  assert.equal(svc.status().enabled, false);
  await assert.rejects(svc.install("cursor"), /Turn on MCP first/);
  // Port 0 is not a valid saved setting; the service is told a free port through the settings.
  settings = {
    ...settings,
    mcp: { enabled: true, port: 49000 + Math.floor(Math.random() * 1000) },
  };
  await svc.apply();
  assert.equal(svc.status().state, "running");
  const p = svc.preview("cursor");
  assert.ok(!p.entry.includes("mmr_secret") && p.entry.includes("hidden"));
  assert.equal(p.fileExists, false);
  assert.throws(() => svc.preview("claude"), /doesn't seem to be installed/);
  const r = await svc.install("cursor");
  assert.equal(r.configPath, join(home, ".cursor", "mcp.json"));
  const written = JSON.parse(readFileSync(r.configPath, "utf8")).mcpServers
    .murmur;
  const token = written.headers.Authorization.replace("Bearer ", "");
  // The token written to the file really opens the server.
  const res = await post(
    written.url,
    { Authorization: `Bearer ${token}` },
    INIT,
  );
  assert.equal(res.status, 200);
  assert.equal(svc.status().clients[0].requests, 1);
  assert.equal(svc.status().apps.find((a) => a.kind === "cursor")?.added, true);
  svc.copy({ id: svc.status().clients[0].id, what: "token" });
  assert.equal(copied[0], token);
  await svc.remove("cursor");
  assert.equal(svc.status().clients.length, 0);
  assert.equal(
    (await post(written.url, { Authorization: `Bearer ${token}` }, INIT))
      .status,
    401,
  );
  settings = { ...settings, mcp: { ...settings.mcp, enabled: false } };
  await svc.apply();
  await assert.rejects(
    fetch(written.url),
    "the server is gone when MCP is turned off",
  );
  await svc.dispose();
});

test("page logic: status text, activity, port check", () => {
  assert.equal(serverStatus(false, "off", 47821).text, "Off");
  assert.equal(serverStatus(true, "running", 47821).tone, "success");
  assert.equal(serverStatus(true, "port-busy", 47821).tone, "danger");
  const c = {
    id: "1",
    name: "x",
    kind: "other" as const,
    createdAt: 0,
    lastAccessAt: null,
    requests: 0,
  };
  assert.equal(clientActivity(c, new Date()), "Never used");
  assert.match(
    clientActivity({ ...c, lastAccessAt: Date.now(), requests: 1 }, new Date()),
    /Just now · 1 request$/,
  );
  assert.ok(isValidPort(47821) && !isValidPort(80) && !isValidPort(70000));
});

test("clients: revokeAll deletes every token and the clients file; a token that can't be deleted keeps its client", async () => {
  const file = join(dir("mcp-reset"), "mcp-clients.json");
  const vault = memoryVault();
  const clients = new McpClients(file, vault);
  await clients.create("A", "claude");
  await clients.create("B", "other");
  assert.equal(vault.data.size, 2);
  await clients.revokeAll();
  assert.equal(vault.data.size, 0);
  assert.equal(clients.list().length, 0);
  assert.equal(existsSync(file), false);

  const c = await clients.create("C", "other");
  const stuck: TokenVault = {
    get: vault.get,
    set: async () => {
      throw new Error("keychain locked");
    },
  };
  const again = new McpClients(file, stuck);
  await assert.rejects(again.revokeAll(), /couldn't be deleted/);
  assert.deepEqual(
    again.list().map((x) => x.id),
    [c.id],
  );
  assert.equal(existsSync(file), true);
});

// ---- Config file safety --------------------------------------------------------------------

const modeOf = (p: string) => statSync(p).mode & 0o777;

test("config files: always private, backups private, unchanged re-add writes nothing", () => {
  const home = dir("mcp-home");
  const t = configTarget("cursor", home);
  mkdirSync(t.dir);
  writeFileSync(t.file, '{"mcpServers":{}}\n', { mode: 0o644 });
  const first = addEntry(t, serverEntry("cursor", conn), 1_000_000_000_000);
  assert.equal(modeOf(t.file), 0o600, "a world-readable file becomes private");
  assert.equal(modeOf(first.backupPath!), 0o600);
  const again = addEntry(t, serverEntry("cursor", conn), 1_000_000_100_000);
  assert.equal(again.changed, false);
  assert.equal(again.backupPath, null);
  assert.equal(readdirSync(t.dir).filter((f) => f.endsWith(".bak")).length, 1);
  // A new file is private too.
  const claude = configTarget("claude", home);
  mkdirSync(claude.dir, { recursive: true });
  addEntry(claude, serverEntry("claude", conn));
  assert.equal(modeOf(claude.file), 0o600);
});

test("config files: at most MAX_BACKUPS are kept, identical content reuses a backup", () => {
  const home = dir("mcp-home");
  const t = configTarget("cursor", home);
  mkdirSync(t.dir);
  writeFileSync(t.file, "{}\n");
  for (let i = 0; i < MAX_BACKUPS + 4; i++) {
    addEntry(
      t,
      serverEntry("cursor", { ...conn, token: `mmr_${i}` }),
      1_000_000_000_000 + i * 60_000,
    );
  }
  const baks = readdirSync(t.dir).filter((f) => f.endsWith(".bak"));
  assert.equal(baks.length, MAX_BACKUPS);
  for (const b of baks) assert.equal(modeOf(join(t.dir, b)), 0o600);
  // Removing and re-adding the same entry returns to content that already has a backup.
  const before = baks.length;
  removeEntry(t, 2_000_000_000_000);
  addEntry(t, serverEntry("cursor", conn), 2_000_000_060_000);
  removeEntry(t, 2_000_000_120_000);
  assert.ok(
    readdirSync(t.dir).filter((f) => f.endsWith(".bak")).length <= before,
  );
});

test("config files: a symbolic link is written through, never replaced", () => {
  const home = dir("mcp-home");
  const real = join(dir("mcp-dotfiles"), "mcp.json");
  writeFileSync(real, JSON.stringify({ mcpServers: { a: { command: "x" } } }));
  const t = configTarget("cursor", home);
  mkdirSync(t.dir);
  symlinkSync(real, t.file);
  addEntry(t, serverEntry("cursor", conn));
  assert.ok(lstatSync(t.file).isSymbolicLink(), "still a link");
  assert.equal(realpathSync(t.file), realpathSync(real));
  const written = JSON.parse(readFileSync(real, "utf8"));
  assert.ok(written.mcpServers.murmur && written.mcpServers.a);
  assert.equal(modeOf(real), 0o600);
  // The backup sits next to the real file, not in the link's folder.
  assert.ok(readdirSync(dirname(real)).some((f) => f.endsWith(".bak")));
  removeEntry(t);
  assert.ok(lstatSync(t.file).isSymbolicLink());
  assert.equal(
    JSON.parse(readFileSync(real, "utf8")).mcpServers.murmur,
    undefined,
  );

  const broken = configTarget("claude", dir("mcp-home"));
  mkdirSync(broken.dir, { recursive: true });
  symlinkSync(join(broken.dir, "nowhere.json"), broken.file);
  assert.throws(
    () => addEntry(broken, serverEntry("claude", conn)),
    ConfigFileError,
  );
  assert.ok(lstatSync(broken.file).isSymbolicLink());
});

test("config files: stripBackups takes Murmur's entry (and token) out of Murmur's backups only", () => {
  const home = dir("mcp-home");
  const t = configTarget("cursor", home);
  mkdirSync(t.dir);
  writeFileSync(
    t.file,
    JSON.stringify({ mcpServers: { a: { command: "x" } } }),
  );
  addEntry(t, serverEntry("cursor", conn), 1_000_000_000_000);
  addEntry(
    t,
    serverEntry("cursor", { ...conn, token: "mmr_other" }),
    1_000_000_060_000,
  );
  const mine = join(t.dir, "mcp.json.notes.txt");
  writeFileSync(mine, "mmr_secret in the person's own file");
  assert.equal(backupsWithEntry(t), 1);
  assert.equal(stripBackups(t), 1);
  assert.equal(backupsWithEntry(t), 0);
  for (const f of readdirSync(t.dir).filter((f) => f.endsWith(".bak"))) {
    const text = readFileSync(join(t.dir, f), "utf8");
    assert.ok(!text.includes("mmr_secret"));
    assert.ok(text.includes('"a"'), "other servers are kept");
    assert.equal(modeOf(join(t.dir, f)), 0o600);
  }
  assert.equal(readFileSync(mine, "utf8").includes("mmr_secret"), true);
});

// ---- Claude Desktop extension --------------------------------------------------------------

/** Reads the entries of a zip written by extension.ts (deflate, sizes in the central directory). */
function unzip(buf: Buffer): Map<string, Buffer> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const packed = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const start =
      local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = inflateRawSync(buf.subarray(start, start + packed));
    assert.equal(data.length, buf.readUInt32LE(p + 24));
    out.set(name, data);
    p += 46 + nameLen;
  }
  return out;
}

test("extension: a valid .mcpb manifest; the token is a sensitive user setting, not in the script", () => {
  const input = {
    url: "http://127.0.0.1:47821/mcp",
    token: "mmr_secret",
    version: "1.2.3",
  };
  const files = unzip(buildExtension(input));
  assert.deepEqual([...files.keys()].sort(), [
    "manifest.json",
    EXTENSION_SCRIPT_PATH,
  ]);
  const m = JSON.parse(files.get("manifest.json")!.toString());
  assert.equal(m.manifest_version, "0.2");
  for (const k of ["name", "version", "description", "author", "server"])
    assert.ok(m[k], k);
  assert.equal(m.version, "1.2.3");
  assert.equal(m.server.type, "node");
  assert.equal(m.server.entry_point, EXTENSION_SCRIPT_PATH);
  assert.ok(files.has(m.server.entry_point));
  assert.deepEqual(m.server.mcp_config.args, [
    "${__dirname}/" + EXTENSION_SCRIPT_PATH,
  ]);
  assert.equal(
    m.server.mcp_config.env.MURMUR_MCP_TOKEN,
    "${user_config.token}",
  );
  assert.equal(m.server.mcp_config.env.MURMUR_MCP_URL, input.url);
  assert.equal(m.user_config.token.sensitive, true);
  assert.equal(m.user_config.token.required, true);
  assert.deepEqual(m.compatibility.platforms, ["darwin"]);
  // The token appears once, as the setting's default; never in the script or the command.
  assert.ok(
    !files.get(EXTENSION_SCRIPT_PATH)!.toString().includes("mmr_secret"),
  );
  assert.ok(!JSON.stringify(m.server).includes("mmr_secret"));
  assert.deepEqual(extensionManifest(input), m);
});

test("extension script: forwards to the local server with the token, and fails clearly without it", async () => {
  const good = newToken();
  const { server } = liveServer(new Map([["c1", good]]));
  const port = await server.start(0);
  const folder = dir("mcp-ext");
  const script = join(folder, "index.mjs");
  writeFileSync(script, EXTENSION_SCRIPT);
  const run = (env: Record<string, string>, line: string) =>
    new Promise<{ code: number | null; out: string; err: string }>(
      (resolve) => {
        const child = spawn(process.execPath, [script], {
          env: { PATH: process.env.PATH ?? "", ...env },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        child.on("close", (code) => resolve({ code, out, err }));
        child.stdin.end(line + "\n");
      },
    );
  const url = `http://127.0.0.1:${port}/mcp`;
  const ok = await run(
    { MURMUR_MCP_URL: url, MURMUR_MCP_TOKEN: good },
    JSON.stringify(INIT),
  );
  assert.equal(ok.code, 0);
  assert.equal(
    JSON.parse(ok.out.trim()).result.serverInfo.name.length > 0,
    true,
  );
  const denied = await run(
    { MURMUR_MCP_URL: url, MURMUR_MCP_TOKEN: newToken() },
    JSON.stringify(INIT),
  );
  assert.match(
    JSON.parse(denied.out.trim()).error.message,
    /refused this access token/,
  );
  const none = await run({ MURMUR_MCP_URL: url }, JSON.stringify(INIT));
  assert.equal(none.code, 2);
  assert.match(none.err, /missing/);
  const remote = await run(
    { MURMUR_MCP_URL: "http://evil.example/mcp", MURMUR_MCP_TOKEN: good },
    JSON.stringify(INIT),
  );
  assert.equal(remote.code, 2, "never sends the token to a non-local address");
  await server.stop();
});

test("service: Add to Claude opens a private extension file that is deleted afterwards; Cursor still uses its config file", async () => {
  const { repo } = seeded();
  const home = dir("mcp-home");
  mkdirSync(join(home, "Library", "Application Support", "Claude"), {
    recursive: true,
  });
  const claudeCfg = configTarget("claude", home);
  writeFileSync(
    claudeCfg.file,
    JSON.stringify({
      mcpServers: {
        murmur: {
          command: "/old/Murmur",
          env: { MURMUR_MCP_TOKEN: "mmr_old" },
        },
        keep: { command: "k" },
      },
    }),
  );
  const temp = dir("mcp-tmp");
  let settings = SettingsSchema.parse({});
  const opened: {
    file: string;
    mode: number;
    dirMode: number;
    bytes: Buffer;
  }[] = [];
  const vault = memoryVault();
  const svc = new McpService({
    clientsFile: join(dir("mcp-svc"), "mcp-clients.json"),
    home,
    settings: { get: () => settings, onChange: () => {} },
    meetings: repo,
    vault,
    unlock: async () => true,
    launch: () => conn.launch,
    tempDir: temp,
    openExtension: async (file) => {
      opened.push({
        file,
        mode: modeOf(file),
        dirMode: modeOf(dirname(file)),
        bytes: readFileSync(file),
      });
    },
    copy: () => {},
    notify: () => {},
    version: "1.2.3",
    log: () => {},
  });
  settings = {
    ...settings,
    mcp: { enabled: true, port: 49000 + Math.floor(Math.random() * 1000) },
  };
  await svc.apply();
  const p = svc.preview("claude");
  assert.equal(p.method, "extension");
  assert.ok(!p.entry.includes("mmr_") || p.entry.includes("hidden"));
  assert.equal(svc.preview("claude").replaces, true);
  const r = await svc.install("claude");
  assert.equal(r.opened, true);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].mode, 0o600);
  assert.equal(opened[0].dirMode, 0o700);
  const m = JSON.parse(unzip(opened[0].bytes).get("manifest.json")!.toString());
  const token = m.user_config.token.default as string;
  assert.equal(vault.get(`mcp:${svc.status().clients[0].id}`), token);
  // The older command entry (with its token) is gone from Claude's config; other servers stay.
  const cfg = JSON.parse(readFileSync(claudeCfg.file, "utf8"));
  assert.equal(cfg.mcpServers.murmur, undefined);
  assert.ok(cfg.mcpServers.keep);
  assert.equal(svc.status().apps.find((a) => a.kind === "claude")?.added, true);
  assert.ok(existsSync(opened[0].file));
  await svc.dispose();
  assert.equal(
    existsSync(dirname(opened[0].file)),
    false,
    "deleted when Murmur quits",
  );
  assert.deepEqual(readdirSync(temp), []);

  // A failure to open Claude leaves no file behind and says so.
  const failing = new McpService({
    clientsFile: join(dir("mcp-svc"), "mcp-clients.json"),
    home,
    settings: { get: () => settings, onChange: () => {} },
    meetings: repo,
    vault: memoryVault(),
    unlock: async () => true,
    launch: () => conn.launch,
    tempDir: temp,
    openExtension: async () => {
      throw new Error("no app");
    },
    copy: () => {},
    notify: () => {},
    version: "1.2.3",
    log: () => {},
  });
  await assert.rejects(failing.install("claude"), /Couldn't open Claude/);
  assert.deepEqual(readdirSync(temp), []);
  await failing.dispose();
});
