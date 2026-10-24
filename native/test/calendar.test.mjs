import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const native = require("../index.cjs");

const ACCESS = [
  "authorized",
  "not-determined",
  "denied",
  "restricted",
  "write-only",
  "unsupported-os",
];

test("calendar status and support are readable without asking", () => {
  assert.ok(ACCESS.includes(native.calendarAccess()));
  assert.ok(
    ["available", "unsupported-os", "missing-usage-description"].includes(
      native.calendarSupport(),
    ),
  );
});

// Node has no NSCalendars…UsageDescription, so macOS would end a process that asked. The addon
// must refuse instead of prompting.
test("requesting access refuses without a usage description (no prompt)", async () => {
  assert.notEqual(native.calendarSupport(), "available");
  await assert.rejects(
    native.requestCalendarAccess(),
    /missing-usage-description|unsupported-os/,
  );
});

test("events and calendars are read only when access is already granted", async () => {
  if (native.calendarAccess() === "authorized") {
    const events = await native.listUpcomingEvents(
      Date.now(),
      Date.now() + 864e5,
      5,
    );
    assert.ok(Array.isArray(events));
    assert.ok(events.length <= 5);
    assert.ok(Array.isArray(await native.listCalendars()));
  } else {
    await assert.rejects(
      native.listUpcomingEvents(Date.now(), Date.now() + 864e5, 5),
      /not-authorized/,
    );
    await assert.rejects(native.listCalendars(), /not-authorized/);
  }
});
