// Encrypted local audio store. Audio is kept only to retry failed transcriptions, never uploaded
// for storage, and deleted after a successful insertion or after the retention window.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { AudioVaultPort } from "../core/types.ts";

const MAGIC = Buffer.from("MRMA1");
/** Folders `archiveAll` creates for recordings made under a key that can no longer be read. */
const ARCHIVE_FOLDER = /^unreadable-[\w.:-]+$/;

/** The recording key isn't available (Keychain locked or unreadable); nothing was touched. */
export class VaultLockedError extends Error {
  constructor() {
    super(
      "Recordings can't be opened until the Keychain allows Murmur to read its key.",
    );
    this.name = "VaultLockedError";
  }
}

export class AudioVault implements AudioVaultPort {
  private readonly dir: string;
  private readonly keySource: () => Buffer | null;

  /** `key` may be supplied later (it comes from the Keychain asynchronously). */
  constructor(dir: string, key: Buffer | (() => Buffer | null)) {
    if (Buffer.isBuffer(key) && key.length !== 32)
      throw new Error("vault key must be 32 bytes");
    this.dir = dir;
    this.keySource = Buffer.isBuffer(key) ? () => key : key;
  }

  private get key(): Buffer {
    const key = this.keySource();
    if (!key) throw new VaultLockedError();
    return key;
  }

  private path(id: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("invalid id");
    return join(this.dir, `${id}.wav.enc`);
  }

  async save(id: string, wav: Uint8Array): Promise<void> {
    const key = this.key;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([cipher.update(wav), cipher.final()]);
    await writeFile(
      this.path(id),
      Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]),
      { mode: 0o600 },
    );
  }

  async load(id: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const key = this.key;
    let file: Buffer;
    try {
      file = await readFile(this.path(id));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    if (!file.subarray(0, MAGIC.length).equals(MAGIC))
      throw new Error("not a vault file");
    const iv = file.subarray(5, 17);
    const tag = file.subarray(17, 33);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return new Uint8Array(
      Buffer.concat([decipher.update(file.subarray(33)), decipher.final()]),
    );
  }

  async remove(id: string): Promise<void> {
    await rm(this.path(id), { force: true });
  }

  /**
   * Moves every recording into `folder` inside the vault directory (kept, not deleted): used
   * when a new recording key is started, since the old recordings can't be opened with it.
   */
  async archiveAll(folder: string): Promise<number> {
    const files = await readdir(this.dir).catch(() => [] as string[]);
    const moving = files.filter((f) => f.endsWith(".wav.enc"));
    if (!moving.length) return 0;
    const target = join(this.dir, folder);
    await mkdir(target, { recursive: true, mode: 0o700 });
    for (const f of moving) await rename(join(this.dir, f), join(target, f));
    return moving.length;
  }

  /**
   * Deletes every recording in the vault, including any no History row points to any more and
   * the ones `archiveAll` set aside (`unreadable-*` folders). Called only for an explicit
   * Delete all / Reset; it needs no key, so it works whatever the Keychain's state.
   */
  async clearAll(): Promise<void> {
    const entries = await readdir(this.dir, { withFileTypes: true }).catch(
      () => [],
    );
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".wav.enc"))
        await rm(join(this.dir, e.name), { force: true });
      else if (e.isDirectory() && ARCHIVE_FOLDER.test(e.name))
        await rm(join(this.dir, e.name), { recursive: true, force: true });
    }
  }
}
