import { test } from "node:test";
import assert from "node:assert/strict";
import type { CapsuleState } from "../src/shared/ipc.ts";
import {
  BARS,
  barHeights,
  levelFraction,
  present,
  pushLevel,
} from "../src/renderer/capsule/model.ts";

const ALL: CapsuleState[] = [
  "resting",
  "listening",
  "handsFree",
  "processing",
  "refining",
  "inserting",
  "inserted",
  "copied",
  "cancelled",
  "error",
  "warning",
];

test("every state has an icon, a tone and spoken text; only recording shows the waveform", () => {
  for (const s of ALL) {
    const p = present(s);
    assert.ok(p.icon && p.tone && p.spoken, s);
    assert.equal(
      p.wave,
      s === "listening" || s === "handsFree" || s === "warning",
      `${s} waveform`,
    );
    assert.equal(p.cancel, p.wave, `${s} cancel button only while recording`);
  }
});

test("inserted and copied are told apart by icon, colour and words", () => {
  const ins = present("inserted");
  const cop = present("copied");
  assert.notEqual(ins.icon, cop.icon);
  assert.notEqual(ins.tone, cop.tone);
  assert.equal(ins.text, "Inserted");
  assert.match(cop.text, /Copied.*⌘V/);
  // The controller's reason replaces the default text rather than adding to it.
  const why = present("copied", "App changed — copied, press ⌘V");
  assert.equal(why.text, "App changed — copied, press ⌘V");
  assert.equal(why.spoken, why.text);
});

test("errors carry the controller's message; nothing claims success", () => {
  const blocked = present("error", "Microphone access is off — open Settings");
  assert.equal(blocked.tone, "danger");
  assert.equal(blocked.text, "Microphone access is off — open Settings");
  for (const s of ALL.filter((x) => x !== "inserted"))
    assert.notEqual(present(s).tone === "success", true, s);
});

test("a shortcut notice shows at rest only", () => {
  const n = "Shortcut unavailable — open Settings";
  assert.equal(present("resting", undefined, n).text, n);
  assert.equal(present("resting", undefined, n).tone, "warning");
  assert.equal(present("resting").text, "");
  assert.equal(present("listening", undefined, n).text, "");
});

test("levels map to bars on a decibel scale; silence stays flat; nothing is invented", () => {
  assert.equal(levelFraction(0), 0);
  assert.equal(levelFraction(Number.NaN), 0);
  assert.equal(levelFraction(0.0005), 0, "below the noise floor");
  assert.equal(levelFraction(1), 1);
  const quiet = levelFraction(0.01);
  const loud = levelFraction(0.1);
  assert.ok(quiet > 0 && quiet < loud && loud < 1, `${quiet} ${loud}`);
  // Ordinary speech levels stay distinguishable instead of all hitting the top.
  const speech = [0.03, 0.07, 0.16].map(levelFraction);
  assert.ok(
    speech[0] < speech[1] && speech[1] < speech[2] && speech[2] < 0.9,
    String(speech),
  );
  assert.ok(speech[2] - speech[0] > 0.35, "visible spread");

  assert.deepEqual(
    barHeights([]),
    Array(BARS).fill(3),
    "flat before any audio",
  );
  let h: number[] = [];
  for (let i = 0; i < 20; i++) h = pushLevel(h, 0);
  assert.deepEqual(barHeights(h), Array(BARS).fill(3), "silence is flat");
  h = pushLevel(h, 0.2);
  const bars = barHeights(h);
  assert.equal(bars.length, BARS);
  assert.ok(bars[BARS - 1] > 3, "newest level on the right");
  assert.deepEqual(bars.slice(0, -1), Array(BARS - 1).fill(3));
  for (let i = 0; i < BARS; i++) h = pushLevel(h, 0);
  assert.deepEqual(barHeights(h), Array(BARS).fill(3), "scrolls back to flat");
  assert.equal(h.length, BARS, "bounded history");
});

test("until the microphone delivers audio, recording states say it is starting — no recording dot, no waveform", () => {
  for (const state of ["listening", "handsFree"] as const) {
    const starting = present(state, undefined, null, false);
    assert.equal(starting.text, "Starting mic…");
    assert.equal(
      starting.spoken,
      state === "handsFree"
        ? "Microphone starting, hands-free"
        : "Microphone starting",
    );
    assert.equal(starting.icon, "progress");
    assert.equal(starting.tone, "neutral");
    assert.equal(starting.wave, false);
    assert.equal(starting.cancel, true, "can still be cancelled");
    const live = present(state, undefined, null, true);
    assert.equal(live.icon, "rec");
    assert.equal(live.tone, "accent");
    assert.equal(live.wave, true);
  }
  assert.equal(present("listening").spoken, "Recording");
  assert.equal(present("processing", undefined, null, false).icon, "progress");
});
