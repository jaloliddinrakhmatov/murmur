// Needs an addon built with the off-by-default feature:
//   cargo build --release -p murmur-native --features key-tap
// Manual test of the listen-only event tap with a modifier-only push-to-talk key.
// Grant Input Monitoring to the terminal app (not Accessibility), then:
//   npm run manual:hotkeys            # Right Option = push-to-talk, Esc = cancel
// Hold Right Option, tap it, double-tap it, and press Right Option+K to see the state machine.
// Ctrl+C to exit. Carbon (modifier+key) delivery is tested in the Electron prototype instead,
// because Carbon events need the AppKit main run loop that Node does not run.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const native = require("../index.cjs");

const RIGHT_OPTION = 61;
const ESCAPE = 53;
const RIGHT_OPTION_FLAG = 0x40; // NX_DEVICERALTKEYMASK: distinguishes right from left Option

const hold = new native.HoldToTalk();
const log = (what, t, outputs) =>
  console.log(
    `${t.toFixed(1).padStart(9)}ms ${what.padEnd(14)} → [${outputs.join(", ")}] state=${hold.state}`,
  );

let rightOptionDown = false;
const start = native.startKeyTap(
  { requestPermission: process.argv.includes("--request") },
  (e) => {
    if (e.kind === "flags" && e.keycode === RIGHT_OPTION) {
      const down = (e.flags & RIGHT_OPTION_FLAG) !== 0;
      if (down !== rightOptionDown) {
        rightOptionDown = down;
        const lag = native.nowMs() - e.tMs;
        log(
          down ? "trigger down" : "trigger up",
          e.tMs,
          hold.handle(down ? "down" : "up", e.tMs),
        );
        console.log(`           callback→JS lag ${lag.toFixed(2)}ms`);
      }
    } else if (e.kind === "down" && e.keycode === ESCAPE) {
      log("escape", e.tMs, hold.handle("cancel", e.tMs));
    } else if (e.kind === "down" && !e.isRepeat) {
      log(`other key ${e.keycode}`, e.tMs, hold.handle("other", e.tMs));
    }
  },
);

if (!start.ok) {
  console.error("Event tap did not start:", start.error);
  console.error(
    "Grant Input Monitoring to this terminal (or rerun with --request to show the prompt).",
  );
  process.exit(1);
}
console.log("Listening (listen-only tap). Ctrl+C to quit.");
setInterval(() => {
  const t = native.nowMs();
  const out = hold.handle("tick", t);
  if (out.length) log("tick", t, out);
}, 50);
process.on("SIGINT", () => {
  native.stopKeyTap();
  process.exit(0);
});
