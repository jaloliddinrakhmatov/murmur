import { test } from "node:test";
import assert from "node:assert/strict";
import { testModeFlags, testModesAllowed } from "../src/main/test-modes.ts";

test("test modes: packaged builds ignore them unless built with the flag", () => {
  assert.equal(testModesAllowed(false, false), true, "development");
  assert.equal(testModesAllowed(true, false), false, "shipped build");
  assert.equal(testModesAllowed(true, true), true, "test build");
  const argv = ["x", "--smoke", "--capture=/tmp/a", "--compare", "--latency=b"];
  assert.deepEqual(testModeFlags(argv, true), {
    smoke: true,
    capture: true,
    compare: true,
    latency: true,
  });
  assert.deepEqual(testModeFlags(argv, false), {
    smoke: false,
    capture: false,
    compare: false,
    latency: false,
  });
});
