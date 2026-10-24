import { test } from "node:test";
import assert from "node:assert/strict";
import { IdleClose, PANEL_IDLE_MS } from "../src/main/windows/idle-close.ts";

test("idle close: fires once after the idle time, restarts on touch, stops on clear", () => {
  const pending = new Map<number, { at: number; fn: () => void }>();
  let now = 0;
  let id = 0;
  const timers = {
    set: (fn: () => void, ms: number) => {
      pending.set(++id, { at: now + ms, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clear: (t: ReturnType<typeof setTimeout>) =>
      void pending.delete(t as unknown as number),
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [k, v] of [...pending])
      if (v.at <= now) {
        pending.delete(k);
        v.fn();
      }
  };
  let fired = 0;
  const idle = new IdleClose(1000, () => fired++, timers);
  idle.touch();
  advance(900);
  idle.touch(); // interaction
  advance(900);
  assert.equal(fired, 0);
  advance(200);
  assert.equal(fired, 1);
  advance(5000);
  assert.equal(fired, 1, "once");
  idle.touch();
  idle.clear();
  advance(5000);
  assert.equal(fired, 1, "cleared");
  assert.equal(PANEL_IDLE_MS, 300_000);
});
