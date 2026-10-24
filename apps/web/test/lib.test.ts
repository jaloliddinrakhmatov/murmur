import assert from "node:assert/strict";
import { test } from "node:test";
import { DEMO_SCRIPTS } from "../src/content/hero.ts";
import { FAQ } from "../src/content/sections.ts";
import { FEATURES } from "../src/content/features.ts";
import { FOOTER, NAV } from "../src/content/site.ts";
import {
  durations,
  finalFrame,
  frameAt,
  totalMs,
  words,
} from "../src/lib/demo.ts";
import { formatDuration, secondsFor, speedup } from "../src/lib/speed.ts";

test("demo walks listen, think, write, hold in order", () => {
  for (const script of DEMO_SCRIPTS) {
    const d = durations(script);
    assert.equal(frameAt(script, 0).phase, "listen");
    assert.equal(frameAt(script, d.listen).phase, "think");
    assert.equal(frameAt(script, d.listen + d.think).phase, "write");
    assert.equal(frameAt(script, totalMs(script) - 1).phase, "hold");
    assert.deepEqual(frameAt(script, totalMs(script) - 1), finalFrame(script));
  }
});

test("demo reveals words monotonically and never past the end", () => {
  const script = DEMO_SCRIPTS[0];
  let previous = 0;
  for (let t = 0; t <= totalMs(script); t += 50) {
    const frame = frameAt(script, t);
    assert.ok(
      frame.spokenCount >= 0 &&
        frame.spokenCount <= words(script.spoken).length,
    );
    assert.ok(frame.writtenCount >= previous);
    previous = frame.writtenCount;
  }
  assert.equal(frameAt(script, -5).phase, "listen");
});

test("speed helpers", () => {
  assert.equal(secondsFor(150, 40), 225);
  assert.equal(secondsFor(150, 150), 60);
  assert.equal(speedup(), 3.8);
  assert.equal(formatDuration(60), "60 sec");
  assert.equal(formatDuration(225), "3 min 45 sec");
  assert.equal(formatDuration(120), "2 min");
  assert.throws(() => secondsFor(10, 0));
});

test("content is well formed", () => {
  const hrefs = [...NAV, ...FOOTER.flatMap((g) => g.links)].map((l) => l.href);
  for (const href of hrefs) assert.match(href, /^\//);
  assert.equal(new Set(FEATURES.map((f) => f.id)).size, FEATURES.length);
  for (const item of FAQ) assert.ok(item.q.endsWith("?") && item.a.length > 20);
  for (const s of DEMO_SCRIPTS) assert.ok(words(s.written).length > 0);
});
