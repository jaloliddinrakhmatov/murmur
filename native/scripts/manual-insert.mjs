// Manual insertion test. Grant Accessibility to the terminal app that runs this script
// (System Settings → Privacy & Security → Accessibility), then:
//   npm run manual:insert -- "Text to insert"
// You have 5 seconds to click into a target field. Results append to results/manual-insert.jsonl.
// Remove the terminal's Accessibility grant when you are done.
import { createRequire } from "node:module";
import { appendFileSync, mkdirSync } from "node:fs";

const require = createRequire(import.meta.url);
const native = require("../index.cjs");

const text =
  process.argv[2] ?? "Murmur insertion test — héllo, привет, o‘zbekcha ✓";
const restoreDelayMs = Number(process.env.RESTORE_DELAY_MS ?? 500);

console.log("permissions:", native.permissionStatus());
for (let s = 5; s > 0; s--) {
  process.stdout.write(`Focus the target field… ${s}\r`);
  await new Promise((r) => setTimeout(r, 1000));
}

const result = native.insertText(text);
let restore = null;
if (result.snapshotId != null) {
  await new Promise((r) => setTimeout(r, restoreDelayMs));
  restore = native.clipboardRestore(
    result.snapshotId,
    result.changeCountAfterWrite,
  );
}

const record = {
  at: new Date().toISOString(),
  app: result.app,
  focus: result.focus,
  strategy: result.strategy,
  verified: result.verified,
  reason: result.reason,
  steps: result.steps,
  elapsedMs: +result.elapsedMs.toFixed(2),
  restore,
  // Filled in by the tester: did the text appear exactly once, in the right place?
  observed: process.env.OBSERVED ?? null,
};
mkdirSync(new URL("../results/", import.meta.url), { recursive: true });
appendFileSync(
  new URL("../results/manual-insert.jsonl", import.meta.url),
  JSON.stringify(record) + "\n",
);
console.log("\n", record);
