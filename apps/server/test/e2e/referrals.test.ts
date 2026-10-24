import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  ApplyReferralResponse,
  ReferralsResponse,
  RULES,
} from "@murmur/account-api";
import { DAY, qualifyFriend, startApp, uniqueEmail } from "./harness.ts";
import type { Harness, Session } from "./harness.ts";

let h: Harness;
before(async () => {
  h = await startApp();
});
after(() => h.close());

const today = () => new Date().toISOString().slice(0, 10);
const dayOffset = (n: number) =>
  new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const usage = (s: Session, day: string, words: number) =>
  h.call("POST", "/usage", { token: s.accessToken, body: { day, words } });
const refs = async (s: Session) =>
  (await h.call("GET", "/referrals", { token: s.accessToken })).body;
const apply = (s: Session, code: string) =>
  h.call("POST", "/referrals/apply", { token: s.accessToken, body: { code } });

test("GET /referrals: code, link, empty state, contract shape", async () => {
  const s = await h.signIn();
  const r = await h.call("GET", "/referrals", { token: s.accessToken });
  assert.equal(ReferralsResponse.safeParse(r.body).success, true);
  assert.equal(r.body.code, s.me.referralCode);
  assert.equal(r.body.link, `${h.config.publicUrl}/r/${s.me.referralCode}`);
  assert.deepEqual(r.body.referrals, []);
  assert.equal(r.body.applied, null);
  assert.equal(r.body.creditMonths, 0);
});

test("apply: the friend gets a month of Pro now; the referrer sees them with a masked label", async () => {
  const referrer = await h.signIn();
  const friend = await h.signIn(`zed${Date.now().toString(36)}@example.com`);
  const r = await apply(friend, referrer.me.referralCode.toLowerCase());
  assert.equal(r.status, 200);
  assert.equal(ApplyReferralResponse.safeParse(r.body).success, true);
  assert.equal(r.body.me.plan.tier, "pro");
  assert.equal(r.body.me.plan.source, "referral");
  const until = (Date.parse(r.body.me.plan.until) - Date.now()) / DAY;
  assert.ok(until > 27 && until < 32, `until in ${until} days`);

  const mine = await refs(friend);
  assert.equal(mine.applied.code, referrer.me.referralCode);
  assert.equal(mine.creditMonths, RULES.referralRewardMonths);

  const theirs = await refs(referrer);
  assert.equal(theirs.referrals.length, 1);
  assert.equal(theirs.referrals[0].status, "signed-up");
  assert.equal(theirs.referrals[0].words, 0);
  assert.match(theirs.referrals[0].label, /^z\*\*\*@example\.com$/);
  assert.equal(JSON.stringify(theirs).includes(friend.email), false);
  assert.equal(theirs.creditMonths, 0);

  await h.call("PATCH", "/me", {
    token: friend.accessToken,
    body: { firstName: "Zed" },
  });
  assert.equal((await refs(referrer)).referrals[0].label, "Zed");
});

test("apply: own code, twice, unknown code, bad format", async () => {
  const a = await h.signIn();
  const b = await h.signIn();
  const own = await apply(a, a.me.referralCode);
  assert.equal(own.status, 400);
  assert.equal(own.body.code, "referral-own-code");
  assert.equal((await apply(a, "NOSUCHCODE9")).body.code, "not-found");
  assert.equal(
    (
      await h.call("POST", "/referrals/apply", {
        token: a.accessToken,
        body: { code: "x!" },
      })
    ).body.code,
    "bad-request",
  );
  assert.equal((await apply(a, b.me.referralCode)).status, 200);
  const twice = await apply(a, b.me.referralCode);
  assert.equal(twice.status, 409);
  assert.equal(twice.body.code, "referral-already-applied");
  // Mutual referral: b can't use the code of a, who joined with b's code.
  const mutual = await apply(b, a.me.referralCode);
  assert.equal(mutual.status, 409);
  assert.equal(mutual.body.code, "conflict");
});

test("apply: only within 30 days of creating the account", async () => {
  const late = await startApp();
  try {
    const referrer = await late.signIn();
    const old = await late.signIn();
    late.clock.advance((RULES.referralApplyWindowDays + 1) * DAY);
    const old2 = await late.signIn(old.email);
    const r = await late.call("POST", "/referrals/apply", {
      token: old2.accessToken,
      body: { code: referrer.me.referralCode },
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "referral-too-late");
  } finally {
    await late.close();
  }
});

test("usage: keeps the max per day; reward needs 2000 words on 3 days and a 3-day-old account", async () => {
  const t = await startApp();
  try {
    const call = (m: string, p: string, s: Session, body?: unknown) =>
      t.call(m, p, { token: s.accessToken, body });
    const day = (n: number) =>
      new Date(t.clock.now().getTime() - n * DAY).toISOString().slice(0, 10);
    const rep = (s: Session, n: number, words: number) =>
      call("POST", "/usage", s, { day: day(n), words });
    const refsOf = async (s: Session) =>
      (await call("GET", "/referrals", s)).body;

    let referrer = await t.signIn();
    let friend = await t.signIn();
    await call("POST", "/referrals/apply", friend, {
      code: referrer.me.referralCode,
    });

    assert.equal((await rep(friend, 0, 1500)).status, 200);
    assert.equal((await rep(friend, 0, 1000)).status, 200); // lower: ignored
    assert.equal((await rep(friend, 1, 400)).status, 200);
    let r = (await refsOf(referrer)).referrals[0];
    assert.equal(r.words, 1900);
    assert.equal(r.status, "signed-up");

    // 2100 words on two days, brand-new account: one self-reported number is not enough.
    await rep(friend, 1, 600);
    r = (await refsOf(referrer)).referrals[0];
    assert.equal(r.status, "signed-up");
    assert.equal(r.words, RULES.referralRewardWords); // progress is capped
    assert.equal((await refsOf(referrer)).creditMonths, 0);

    // A third day alone is still not enough while the account is under 3 days old.
    await rep(friend, 2, 10);
    assert.equal((await refsOf(referrer)).referrals[0].status, "signed-up");

    t.clock.advance(3 * DAY + 60_000);
    friend = await t.signIn(friend.email);
    referrer = await t.signIn(referrer.email);
    await rep(friend, 0, 1500);
    const after = await refsOf(referrer);
    assert.equal(after.referrals[0].status, "rewarded");
    assert.ok(after.referrals[0].rewardedAt);
    assert.equal(after.creditMonths, RULES.referralRewardMonths);
    const me = (await call("GET", "/me", referrer)).body;
    assert.equal(me.plan.tier, "pro");
    assert.equal(me.plan.source, "referral");

    // Idempotent: more usage and repeats never reward again.
    await rep(friend, 1, 600);
    await rep(friend, 0, 9000);
    assert.equal(
      (await refsOf(referrer)).creditMonths,
      RULES.referralRewardMonths,
    );
  } finally {
    await t.close();
  }
});

test("reward is exactly-once under concurrent usage reports", async () => {
  const t = await startApp();
  try {
    let referrer = await t.signIn();
    let friend = await t.signIn();
    await t.call("POST", "/referrals/apply", {
      token: friend.accessToken,
      body: { code: referrer.me.referralCode },
    });
    t.clock.advance(3 * DAY + 60_000);
    friend = await t.signIn(friend.email);
    referrer = await t.signIn(referrer.email);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        t.call("POST", "/usage", {
          token: friend.accessToken,
          body: {
            day: new Date(t.clock.now().getTime() - i * DAY)
              .toISOString()
              .slice(0, 10),
            words: 1000,
          },
        }),
      ),
    );
    assert.ok(
      results.every((r) => r.status === 200),
      JSON.stringify(results.map((r) => r.body)),
    );
    const r = (
      await t.call("GET", "/referrals", { token: referrer.accessToken })
    ).body;
    assert.equal(r.referrals[0].status, "rewarded");
    assert.equal(r.creditMonths, 1);
  } finally {
    await t.close();
  }
});

test("words reported before applying the code count toward the reward", async () => {
  const t = await startApp();
  try {
    const referrer = await t.signIn();
    let friend = await t.signIn();
    friend = await qualifyFriend(t, friend);
    // The 30-day window is still open, so the code can be applied now.
    await t.call("POST", "/referrals/apply", {
      token: friend.accessToken,
      body: { code: referrer.me.referralCode },
    });
    const r2 = await t.signIn(referrer.email);
    const refs2 = (await t.call("GET", "/referrals", { token: r2.accessToken }))
      .body;
    assert.equal(refs2.referrals[0].status, "rewarded");
  } finally {
    await t.close();
  }
});

test("usage validation: dates, ranges, auth", async () => {
  const s = await h.signIn();
  const bad = async (body: unknown) =>
    (await h.call("POST", "/usage", { token: s.accessToken, body })).body.code;
  assert.equal(await bad({ day: "2026-02-30", words: 1 }), "bad-request");
  assert.equal(await bad({ day: "2026-13-01", words: 1 }), "bad-request");
  assert.equal(await bad({ day: "20-1-1", words: 1 }), "bad-request");
  assert.equal(await bad({ day: "2001-01-01", words: 1 }), "bad-request");
  assert.equal(await bad({ day: dayOffset(-30), words: 1 }), "bad-request");
  assert.equal(await bad({ day: today(), words: -1 }), "bad-request");
  assert.equal(await bad({ day: today(), words: 1.5 }), "bad-request");
  assert.equal(await bad({ day: today(), words: 1_000_001 }), "bad-request");
  assert.equal(
    (await h.call("POST", "/usage", { body: { day: today(), words: 1 } }))
      .status,
    401,
  );
});

test("referral invite emails each address once and respects the daily limit", async () => {
  const s = await h.signIn();
  const a = uniqueEmail("f");
  const r = await h.call("POST", "/referrals/invite", {
    token: s.accessToken,
    body: { emails: [a, a, s.email] },
  });
  assert.deepEqual(r.body, { sent: 1 });
  const out = await h.call("GET", `/dev/outbox?to=${encodeURIComponent(a)}`);
  assert.equal(out.body.emails[0].kind, "referral-invite");
  assert.ok(out.body.emails[0].body.includes(s.me.referralCode));

  const limited = await startApp({
    limits: { invitesPerDay: { max: 3, windowMs: DAY } },
  });
  try {
    const u = await limited.signIn();
    const send = (n: number) =>
      limited.call("POST", "/referrals/invite", {
        token: u.accessToken,
        body: { emails: Array.from({ length: n }, () => uniqueEmail()) },
      });
    assert.equal((await send(2)).status, 200);
    const over = await send(2);
    assert.equal(over.status, 429);
    assert.equal(over.body.code, "rate-limited");
    assert.equal((await send(1)).status, 200);
  } finally {
    await limited.close();
  }
});

test("credit is consumed month by month from first use", async () => {
  const t = await startApp();
  try {
    let referrer = await t.signIn();
    const call = (m: string, p: string, s: Session, body?: unknown) =>
      t.call(m, p, { token: s.accessToken, body });
    for (let i = 0; i < 2; i++) {
      const friend = await t.signIn();
      await call("POST", "/referrals/apply", friend, {
        code: referrer.me.referralCode,
      });
      await qualifyFriend(t, friend);
    }
    // Each friend needed 3 days to qualify; the clock moved, so sign in again.
    referrer = await t.signIn(referrer.email);

    let me = (await call("GET", "/me", referrer)).body;
    assert.equal(me.plan.source, "referral");
    assert.equal(
      (await call("GET", "/referrals", referrer)).body.creditMonths,
      2,
    );

    t.clock.advance(35 * DAY);
    const r2 = await t.signIn(referrer.email);
    me = (await t.call("GET", "/me", { token: r2.accessToken })).body;
    assert.equal(me.plan.tier, "pro");
    assert.equal(
      (await t.call("GET", "/referrals", { token: r2.accessToken })).body
        .creditMonths,
      1,
    );

    t.clock.advance(35 * DAY);
    const r3 = await t.signIn(referrer.email);
    me = (await t.call("GET", "/me", { token: r3.accessToken })).body;
    assert.deepEqual(me.plan, { tier: "free", source: "none", until: null });
    assert.equal(
      (await t.call("GET", "/referrals", { token: r3.accessToken })).body
        .creditMonths,
      0,
    );
  } finally {
    await t.close();
  }
});
