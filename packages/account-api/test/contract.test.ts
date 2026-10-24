import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ApplyReferralRequest,
  CheckoutResponse,
  CreateTeamRequest,
  ErrorBody,
  PLAN_CATALOG,
  PlansResponse,
  WaitlistRequest,
  plansFor,
  MeSchema,
  NameSchema,
  UpdateMeRequest,
  UpdateTeamRequest,
  ROUTES,
  RULES,
} from "../src/index.ts";

test("every route has a method, a /-path and a response schema", () => {
  for (const [name, r] of Object.entries(ROUTES)) {
    assert.match(r.path, /^\//, name);
    assert.ok(
      ["GET", "POST", "PATCH", "PUT", "DELETE"].includes(r.method),
      name,
    );
    assert.ok(r.res, name);
  }
});

test("requests are normalised: emails lower-cased, codes upper-cased, invites defaulted", () => {
  assert.equal(
    ApplyReferralRequest.parse({ code: " samantha9 " }).code,
    "SAMANTHA9",
  );
  const team = CreateTeamRequest.parse({ name: " Ops " });
  assert.deepEqual(team, { name: "Ops", invites: [] });
  assert.throws(() => ApplyReferralRequest.parse({ code: "no spaces!" }));
});

test("a Me response round-trips; checkout has three outcomes", () => {
  const me = MeSchema.parse({
    id: "u1",
    email: "a@b.co",
    firstName: "A",
    lastName: "B",
    avatar: null,
    createdAt: "2026-10-20T00:00:00.000Z",
    plan: { tier: "free", source: "none", until: null },
    referralCode: "ABCD1",
    team: null,
  });
  assert.equal(me.plan.tier, "free");
  assert.equal(
    CheckoutResponse.parse({ kind: "contact", email: "sales@x.co" }).kind,
    "contact",
  );
  assert.equal(RULES.referralRewardWords, 2000);
});

test("names refuse control and format characters but keep ordinary spaces", () => {
  for (const bad of ["Ann\nBcc: x@y.z", "A\tB", "A\u0000B", "A​B", "A‮B"]) {
    assert.equal(NameSchema.safeParse(bad).success, false, JSON.stringify(bad));
    assert.equal(
      CreateTeamRequest.safeParse({ name: bad }).success,
      false,
      JSON.stringify(bad),
    );
    assert.equal(UpdateTeamRequest.safeParse({ name: bad }).success, false);
    assert.equal(UpdateMeRequest.safeParse({ firstName: bad }).success, false);
  }
  assert.equal(NameSchema.parse("  Mary Jane  "), "Mary Jane");
  assert.equal(
    CreateTeamRequest.parse({ name: "Ops  team" }).name,
    "Ops  team",
  );
  assert.equal(NameSchema.parse("Zoë 李"), "Zoë 李");
  assert.equal(
    ErrorBody.safeParse({ code: "seats-full", message: "x" }).success,
    true,
  );
});

test("AuthStartResponse: delivery is optional and limited to email or outbox", async () => {
  const { AuthStartResponse } = await import("../src/index.ts");
  assert.equal(
    AuthStartResponse.parse({ ok: true, expiresInSec: 600 }).delivery,
    undefined,
  );
  for (const delivery of ["email", "outbox"]) {
    assert.equal(
      AuthStartResponse.parse({ ok: true, expiresInSec: 600, delivery })
        .delivery,
      delivery,
    );
  }
  assert.throws(() =>
    AuthStartResponse.parse({ ok: true, expiresInSec: 600, delivery: "sms" }),
  );
});

test("plansFor prices the shared catalog per interval", () => {
  const monthly = plansFor("monthly");
  assert.equal(monthly.interval, "monthly");
  assert.deepEqual(
    monthly.plans.map((p) => p.id),
    ["free", "pro", "enterprise"],
  );
  assert.equal(PlansResponse.parse(monthly).plans.length, 3);
  const pro = (r: ReturnType<typeof plansFor>) =>
    r.plans.find((p) => p.id === "pro")!;
  const base = PLAN_CATALOG.plans.find((p) => p.id === "pro")!;
  assert.equal(pro(monthly).priceCents, base.monthlyCents);
  assert.equal(pro(monthly).discountPct, 0);
  const annual = plansFor("annual");
  assert.equal(pro(annual).discountPct, base.annualDiscountPct);
  assert.equal(
    pro(annual).priceCents,
    Math.round((base.monthlyCents! * (100 - base.annualDiscountPct)) / 100),
  );
  const ent = annual.plans.find((p) => p.id === "enterprise")!;
  assert.equal(ent.priceCents, null);
  assert.equal(plansFor("monthly").plans[0].priceCents, 0);
});

test("public routes need no sign-in and the waitlist source is a plain slug", () => {
  for (const n of [
    "publicPlans",
    "publicReferral",
    "publicInvite",
    "waitlist",
  ] as const) {
    assert.equal(ROUTES[n].auth, false, n);
  }
  assert.equal(WaitlistRequest.parse({ email: " A@B.co " }).email, "a@b.co");
  assert.throws(() =>
    WaitlistRequest.parse({ email: "a@b.co", source: "<script>" }),
  );
});
