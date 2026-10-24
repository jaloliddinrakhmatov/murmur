// Settings as a validated JSON file; secrets through an injected encryptor (Electron safeStorage
// in the app, identity in tests). Corrupt files fall back to defaults instead of crashing.
import {
  constants,
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  applyPatch,
  DEFAULT_SETTINGS,
  migrateSettings,
  parseSettingsPatch,
  SettingsSchema,
  type Settings,
} from "../../shared/settings.ts";

export interface SecretCodec {
  encrypt(plain: string): Buffer;
  decrypt(cipher: Buffer): string;
}

export const plainCodec: SecretCodec = {
  encrypt: (s) => Buffer.from(s, "utf8"),
  decrypt: (b) => b.toString("utf8"),
};

/** The parsed file; `missing` only when it doesn't exist, `unreadable` for anything else wrong. */
type JsonRead =
  { state: "ok"; value: unknown } | { state: "missing" | "unreadable" };

function readJson(path: string): JsonRead {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return {
      state:
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? "missing"
          : "unreadable",
    };
  }
  try {
    return { state: "ok", value: JSON.parse(text) };
  } catch {
    return { state: "unreadable" };
  }
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Settings from whatever the file held: a value that fails its check is dropped (so its default
 * applies) and every other setting is kept. Returns the failing paths, never their values.
 */
export function recoverSettings(raw: unknown): {
  settings: Settings;
  failed: string[];
} {
  const failed: string[] = [];
  if (!isObject(raw)) {
    return { settings: structuredClone(DEFAULT_SETTINGS), failed: ["(file)"] };
  }
  const data = structuredClone(raw);
  for (let round = 0; round < 100; round++) {
    const parsed = SettingsSchema.safeParse(data);
    if (parsed.success) return { settings: parsed.data, failed };
    for (const issue of parsed.error.issues) {
      // An array is dropped whole: its default is the empty list.
      let path = issue.path as (string | number)[];
      const firstIndex = path.findIndex((k) => typeof k === "number");
      if (firstIndex >= 0) path = path.slice(0, firstIndex);
      if (!path.length) continue;
      let parent: unknown = data;
      for (const k of path.slice(0, -1))
        parent = isObject(parent) ? parent[k] : undefined;
      const last = path[path.length - 1];
      if (isObject(parent) && last in parent) {
        delete parent[last];
        failed.push(path.join("."));
      }
    }
  }
  return { settings: structuredClone(DEFAULT_SETTINGS), failed };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  // rename is atomic on the same volume, so a crash never leaves a half-written file.
  renameSync(tmp, path);
}

export class SettingsStore {
  private readonly settingsPath: string;
  private readonly secretsPath: string;
  private readonly codec: SecretCodec;
  private current: Settings;
  private listeners = new Set<(s: Settings) => void>();

  constructor(
    dir: string,
    codec: SecretCodec,
    log?: (event: string, data?: Record<string, unknown>) => void,
  ) {
    this.settingsPath = join(dir, "settings.json");
    this.secretsPath = join(dir, "secrets.json");
    this.codec = codec;
    const file = readJson(this.settingsPath);
    if (file.state === "missing") this.current = SettingsSchema.parse({});
    else {
      const raw = file.state === "ok" ? file.value : null;
      const parsed = SettingsSchema.safeParse(raw);
      if (parsed.success) this.current = parsed.data;
      else {
        const { settings, failed } = recoverSettings(raw);
        this.current = settings;
        // Keep the original once: the next save overwrites the file.
        try {
          copyFileSync(
            this.settingsPath,
            `${this.settingsPath}.bad`,
            constants.COPYFILE_EXCL,
          );
        } catch {
          // Already backed up, or the file can't be read: nothing more to keep.
        }
        // Paths only; the values may be private text.
        log?.("settings.recovered", { failed });
      }
    }
    this.current = migrateSettings(this.current);
  }

  get(): Settings {
    return this.current;
  }

  update(patch: unknown): Settings {
    const validated = parseSettingsPatch(patch);
    this.current = applyPatch(this.current, validated);
    writeJson(this.settingsPath, this.current);
    for (const l of this.listeners) l(this.current);
    return this.current;
  }

  /**
   * Main-process writes of what a renderer patch may not set (the microphone, the extra
   * shortcuts, the account). The caller has already checked the value against the device,
   * macOS or the server.
   */
  set<K extends "microphone" | "shortcuts" | "account">(
    key: K,
    value: Settings[K],
  ): Settings {
    this.current = SettingsSchema.parse({ ...this.current, [key]: value });
    writeJson(this.settingsPath, this.current);
    for (const l of this.listeners) l(this.current);
    return this.current;
  }

  /** Back to the defaults (reset), keeping only what `keep` names. */
  reset(keep: Partial<Settings> = {}): Settings {
    this.current = { ...structuredClone(DEFAULT_SETTINGS), ...keep };
    writeJson(this.settingsPath, this.current);
    for (const l of this.listeners) l(this.current);
    return this.current;
  }

  onChange(listener: (s: Settings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The stored blobs. An unreadable file is empty for reads but an error for writes. */
  private readSecrets(forWrite = false): Record<string, string> {
    const file = readJson(this.secretsPath);
    if (file.state === "ok" && isObject(file.value))
      return file.value as Record<string, string>;
    if (file.state === "missing") return {};
    if (forWrite)
      throw new Error(
        "The saved keys couldn't be read, so nothing was changed.",
      );
    return {};
  }

  setSecret(name: string, value: string): void {
    const all = this.readSecrets(true);
    if (value) all[name] = this.codec.encrypt(value).toString("base64");
    else delete all[name];
    writeJson(this.secretsPath, all);
  }

  getSecret(name: string): string | null {
    const stored = this.readSecrets()[name];
    if (!stored) return null;
    try {
      return this.codec.decrypt(Buffer.from(stored, "base64"));
    } catch {
      return null;
    }
  }

  /** The encrypted blobs as stored (the Keychain-backed secrets decrypt them asynchronously). */
  secretBlobs(): Record<string, Buffer> {
    return Object.fromEntries(
      Object.entries(this.readSecrets()).map(([k, v]) => [
        k,
        Buffer.from(v, "base64"),
      ]),
    );
  }

  /** Stores a secret already encrypted by the Keychain. */
  setEncryptedSecret(name: string, blob: Buffer): void {
    const all = this.readSecrets(true);
    all[name] = blob.toString("base64");
    writeJson(this.secretsPath, all);
  }

  hasSecret(name: string): boolean {
    return Boolean(this.readSecrets()[name]);
  }
}

/** Secret name for a provider's API key. */
export const apiKeySecret = (provider: string) => `apiKey:${provider}`;
