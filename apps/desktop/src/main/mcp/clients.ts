// MCP clients: one named, revocable bearer token each. Tokens are kept only through Murmur's
// secure storage (the Keychain-backed secrets); this file holds just names, kinds and counts.
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { McpClientInfo, McpClientKind } from "../../shared/mcp.ts";
import { MCP_CLIENT_KINDS } from "../../shared/mcp.ts";
import { newToken } from "./guard.ts";

/** The Keychain-backed secrets (KeychainSecrets.set and SettingsStore.getSecret in the app). */
export interface TokenVault {
  get(name: string): string | null;
  set(name: string, value: string): Promise<void>;
}

const secretName = (id: string) => `mcp:${id}`;

const FileSchema = z.object({
  clients: z.array(
    z.object({
      id: z.string().min(1).max(64),
      name: z.string().min(1).max(60),
      kind: z.enum(MCP_CLIENT_KINDS),
      createdAt: z.number(),
      lastAccessAt: z.number().nullable(),
      requests: z.number().int().min(0),
    }),
  ),
});

export class McpClients {
  private clients: McpClientInfo[] = [];
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly file: string;
  private readonly vault: TokenVault;
  private readonly now: () => number;

  constructor(file: string, vault: TokenVault, now: () => number = Date.now) {
    this.file = file;
    this.vault = vault;
    this.now = now;
    try {
      const parsed = FileSchema.safeParse(
        JSON.parse(readFileSync(file, "utf8")),
      );
      if (parsed.success) this.clients = parsed.data.clients;
    } catch {
      // No file yet, or unreadable: no clients (their tokens stay in secure storage, unused).
    }
  }

  list(): McpClientInfo[] {
    return this.clients.map((c) => ({ ...c }));
  }

  get(id: string): McpClientInfo | null {
    const c = this.clients.find((x) => x.id === id);
    return c ? { ...c } : null;
  }

  /** The first client of this kind (the one "Add to Claude" reuses). */
  ofKind(kind: McpClientKind): McpClientInfo | null {
    const c = this.clients.find((x) => x.kind === kind);
    return c ? { ...c } : null;
  }

  async create(name: string, kind: McpClientKind): Promise<McpClientInfo> {
    const id = randomBytes(8).toString("hex");
    // The token is saved first: a client without a token can never be listed.
    await this.vault.set(secretName(id), newToken());
    const client: McpClientInfo = {
      id,
      name,
      kind,
      createdAt: this.now(),
      lastAccessAt: null,
      requests: 0,
    };
    this.clients.push(client);
    this.save();
    return { ...client };
  }

  /** Deletes the client and its token; its requests fail with 401 from now on. */
  async revoke(id: string): Promise<boolean> {
    if (!this.clients.some((c) => c.id === id)) return false;
    this.clients = this.clients.filter((c) => c.id !== id);
    this.save();
    await this.vault.set(secretName(id), "");
    return true;
  }

  /**
   * Revokes every client and deletes the clients file. A token that can't be deleted (secure
   * storage unreadable) keeps its client listed, so it can be revoked later; that is an error.
   */
  async revokeAll(): Promise<void> {
    const kept: McpClientInfo[] = [];
    for (const c of this.clients) {
      try {
        await this.vault.set(secretName(c.id), "");
      } catch {
        kept.push(c);
      }
    }
    this.clients = kept;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.dirty = false;
    if (kept.length) {
      this.save();
      throw new Error("Some MCP access tokens couldn't be deleted.");
    }
    rmSync(this.file, { force: true });
  }

  token(id: string): string | null {
    return this.clients.some((c) => c.id === id)
      ? this.vault.get(secretName(id))
      : null;
  }

  /** Every readable token of a client that isn't revoked. */
  tokens(): Map<string, string> {
    const out = new Map<string, string>();
    for (const c of this.clients) {
      const t = this.vault.get(secretName(c.id));
      if (t) out.set(c.id, t);
    }
    return out;
  }

  /** Counts and the time only. Saved a moment later, so a busy client doesn't hammer the disk. */
  recordAccess(id: string): void {
    const c = this.clients.find((x) => x.id === id);
    if (!c) return;
    c.lastAccessAt = this.now();
    c.requests += 1;
    this.dirty = true;
    this.timer ??= setTimeout(() => this.flush(), 2000);
    this.timer.unref();
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty) return;
    this.save();
  }

  private save(): void {
    this.dirty = false;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ clients: this.clients }, null, 2), {
      mode: 0o600,
    });
    renameSync(tmp, this.file);
  }
}
