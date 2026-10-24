// Records real measurements of the native prototype on this machine into results/.
// Uses the system clipboard and restores it afterwards. Never posts a real paste (allowPaste: false):
// with Accessibility granted that would type into whatever app is frontmost.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";

const require = createRequire(import.meta.url);
const native = require("../index.cjs");

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return {
    n: s.length,
    p50: +q(0.5).toFixed(3),
    p95: +q(0.95).toFixed(3),
    max: +s.at(-1).toFixed(3),
  };
}

function time(n, fn) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = native.nowMs();
    fn(i);
    out.push(native.nowMs() - t);
  }
  return stats(out);
}

const original = native.clipboardSnapshot();
const results = {
  measuredAt: new Date().toISOString(),
  machine: {
    macos: execFileSync("sw_vers", ["-productVersion"]).toString().trim(),
    arch: os.arch(),
    cpu: os.cpus()[0]?.model,
    node: process.version,
  },
  permissions: native.permissionStatus(),
};

const interesting =
  /\.(US|ABC|British|Dvorak|DVORAK-QWERTYCMD|Colemak|French|German|Russian|RussianWin|Russian-Phonetic|Ukrainian|Uzbek.*|Turkish.*|Kazakh)$/;
const layouts = native.pasteKeycodesForInstalledLayouts();
results.layouts = {
  installedCount: layouts.length,
  withoutLatinV: layouts
    .filter((l) => l.keycode == null)
    .map((l) => l.sourceId),
  selected: layouts
    .filter((l) => interesting.test(l.sourceId))
    .map(({ sourceId, keycode, keycodeToPost, ansiVTypes }) => ({
      sourceId,
      keycode,
      keycodeToPost,
      ansiVTypes,
    })),
  current: native.pasteKeycode(),
};

results.timingsMs = {
  frontmostApp: time(50, () => native.frontmostApp()),
  focusedElement: time(50, () => native.focusedElement()),
  clipboardSnapshot: time(100, () =>
    native.clipboardDiscardSnapshot(native.clipboardSnapshot()),
  ),
  clipboardWriteText: time(100, (i) =>
    native.clipboardWriteText(`measure ${i}`, true),
  ),
  snapshotWriteRestoreCycle: time(100, (i) => {
    const snap = native.clipboardSnapshot();
    const cc = native.clipboardWriteText(`cycle ${i}`, true);
    native.clipboardRestore(snap, cc);
  }),
  insertTextChainCurrentPermissions: time(30, (i) =>
    native.insertText(`chain ${i}`, { allowPaste: false }),
  ),
  carbonRegisterUnregister: time(50, (i) => {
    native.registerHotkey(1000 + i, "ctrl+opt+f9", {}, () => {});
    native.unregisterHotkey(1000 + i);
  }),
};
results.insertTextResultCurrentPermissions = (({
  strategy,
  reason,
  steps,
}) => ({ strategy, reason, steps }))(
  native.insertText("final sample", { allowPaste: false }),
);

const restored = native.clipboardRestore(
  original,
  native.clipboardChangeCount(),
);
results.userClipboardRestored = restored.restored;

mkdirSync(new URL("../results/", import.meta.url), { recursive: true });
const out = new URL("../results/native-measurements.json", import.meta.url);
writeFileSync(out, JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify(results, null, 2));
