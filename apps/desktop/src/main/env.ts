// Developer environment overrides. A `.env` file next to the app (apps/desktop/.env, gitignored) is
// read at startup; variables already in the process environment win. See .env.example.
import { existsSync, readFileSync } from "node:fs";

export function loadDotEnv(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, "$2");
    if (env[m[1]] === undefined) env[m[1]] = value;
  }
}

export interface EnvOverrides {
  provider?: string;
  apiKey?: string;
  model?: string;
  whisperUrl?: string;
  shortcut?: string;
}

export function readEnvOverrides(
  env: NodeJS.ProcessEnv = process.env,
): EnvOverrides {
  return {
    provider: env.MURMUR_SPEECH_PROVIDER,
    apiKey: env.MURMUR_SPEECH_API_KEY,
    model: env.MURMUR_SPEECH_MODEL,
    whisperUrl: env.MURMUR_WHISPER_URL,
    shortcut: env.MURMUR_SHORTCUT,
  };
}
