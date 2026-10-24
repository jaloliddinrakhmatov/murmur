// Runs the Electron smoke test with a watchdog so a hang never blocks CI. Output streams to
// results/smoke.log as it happens (not buffered) and the child's exit code is propagated.
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const electron = require("electron");
// Stage 6B added real-device microphone checks (one recording per input), so the run is longer.
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 240_000);

mkdirSync(join(root, "results"), { recursive: true });
const log = createWriteStream(join(root, "results", "smoke.log"));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [root, "--smoke"], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
const forward = (chunk) => {
  const text = chunk.toString();
  log.write(text);
  if (!/sandbox_extension_issue_file/.test(text)) process.stdout.write(text);
};
child.stdout.on("data", forward);
child.stderr.on("data", forward);

const watchdog = setTimeout(() => {
  process.stdout.write(
    `\nsmoke: no exit after ${timeoutMs} ms, killing Electron\n`,
  );
  child.kill("SIGKILL");
}, timeoutMs);

child.on("exit", (code, signal) => {
  clearTimeout(watchdog);
  log.end();
  process.exit(signal ? 124 : (code ?? 1));
});
