// Quit flush of meeting notes typed in the Hub, and the error text that reaches the person.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PendingSaves } from "../src/renderer/hub/model/notetaker.ts";
import { ipcErrorMessage } from "../src/renderer/hub/model/errors.ts";

test("flushAll runs every registered saver and waits for them", async () => {
  const pending = new PendingSaves();
  const done: string[] = [];
  pending.add(async () => {
    await new Promise((r) => setTimeout(r, 5));
    done.push("a");
  });
  pending.add(async () => void done.push("b"));
  await pending.flushAll();
  assert.deepEqual(done.sort(), ["a", "b"]);
});

test("a failing saver doesn't stop the others, and removed savers aren't run", async () => {
  const pending = new PendingSaves();
  const done: string[] = [];
  pending.add(() => Promise.reject(new Error("disk full")));
  pending.add(async () => void done.push("ok"));
  const remove = pending.add(async () => void done.push("removed"));
  remove();
  await pending.flushAll();
  assert.deepEqual(done, ["ok"]);
});

test("the unreadable-keys and transcribing messages reach the person unchanged", () => {
  for (const msg of [
    "The saved keys couldn't be read, so nothing was changed.",
    "This meeting is being transcribed. Change its language when that finishes.",
  ])
    assert.equal(
      ipcErrorMessage(
        new Error(`Error invoking remote method 'hub:x': Error: ${msg}`),
      ),
      msg,
    );
});
