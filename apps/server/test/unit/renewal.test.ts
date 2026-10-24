import { test } from "node:test";
import assert from "node:assert/strict";
import { renewSubscription } from "../../src/domain/renewal.ts";
import type { SubscriptionState } from "../../src/domain/plan-state.ts";

const sub = (over: Partial<SubscriptionState> = {}): SubscriptionState => ({
  plan: "pro",
  interval: "monthly",
  status: "active",
  currentPeriodStart: new Date("2026-10-01T00:00:00.000Z"),
  currentPeriodEnd: new Date("2026-11-01T00:00:00.000Z"),
  cancelAtPeriodEnd: false,
  ...over,
});
const none = { months: 0, anchor: null };

test("nothing happens before the period ends", () => {
  const r = renewSubscription(
    sub(),
    none,
    new Date("2026-10-31T23:59:59.000Z"),
  );
  assert.equal(r.renewals, 0);
  assert.deepEqual(r.subscription, sub());
});

test("a monthly subscription rolls into the next period at the boundary", () => {
  const r = renewSubscription(
    sub(),
    none,
    new Date("2026-11-01T00:00:00.000Z"),
  );
  assert.equal(r.renewals, 1);
  assert.equal(
    r.subscription.currentPeriodStart.toISOString(),
    "2026-11-01T00:00:00.000Z",
  );
  assert.equal(
    r.subscription.currentPeriodEnd.toISOString(),
    "2026-12-01T00:00:00.000Z",
  );
});

test("several missed periods are rolled over in one go", () => {
  const r = renewSubscription(
    sub(),
    none,
    new Date("2027-01-15T00:00:00.000Z"),
  );
  assert.equal(r.renewals, 3);
  assert.equal(
    r.subscription.currentPeriodEnd.toISOString(),
    "2027-02-01T00:00:00.000Z",
  );
});

test("an annual subscription renews by twelve months", () => {
  const r = renewSubscription(
    sub({
      interval: "annual",
      currentPeriodEnd: new Date("2026-11-01T00:00:00.000Z"),
    }),
    none,
    new Date("2026-11-02T00:00:00.000Z"),
  );
  assert.equal(
    r.subscription.currentPeriodEnd.toISOString(),
    "2027-11-01T00:00:00.000Z",
  );
});

test("cancelAtPeriodEnd lapses the subscription instead of renewing", () => {
  const r = renewSubscription(
    sub({ cancelAtPeriodEnd: true }),
    none,
    new Date("2026-11-02T00:00:00.000Z"),
  );
  assert.equal(r.renewals, 0);
  assert.equal(r.subscription.status, "canceled");
  assert.equal(
    r.subscription.currentPeriodEnd.toISOString(),
    "2026-11-01T00:00:00.000Z",
  );
});

test("waiting referral credit extends the renewed period and is spent", () => {
  const r = renewSubscription(
    sub(),
    { months: 2, anchor: null },
    new Date("2026-11-02T00:00:00.000Z"),
  );
  assert.equal(
    r.subscription.currentPeriodEnd.toISOString(),
    "2027-02-01T00:00:00.000Z",
  );
  assert.deepEqual(r.credit, { months: 0, anchor: null });
});

test("credit that is already running is not touched", () => {
  const running = { months: 2, anchor: new Date("2026-10-15T00:00:00.000Z") };
  const r = renewSubscription(
    sub(),
    running,
    new Date("2026-11-02T00:00:00.000Z"),
  );
  assert.equal(
    r.subscription.currentPeriodEnd.toISOString(),
    "2026-12-01T00:00:00.000Z",
  );
  assert.deepEqual(r.credit, running);
});

test("non-active subscriptions are left alone", () => {
  for (const status of ["canceled", "past_due"] as const) {
    const r = renewSubscription(
      sub({ status }),
      none,
      new Date("2030-01-01T00:00:00.000Z"),
    );
    assert.equal(r.renewals, 0);
    assert.equal(r.subscription.status, status);
  }
});

test("the input is not mutated", () => {
  const s = sub();
  const c = { months: 1, anchor: null };
  renewSubscription(s, c, new Date("2027-01-01T00:00:00.000Z"));
  assert.deepEqual(s, sub());
  assert.deepEqual(c, { months: 1, anchor: null });
});
