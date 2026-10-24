import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  BillingResponse,
  CheckoutResponse,
  PlansResponse,
} from "@murmur/account-api";
import { DAY, qualifyFriend, startApp } from "./harness.ts";
import type { Harness, Session } from "./harness.ts";

let h: Harness;
before(async () => {
  h = await startApp();
});
after(() => h.close());

const checkout = (s: Session, body: unknown) =>
  h.call("POST", "/billing/checkout", { token: s.accessToken, body });
const billing = async (s: Session) =>
  (await h.call("GET", "/billing", { token: s.accessToken })).body;

test("plans: catalog in the contract shape; annual is discounted; enterprise is contact-us", async () => {
  const s = await h.signIn();
  const m = await h.call("GET", "/billing/plans", { token: s.accessToken });
  assert.equal(PlansResponse.safeParse(m.body).success, true);
  assert.equal(m.body.interval, "monthly");
  const pro = (r: any) => r.plans.find((p: any) => p.id === "pro");
  assert.equal(pro(m.body).priceCents, 1000);
  assert.equal(pro(m.body).discountPct, 0);
  const a = await h.call("GET", "/billing/plans?interval=annual", {
    token: s.accessToken,
  });
  assert.equal(pro(a.body).priceCents, 800);
  assert.equal(pro(a.body).discountPct, 20);
  const ent = a.body.plans.find((p: any) => p.id === "enterprise");
  assert.equal(ent.priceCents, null);
  assert.equal(ent.priceIsFrom, true);
  assert.equal(a.body.plans.find((p: any) => p.id === "free").priceCents, 0);
  assert.equal(
    (
      await h.call("GET", "/billing/plans?interval=weekly", {
        token: s.accessToken,
      })
    ).body.code,
    "bad-request",
  );
});

test("billing for a free user", async () => {
  const s = await h.signIn();
  const b = await h.call("GET", "/billing", { token: s.accessToken });
  assert.equal(BillingResponse.safeParse(b.body).success, true);
  assert.equal(b.body.subscription, null);
  assert.equal(b.body.testMode, true);
  assert.equal(b.body.promo, null);
  assert.deepEqual(b.body.plan, { tier: "free", source: "none", until: null });
});

test("checkout (test mode) activates Pro immediately; nothing is charged", async () => {
  const s = await h.signIn();
  const r = await checkout(s, { plan: "pro", interval: "monthly", seats: 3 });
  assert.equal(r.status, 200);
  assert.equal(CheckoutResponse.safeParse(r.body).success, true);
  assert.equal(r.body.kind, "activated");
  const b = r.body.billing;
  assert.equal(b.testMode, true);
  assert.equal(b.plan.tier, "pro");
  assert.equal(b.plan.source, "subscription");
  assert.equal(b.subscription.seats, 3);
  assert.equal(b.subscription.interval, "monthly");
  assert.equal(b.subscription.status, "active");
  assert.equal(b.subscription.cancelAtPeriodEnd, false);
  const days = (Date.parse(b.subscription.currentPeriodEnd) - Date.now()) / DAY;
  assert.ok(days > 27 && days < 32);
  assert.equal(b.plan.until, b.subscription.currentPeriodEnd);
  assert.equal(
    (await h.call("GET", "/me", { token: s.accessToken })).body.plan.source,
    "subscription",
  );

  const annual = await checkout(s, { plan: "pro", interval: "annual" });
  assert.equal(annual.body.billing.subscription.seats, 1);
  const yr =
    (Date.parse(annual.body.billing.subscription.currentPeriodEnd) -
      Date.now()) /
    DAY;
  assert.ok(yr > 360 && yr < 370);
});

test("checkout validation and the enterprise contact answer", async () => {
  const s = await h.signIn();
  const ent = await checkout(s, { plan: "enterprise", interval: "annual" });
  assert.deepEqual(ent.body, {
    kind: "contact",
    email: "sales@murmur.example",
  });
  assert.equal((await billing(s)).subscription, null);
  assert.equal(
    (await checkout(s, { plan: "free", interval: "monthly" })).body.code,
    "bad-request",
  );
  assert.equal(
    (await checkout(s, { plan: "pro", interval: "monthly", seats: 0 })).body
      .code,
    "bad-request",
  );
  assert.equal(
    (await checkout(s, { plan: "pro", interval: "monthly", seats: 1001 })).body
      .code,
    "bad-request",
  );
});

test("cancel keeps Pro until the period ends, then falls back to free", async () => {
  const t = await startApp();
  try {
    const s = await t.signIn();
    assert.equal(
      (await t.call("POST", "/billing/cancel", { token: s.accessToken })).body
        .code,
      "conflict",
    );
    await t.call("POST", "/billing/checkout", {
      token: s.accessToken,
      body: { plan: "pro", interval: "monthly" },
    });
    const c = await t.call("POST", "/billing/cancel", { token: s.accessToken });
    assert.equal(BillingResponse.safeParse(c.body).success, true);
    assert.equal(c.body.subscription.cancelAtPeriodEnd, true);
    assert.equal(c.body.plan.tier, "pro");
    t.clock.advance(33 * DAY);
    const s2 = await t.signIn(s.email);
    const after = await t.call("GET", "/billing", { token: s2.accessToken });
    assert.deepEqual(after.body.plan, {
      tier: "free",
      source: "none",
      until: null,
    });
    assert.equal(after.body.subscription.status, "canceled");
    assert.equal(
      (await t.call("POST", "/billing/cancel", { token: s2.accessToken })).body
        .code,
      "conflict",
    );
  } finally {
    await t.close();
  }
});

test("an active subscription renews; waiting referral credit extends the period at renewal", async () => {
  const t = await startApp();
  try {
    const owner = await t.signIn();
    await t.call("POST", "/billing/checkout", {
      token: owner.accessToken,
      body: { plan: "pro", interval: "monthly" },
    });
    const before = (
      await t.call("GET", "/billing", { token: owner.accessToken })
    ).body.subscription.currentPeriodEnd;

    // Earn a month of credit while subscribed: it waits.
    const friend = await t.signIn();
    await t.call("POST", "/referrals/apply", {
      token: friend.accessToken,
      body: { code: owner.me.referralCode },
    });
    await qualifyFriend(t, friend);
    const o1 = await t.signIn(owner.email);
    const waiting = (await t.call("GET", "/billing", { token: o1.accessToken }))
      .body;
    assert.equal(waiting.creditMonths, 1);
    assert.equal(waiting.plan.source, "subscription");

    t.clock.advance(28 * DAY);
    const o2 = await t.signIn(owner.email);
    const renewed = (await t.call("GET", "/billing", { token: o2.accessToken }))
      .body;
    assert.equal(renewed.plan.tier, "pro");
    assert.equal(renewed.subscription.status, "active");
    // One period rolled over plus the credit month.
    const gain =
      (Date.parse(renewed.subscription.currentPeriodEnd) - Date.parse(before)) /
      DAY;
    assert.ok(gain > 58 && gain < 63, `gained ${gain} days`);
    assert.equal(renewed.creditMonths, 0);
  } finally {
    await t.close();
  }
});

test("team members get the plan their owner pays for", async () => {
  const owner = await h.signIn();
  const member = await h.signIn();
  await h.call("POST", "/teams", {
    token: owner.accessToken,
    body: { name: "Paid", invites: [member.email] },
  });
  await h.call("POST", "/teams/join", {
    token: member.accessToken,
    body: { token: await h.inviteToken(member.email) },
  });
  await checkout(owner, { plan: "pro", interval: "annual", seats: 2 });
  const me = (await h.call("GET", "/me", { token: member.accessToken })).body;
  assert.equal(me.plan.tier, "pro");
  assert.equal(me.plan.source, "subscription");
  assert.equal((await billing(member)).subscription, null);
});

test("promo codes: valid, case-insensitive, invalid", async () => {
  const s = await h.signIn();
  const ok = await h.call("POST", "/billing/promo", {
    token: s.accessToken,
    body: { code: " welcome10 " },
  });
  assert.equal(ok.status, 200);
  assert.equal(BillingResponse.safeParse(ok.body).success, true);
  assert.equal(ok.body.promo.code, "WELCOME10");
  assert.ok(ok.body.promo.description);
  assert.equal((await billing(s)).promo.code, "WELCOME10");
  for (const code of ["NOPE123", "constructor", "toString"]) {
    const bad = await h.call("POST", "/billing/promo", {
      token: s.accessToken,
      body: { code },
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, "promo-invalid", code);
  }
  assert.equal(
    (
      await h.call("POST", "/billing/promo", {
        token: s.accessToken,
        body: { code: "!" },
      })
    ).body.code,
    "bad-request",
  );
});
