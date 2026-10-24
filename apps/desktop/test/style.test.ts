import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanup } from "@murmur/text";
import {
  levelFor,
  SAMPLE_DICTATION,
  STYLE_LEVELS,
} from "../src/renderer/hub/model/style.ts";
import { CLEANUP_MODES } from "../src/shared/settings.ts";

test("style levels are the existing cleanup modes, one each, in order", () => {
  assert.deepEqual(
    STYLE_LEVELS.map((l) => [l.name, l.mode]),
    [
      ["None", "off"],
      ["Light", "deterministic"],
      ["Medium", "ai"],
    ],
  );
  assert.deepEqual(
    [...STYLE_LEVELS.map((l) => l.mode)].sort(),
    [...CLEANUP_MODES].sort(),
    "every setting value has exactly one level",
  );
  assert.equal(levelFor("ai").name, "Medium");
});

test("None and Light examples are Murmur's real output; only Medium is illustrative", () => {
  const [none, light, medium] = STYLE_LEVELS;
  assert.equal(none.example, SAMPLE_DICTATION);
  assert.equal(light.example, cleanup(SAMPLE_DICTATION, "light").text);
  assert.ok(!/\b(um|uh)\b/.test(light.example), "fillers removed");
  assert.ok(light.example.endsWith("."));
  assert.deepEqual(
    STYLE_LEVELS.map((l) => l.exampleIsReal),
    [true, true, false],
  );
  assert.ok(medium.example.length > 0);
});
