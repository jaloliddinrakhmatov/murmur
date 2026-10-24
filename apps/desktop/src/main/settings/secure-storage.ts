// Secure storage for Murmur's secrets (Stage 8 Keychain fix). The macOS Keychain is reached only
// through Electron's asynchronous safeStorage API, off the critical start-up path: an unanswered
// Keychain dialog no longer freezes the app (the synchronous API blocked the main process ~97 s,
// measured). Nothing is ever stored or read in plaintext, existing encrypted data is never
// replaced or deleted because the Keychain is unavailable, and a late answer is applied safely.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type SecureState = "checking" | "available" | "unavailable";

/** The OS keychain, as Electron's async safeStorage exposes it (a fake in tests). */
export interface KeychainPort {
  isAvailable(): Promise<boolean>;
  encrypt(text: string): Promise<Buffer>;
  decrypt(blob: Buffer): Promise<string>;
}

export class SecureStorageUnavailable extends Error {
  constructor() {
    super("Secure storage (the macOS Keychain) isn't available.");
    this.name = "SecureStorageUnavailable";
  }
}

type Log = (event: string, data?: Record<string, unknown>) => void;

/**
 * One Keychain availability check at a time; concurrent callers share it, so they produce at
 * most one macOS dialog. The check is never abandoned on a timer (the UI shows "waiting"
 * instead), and whatever macOS answers, however late, becomes the state.
 */
export class SecureStorage {
  private current: SecureState = "checking";
  private pending: Promise<boolean> | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly port: KeychainPort;
  private readonly log: Log;

  constructor(port: KeychainPort, log: Log) {
    this.port = port;
    this.log = log;
  }

  get state(): SecureState {
    return this.current;
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private set(state: SecureState): void {
    if (state === this.current) return;
    this.current = state;
    for (const l of this.listeners) l();
  }

  /**
   * Whether the Keychain can be used: starts the first check, or joins the one in progress.
   * Once macOS has said no, this answers false at once — it never raises another dialog on its
   * own; only `retry()` (the person's "Try again") asks macOS again.
   */
  ready(): Promise<boolean> {
    if (this.current === "available") return Promise.resolve(true);
    if (this.pending) return this.pending;
    if (this.current === "unavailable") return Promise.resolve(false);
    return this.check();
  }

  /** Asks macOS again (or joins a request already in progress). */
  retry(): Promise<boolean> {
    if (this.current === "available") return Promise.resolve(true);
    return this.pending ?? this.check();
  }

  private check(): Promise<boolean> {
    const started = Date.now();
    this.set("checking");
    this.pending = this.port
      .isAvailable()
      .catch(() => false)
      .then((ok) => {
        this.pending = null;
        this.log("secure-storage.check", {
          available: ok,
          ms: Date.now() - started,
        });
        this.set(ok ? "available" : "unavailable");
        return ok;
      });
    return this.pending;
  }

  async encrypt(text: string): Promise<Buffer> {
    if (!(await this.ready())) throw new SecureStorageUnavailable();
    return this.port.encrypt(text);
  }

  async decrypt(blob: Buffer): Promise<string> {
    if (!(await this.ready())) throw new SecureStorageUnavailable();
    return this.port.decrypt(blob);
  }
}

/** Where the saved API keys come from; the settings store holds the encrypted blobs. */
export interface SecretBlobs {
  secretBlobs(): Record<string, Buffer>;
  setEncryptedSecret(name: string, blob: Buffer): void;
  setSecret(name: string, value: string): void;
}

export type SecretStatus = "absent" | "ready" | "locked" | "unreadable";

/**
 * API keys decrypted into memory once the Keychain allows it. Until then a saved key reads as
 * "locked" (never as missing, never as garbled text); one the Keychain can't decrypt reads as
 * "unreadable" and stays on disk untouched.
 */
export class KeychainSecrets {
  private readonly plain = new Map<string, string>();
  private readonly unreadable = new Set<string>();
  private readonly blobs: SecretBlobs;
  private readonly secure: SecureStorage;
  private readonly log: Log;

  constructor(blobs: SecretBlobs, secure: SecureStorage, log: Log) {
    this.blobs = blobs;
    this.secure = secure;
    this.log = log;
  }

  /** For the settings store's codec: plaintext only for a blob already decrypted. */
  decryptCached(blob: Buffer): string {
    const value = this.plain.get(blob.toString("base64"));
    if (value === undefined) throw new SecureStorageUnavailable();
    return value;
  }

  /** Decrypts every saved key (when the Keychain is available). Safe to call again. */
  async unlock(): Promise<void> {
    if (!(await this.secure.ready())) return;
    let failed = 0;
    for (const blob of Object.values(this.blobs.secretBlobs())) {
      const id = blob.toString("base64");
      if (this.plain.has(id)) continue;
      try {
        this.plain.set(id, await this.secure.decrypt(blob));
        this.unreadable.delete(id);
      } catch {
        this.unreadable.add(id);
        failed++;
      }
    }
    this.log("secure-storage.secrets", {
      ready: this.plain.size,
      unreadable: failed,
    });
  }

  /** Saves a key encrypted by the Keychain; an empty value removes it. */
  async set(name: string, value: string): Promise<void> {
    if (!value) return this.blobs.setSecret(name, "");
    const blob = await this.secure.encrypt(value);
    this.blobs.setEncryptedSecret(name, blob);
    this.plain.set(blob.toString("base64"), value);
  }

  status(name: string): SecretStatus {
    const blob = this.blobs.secretBlobs()[name];
    if (!blob) return "absent";
    const id = blob.toString("base64");
    if (this.plain.has(id)) return "ready";
    return this.unreadable.has(id) ? "unreadable" : "locked";
  }

  get unreadableCount(): number {
    return this.unreadable.size;
  }
}

export type VaultKeyState = "pending" | "ready" | "locked" | "unreadable";

/**
 * The recording vault's 32-byte key, stored encrypted by the Keychain in `vault.key`. It is
 * created only when none exists and the Keychain is available; it is never replaced
 * automatically. While it can't be read, recording files are kept but can't be opened or added.
 */
export class VaultKey {
  key: Buffer | null = null;
  state: VaultKeyState = "pending";
  private readonly path: string;
  private readonly secure: SecureStorage;
  private readonly log: Log;
  private loading: Promise<void> | null = null;

  constructor(dir: string, secure: SecureStorage, log: Log) {
    this.path = join(dir, "vault.key");
    this.secure = secure;
    this.log = log;
  }

  /**
   * The person's explicit, confirmed choice to start a new recording key because the current
   * one can't be read. Only then, and only with the Keychain available. The unreadable key file
   * is kept under another name (never overwritten), so it could still be used if the old
   * Keychain secret ever came back. Returns the backup's file name.
   */
  async replaceUnreadable(stamp: string): Promise<string> {
    if (this.state !== "unreadable")
      throw new Error(
        "The recording key isn't unreadable; nothing to replace.",
      );
    if (!(await this.secure.ready())) throw new SecureStorageUnavailable();
    const backup = `${this.path}.unreadable-${stamp}`;
    const key = randomBytes(32);
    // Encrypted first: if the Keychain refuses, the old key file is still exactly where it was.
    const blob = await this.secure.encrypt(key.toString("base64"));
    if (existsSync(this.path)) renameSync(this.path, backup);
    this.writeKeyFile(blob);
    this.key = key;
    this.state = "ready";
    this.log("vault.key.replaced-by-user", {});
    return backup;
  }

  load(): Promise<void> {
    if (this.state === "ready") return Promise.resolve();
    this.loading ??= this.doLoad().finally(() => (this.loading = null));
    return this.loading;
  }

  /** Written beside the key file and renamed into place, so a crash never leaves half a key. */
  private writeKeyFile(blob: Buffer): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, blob, { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  private async doLoad(): Promise<void> {
    try {
      await this.loadOrCreate();
    } catch (err) {
      // The Keychain refused (or failed) while creating the key: nothing was written, and the
      // next load() tries again.
      this.state = "locked";
      this.log("vault.key.create-failed", { error: String(err) });
    }
  }

  private async loadOrCreate(): Promise<void> {
    if (!(await this.secure.ready())) {
      this.state = "locked";
      return;
    }
    if (existsSync(this.path)) {
      try {
        const key = Buffer.from(
          await this.secure.decrypt(readFileSync(this.path)),
          "base64",
        );
        if (key.length !== 32) throw new Error("wrong length");
        this.key = key;
        this.state = "ready";
      } catch {
        // Kept as is: replacing it would orphan every saved recording.
        this.state = "unreadable";
        this.log("vault.key.unreadable", {});
      }
      return;
    }
    const key = randomBytes(32);
    this.writeKeyFile(await this.secure.encrypt(key.toString("base64")));
    this.key = key;
    this.state = "ready";
    this.log("vault.key.created", {});
  }
}

/**
 * An isolated keychain for throwaway runs (smoke, capture, compare, latency): AES-256-GCM with a
 * random key that lives only in this process. Automated runs never touch the real macOS
 * Keychain, so they can't raise Keychain dialogs or read the user's items.
 */
export function testKeychain(
  /** Simulated macOS behaviour: "hang" (dialog never answered), "deny", "delay:<ms>". */
  mode = "available",
): KeychainPort {
  const key = randomBytes(32);
  const delay = /^delay:(\d+)$/.exec(mode);
  return {
    isAvailable: () =>
      mode === "hang"
        ? new Promise<boolean>(() => {})
        : mode === "deny"
          ? Promise.resolve(false)
          : delay
            ? new Promise((r) => setTimeout(() => r(true), Number(delay[1])))
            : Promise.resolve(true),
    encrypt: async (text) => {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([c.update(text, "utf8"), c.final()]);
      return Buffer.concat([Buffer.from("tk1"), iv, c.getAuthTag(), body]);
    },
    decrypt: async (blob) => {
      if (blob.subarray(0, 3).toString() !== "tk1")
        throw new Error("not a test-keychain blob");
      const d = createDecipheriv("aes-256-gcm", key, blob.subarray(3, 15));
      d.setAuthTag(blob.subarray(15, 31));
      return Buffer.concat([d.update(blob.subarray(31)), d.final()]).toString(
        "utf8",
      );
    },
  };
}
