import assert from "node:assert/strict";
import { test } from "node:test";
import { EmailSchema, plansFor } from "@murmur/account-api";
import {
  apiBase,
  failureMessage,
  interpretResponse,
  isInviteTokenShape,
  requestJson,
} from "../src/lib/api.ts";
import { checkEmail } from "../src/lib/email.ts";
import {
  annualTotalCents,
  comparisonRows,
  formatMoney,
  priceDisplay,
  yearlySavingsCents,
} from "../src/lib/pricing.ts";

const ok = { safeParse: (x: unknown) => ({ success: true as const, data: x }) };
const bad = { safeParse: () => ({ success: false as const }) };

test("formatMoney drops empty cents", () => {
  assert.equal(formatMoney(1000), "$10");
  assert.equal(formatMoney(950), "$9.50");
  assert.equal(formatMoney(0), "$0");
});

test("price display and interval maths follow the catalog", () => {
  const monthly = plansFor("monthly");
  const annual = plansFor("annual");
  const [free, pro, ent] = monthly.plans;
  assert.equal(priceDisplay(free, "monthly").amount, "$0");
  assert.equal(priceDisplay(ent, "monthly").amount, "Custom");
  assert.equal(priceDisplay(pro, "monthly").badge, null);
  const a = priceDisplay(annual.plans[1], "annual");
  assert.equal(a.amount, "$8");
  assert.equal(a.badge, "Save 20%");
  assert.match(a.billedNote ?? "", /\$96/);
  assert.equal(annualTotalCents(800), 9600);
  assert.equal(yearlySavingsCents(pro, annual.plans[1]), 2400);
  assert.equal(yearlySavingsCents(ent, annual.plans[2]), null);
});

test("comparison rows: a feature belongs to its plan and every higher one", () => {
  const rows = comparisonRows(plansFor("monthly").plans);
  assert.ok(rows.every((r) => !/^everything in/i.test(r.feature)));
  const history = rows.find((r) => r.feature === "Local history");
  assert.deepEqual(history?.included, [true, true, true]);
  const meetings = rows.find((r) => r.feature === "Meeting notes");
  assert.deepEqual(meetings?.included, [false, true, true]);
  const sso = rows.find((r) => r.feature === "Single sign-on");
  assert.deepEqual(sso?.included, [false, false, true]);
});

test("email checks agree with the contract on common inputs", () => {
  for (const e of ["a@b.co", " Ana@Example.COM ", "x+tag@mail.example.com"]) {
    const r = checkEmail(e);
    assert.ok(r.ok);
    assert.equal(r.ok && r.email, EmailSchema.parse(e));
  }
  for (const e of [
    "",
    "   ",
    "nope",
    "a@b",
    "a b@c.de",
    "a@@b.co",
    "a@b..co",
  ]) {
    assert.equal(checkEmail(e).ok, false, e);
    assert.equal(EmailSchema.safeParse(e).success, false, e);
  }
  assert.deepEqual(checkEmail(""), { ok: false, reason: "empty" });
  assert.equal(checkEmail("a".repeat(250) + "@b.co").ok, false);
});

test("responses map to results", () => {
  assert.deepEqual(interpretResponse(200, { x: 1 }, ok), {
    ok: true,
    data: { x: 1 },
  });
  assert.deepEqual(interpretResponse(200, {}, bad), {
    ok: false,
    kind: "unexpected",
  });
  assert.equal(interpretResponse(429, null, ok).ok, false);
  const kind = (s: number) => {
    const r = interpretResponse(s, null, ok);
    return r.ok ? "ok" : r.kind;
  };
  assert.equal(kind(429), "rate-limited");
  assert.equal(kind(400), "invalid-input");
  assert.equal(kind(500), "unexpected");
  assert.equal(kind(404), "unexpected");
});

test("requests: network errors, bad bodies and missing base", async () => {
  const down = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  const r = await requestJson("GET", "/x", ok, {
    fetchImpl: down,
    base: "http://h/v1",
  });
  assert.deepEqual(r, { ok: false, kind: "unreachable" });
  const html = (async () =>
    new Response("<html>", { status: 502 })) as unknown as typeof fetch;
  const r2 = await requestJson("GET", "/x", ok, {
    fetchImpl: html,
    base: "http://h/v1",
  });
  assert.deepEqual(r2, { ok: false, kind: "unexpected" });
  const none = await requestJson("GET", "/x", ok, { base: null });
  assert.deepEqual(none, { ok: false, kind: "not-configured" });
});

test("api base and messages", () => {
  assert.equal(apiBase(undefined, "development"), "http://127.0.0.1:4000/v1");
  assert.equal(apiBase(undefined, "production"), null);
  assert.equal(
    apiBase("https://api.example.com/v1/", "production"),
    "https://api.example.com/v1",
  );
  for (const k of [
    "rate-limited",
    "invalid-input",
    "unreachable",
    "not-configured",
    "unexpected",
  ] as const) {
    assert.ok(failureMessage(k).length > 20);
  }
  assert.equal(isInviteTokenShape("ABCD-EFGH-JKLM"), true);
  assert.equal(isInviteTokenShape("../etc"), false);
  assert.equal(isInviteTokenShape("short"), false);
});
