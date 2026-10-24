import { test } from "node:test";
import assert from "node:assert/strict";
import { addMonths } from "../../src/domain/dates.ts";
import {
  creditWindow,
  grantCredit,
  resolvePlanState,
} from "../../src/domain/plan-state.ts";
import type { SubscriptionState } from "../../src/domain/plan-state.ts";

const now = new Date("2026-10-20T12:00:00.000Z");
const none = { months: 0, anchor: null };
const sub = (over: Partial<SubscriptionState> = {}): SubscriptionState => ({
  plan: "pro",
  interval: "monthly",
  status: "active",
  currentPeriodStart: new Date("2026-10-01T00:00:00.000Z"),
  currentPeriodEnd: new Date("2026-11-01T00:00:00.000Z"),
  cancelAtPeriodEnd: false,
  ...over,
});

test("free when there is nothing", () => {
  const r = resolvePlanState({
    now,
    subscription: null,
    teamTrialEndsAt: null,
    credit: none,
  });
  assert.deepEqual(r.plan, { tier: "free", source: "none", until: null });
  assert.equal(r.startCredit, false);
});

test("subscription wins over trial and credit", () => {
  const r = resolvePlanState({
    now,
    subscription: sub(),
    teamTrialEndsAt: new Date("2026-10-30T00:00:00.000Z"),
    credit: { months: 3, anchor: null },
  });
  assert.equal(r.plan.source, "subscription");
  assert.equal(r.plan.until?.toISOString(), "2026-11-01T00:00:00.000Z");
  assert.equal(r.startCredit, false);
});

test("a lapsed or canceled subscription doesn't count; a canceling one still does until its end", () => {
  const lapsed = resolvePlanState({
    now,
    subscription: sub({
      currentPeriodEnd: new Date("2026-10-19T00:00:00.000Z"),
    }),
    teamTrialEndsAt: null,
    credit: none,
  });
  assert.equal(lapsed.plan.tier, "free");
  const canceled = resolvePlanState({
    now,
    subscription: sub({ status: "canceled" }),
    teamTrialEndsAt: null,
    credit: none,
  });
  assert.equal(canceled.plan.tier, "free");
  const canceling = resolvePlanState({
    now,
    subscription: sub({ cancelAtPeriodEnd: true }),
    teamTrialEndsAt: null,
    credit: none,
  });
  assert.equal(canceling.plan.source, "subscription");
});

test("team trial beats credit, and credit waits (not started) while the trial runs", () => {
  const trialEnd = new Date("2026-10-30T00:00:00.000Z");
  const r = resolvePlanState({
    now,
    subscription: null,
    teamTrialEndsAt: trialEnd,
    credit: { months: 1, anchor: null },
  });
  assert.deepEqual([r.plan.source, r.plan.until], ["trial", trialEnd]);
  assert.equal(r.startCredit, false);
});

test("an ended trial falls through to credit, which starts now", () => {
  const r = resolvePlanState({
    now,
    subscription: null,
    teamTrialEndsAt: new Date("2026-10-01T00:00:00.000Z"),
    credit: { months: 2, anchor: null },
  });
  assert.equal(r.plan.source, "referral");
  assert.equal(r.plan.until?.toISOString(), addMonths(now, 2).toISOString());
  assert.equal(r.startCredit, true);
});

test("running credit ends at anchor + months and is free afterwards", () => {
  const anchor = new Date("2026-10-01T12:00:00.000Z");
  const active = resolvePlanState({
    now,
    subscription: null,
    teamTrialEndsAt: null,
    credit: { months: 2, anchor },
  });
  assert.equal(active.plan.until?.toISOString(), "2026-12-01T12:00:00.000Z");
  assert.equal(active.startCredit, false);
  const done = resolvePlanState({
    now: new Date("2026-12-01T12:00:00.000Z"),
    subscription: null,
    teamTrialEndsAt: null,
    credit: { months: 2, anchor },
  });
  assert.equal(done.plan.tier, "free");
});

test("creditWindow counts whole months consumed", () => {
  const anchor = new Date("2026-01-31T00:00:00.000Z");
  const credit = { months: 3, anchor };
  assert.deepEqual(
    creditWindow(credit, new Date("2026-02-15T00:00:00.000Z")).remaining,
    3,
  );
  assert.equal(
    creditWindow(credit, new Date("2026-02-28T00:00:00.000Z")).remaining,
    2,
  ); // Jan 31 + 1 month = Feb 28
  assert.equal(
    creditWindow(credit, new Date("2026-04-30T00:00:00.000Z")).remaining,
    0,
  );
  assert.equal(
    creditWindow(credit, new Date("2026-04-30T00:00:00.000Z")).phase,
    "exhausted",
  );
  assert.equal(creditWindow(none, now).phase, "none");
  assert.deepEqual(creditWindow({ months: 2, anchor: null }, now), {
    phase: "pending",
    remaining: 2,
  });
});

test("grantCredit extends a running window but restarts an exhausted one", () => {
  const anchor = new Date("2026-10-01T00:00:00.000Z");
  assert.deepEqual(grantCredit({ months: 1, anchor }, 1, now), {
    months: 2,
    anchor,
  });
  assert.deepEqual(grantCredit({ months: 1, anchor: null }, 1, now), {
    months: 2,
    anchor: null,
  });
  const old = { months: 1, anchor: new Date("2026-01-01T00:00:00.000Z") };
  assert.deepEqual(grantCredit(old, 1, now), { months: 1, anchor: null });
  assert.deepEqual(grantCredit(none, 1, now), { months: 1, anchor: null });
});

test("addMonths clamps to the end of shorter months and crosses years", () => {
  assert.equal(
    addMonths(new Date("2026-01-31T00:00:00.000Z"), 1).toISOString(),
    "2026-02-28T00:00:00.000Z",
  );
  assert.equal(
    addMonths(new Date("2028-01-31T00:00:00.000Z"), 1).toISOString(),
    "2028-02-29T00:00:00.000Z",
  );
  assert.equal(
    addMonths(new Date("2026-11-15T10:00:00.000Z"), 3).toISOString(),
    "2027-02-15T10:00:00.000Z",
  );
  assert.equal(
    addMonths(new Date("2026-03-15T00:00:00.000Z"), 12).toISOString(),
    "2027-03-15T00:00:00.000Z",
  );
});
