import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mergeEnv } from "./env-file.ts";

/** Merges `updates` into the .env file at `path` and leaves it readable by the owner only. */
export function updateEnvFile(path: string, updates: Record<string, string>) {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  writeFileSync(path, mergeEnv(existing, updates), { mode: 0o600 });
  chmodSync(path, 0o600);
}
