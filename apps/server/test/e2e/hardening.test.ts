import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client.ts";
import { addressHash } from "../../src/services/tombstone.ts";
import {
  DAY,
  MINUTE,
  qualifyFriend,
  startApp,
  uniqueEmail,
} from "./harness.ts";
import type { Harness, Session } from "./harness.ts";

let h: Harness;
let db: PrismaClient;
before(async () => {
  h = await startApp();
  db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: h.config.databaseUrl }),
  });
});
after(async () => {
  await db.$disconnect();
  await h.close();
});

const call = (hh: Harness, m: string, p: string, s?: Session, body?: unknown) =>
  hh.call(m, p, { token: s?.accessToken, body });
const outboxFor = async (hh: Harness, to: string, kind: string) =>
  (
    await hh.call("GET", `/dev/outbox?to=${encodeURIComponent(to)}&limit=50`)
  ).body.emails.find((e: any) => e.kind === kind);
const deleteAccount = (s: Session) =>
  call(h, "DELETE", "/me", s, { confirmEmail: s.email });

// ---- 4. Host check ----

function rawGet(url: string, host: string | undefined): Promise<number> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: u.hostname,
        port: u.port,
        path: "/v1/me",
        method: "GET",
        setHost: false,
        headers: host === undefined ? {} : { host },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("host check: loopback names with the real port pass; other hosts are refused", async () => {
  const port = new URL(h.url).port;
  for (const ok of [
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
    `LOCALHOST:${port}`,
  ]) {
    assert.equal(await rawGet(h.url, ok), 401, ok); // reaches the app (needs auth)
  }
  for (const bad of [
    "evil.example",
    `evil.example:${port}`,
    `127.0.0.1.evil.example:${port}`,
    `localhost.evil.example:${port}`,
    "127.0.0.1:1",
    "127.0.0.1",
    `127.0.0.1:${port}x`,
    `a@127.0.0.1:${port}`,
    "",
  ]) {
    assert.equal(await rawGet(h.url, bad), 403, JSON.stringify(bad));
  }
});

// ---- 6. Sign-in caps ----

test("sign-in: 10 codes per address per day, persisted across restarts, aliases share the cap", async () => {
  const base = `cap${Date.now().toString(36)}`;
  const first = await startApp({
    backoff: { start: { after: 1000, baseMs: 1, maxMs: 1 } },
    limits: { startPerEmail: { max: 1000, windowMs: DAY } },
  });
  const start = (hh: Harness, email: string) =>
    hh.call("POST", "/auth/start", { body: { email } });
  try {
    for (let i = 0; i < 10; i++) {
      assert.equal(
        (await start(first, `${base}+${i}@gmail.com`)).status,
        200,
        String(i),
      );
    }
    const blocked = await start(first, `${base}@gmail.com`);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.code, "rate-limited");
  } finally {
    await first.close();
  }
  // A new process has an empty in-memory limiter; the database still remembers.
  const second = await startApp({
    backoff: { start: { after: 1000, baseMs: 1, maxMs: 1 } },
  });
  try {
    assert.equal(
      (await start(second, `o.t.h.e.r${base}@gmail.com`)).status,
      200,
    ); // other address
    assert.equal((await start(second, `${base}@gmail.com`)).status, 429);
    second.clock.advance(25 * 60 * MINUTE);
    assert.equal((await start(second, `${base}@gmail.com`)).status, 200);
  } finally {
    await second.close();
  }
});

test("sign-in: backoff doubles the wait after the free attempts", async () => {
  const t = await startApp({
    limits: { startPerEmail: { max: 1000, windowMs: DAY } },
  });
  const email = uniqueEmail("bo");
  const start = () => t.call("POST", "/auth/start", { body: { email } });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await start()).status, 200);
    assert.equal((await start()).status, 429); // 4th: wait 30 s
    t.clock.advance(31_000);
    assert.equal((await start()).status, 200);
    t.clock.advance(31_000);
    assert.equal((await start()).status, 429); // 5th: wait 60 s
    t.clock.advance(30_000);
    assert.equal((await start()).status, 200);
  } finally {
    await t.close();
  }
});

test("sign-in: verify attempts are capped per address per day", async () => {
  const t = await startApp({
    limits: { verifyPerEmailDaily: { max: 3, windowMs: DAY } },
    backoff: { verify: { after: 1000, baseMs: 1, maxMs: 1 } },
  });
  const email = uniqueEmail("vf");
  try {
    await t.call("POST", "/auth/start", { body: { email } });
    const verify = (code: string) =>
      t.call("POST", "/auth/verify", {
        body: {
          email,
          code,
          device: { name: "d", platform: "macos", appVersion: "1" },
        },
      });
    for (let i = 0; i < 3; i++)
      assert.equal((await verify("000000")).body.code, "code-invalid");
    const r = await verify(await t.code(email));
    assert.equal(r.status, 429);
    t.clock.advance(25 * 60 * MINUTE);
    await t.call("POST", "/auth/start", { body: { email } });
    assert.equal((await verify(await t.code(email))).status, 200);
  } finally {
    await t.close();
  }
});

// ---- 1. Referral and trial farming ----

test("a deleted account can't be referred again under the same or an aliased address", async () => {
  const referrer = await h.signIn();
  const local = `farm${Date.now().toString(36)}`;
  const friend = await h.signIn(`${local}@example.com`);
  assert.equal(
    (
      await call(h, "POST", "/referrals/apply", friend, {
        code: referrer.me.referralCode,
      })
    ).status,
    200,
  );
  assert.equal((await deleteAccount(friend)).status, 200);

  for (const email of [`${local}@example.com`, `${local}+again@EXAMPLE.com`]) {
    const again = await h.signIn(email);
    const r = await call(h, "POST", "/referrals/apply", again, {
      code: referrer.me.referralCode,
    });
    assert.equal(r.status, 409, email);
    assert.equal(r.body.code, "referral-already-applied");
    assert.equal(
      (await call(h, "GET", "/referrals", again)).body.creditMonths,
      0,
    );
  }
});

test("gmail dots and +tags count as the same person for referrals", async () => {
  const referrer = await h.signIn();
  const local = `gm${Date.now().toString(36)}`;
  const one = await h.signIn(`${local}@gmail.com`);
  const two = await h.signIn(
    `${local.slice(0, 3)}.${local.slice(3)}+x@googlemail.com`,
  );
  assert.equal(
    (
      await call(h, "POST", "/referrals/apply", one, {
        code: referrer.me.referralCode,
      })
    ).status,
    200,
  );
  const r = await call(h, "POST", "/referrals/apply", two, {
    code: referrer.me.referralCode,
  });
  assert.equal(r.body.code, "referral-already-applied");
  // And you can't refer yourself through an alias of your own address.
  const alias = await h.signIn(`${local}+self@gmail.com`);
  const self = await call(h, "POST", "/referrals/apply", alias, {
    code: one.me.referralCode,
  });
  assert.equal(self.body.code, "referral-own-code");
});

test("the team trial is once per person even after deleting the account", async () => {
  const email = uniqueEmail("trial");
  const first = await h.signIn(email);
  const t1 = await call(h, "POST", "/teams", first, { name: "One" });
  assert.ok(t1.body.trialEndsAt);
  await deleteAccount(first);
  const second = await h.signIn(email);
  const t2 = await call(h, "POST", "/teams", second, { name: "Two" });
  assert.equal(t2.status, 201);
  assert.equal(t2.body.trialEndsAt, null);
  const me = await call(h, "GET", "/me", second);
  assert.equal(me.body.plan.tier, "free");
});

test("a trial claimed before tombstones existed is remembered when the account is deleted", async () => {
  const email = uniqueEmail("legacy");
  const s = await h.signIn(email);
  await db.user.update({
    where: { id: s.me.id },
    data: { trialClaimedAt: new Date() },
  });
  await deleteAccount(s);
  const again = await h.signIn(email);
  assert.equal(
    (await call(h, "POST", "/teams", again, { name: "X" })).body.trialEndsAt,
    null,
  );
});

test("an address that was already paid for earns no second reward", async () => {
  const t = await startApp();
  try {
    const referrer = await t.signIn();
    let friend = await t.signIn();
    await call(t, "POST", "/referrals/apply", friend, {
      code: referrer.me.referralCode,
    });
    await db.emailTombstone.update({
      where: { emailHash: addressHash(t.config.pepper, friend.email) },
      data: { rewardPaidAt: new Date() },
    });
    friend = await qualifyFriend(t, friend);
    const r2 = await t.signIn(referrer.email);
    const refs = (await call(t, "GET", "/referrals", r2)).body;
    assert.equal(refs.referrals[0].status, "signed-up");
    assert.equal(refs.creditMonths, 0);
  } finally {
    await t.close();
  }
});

test("a reward needs words on 3 different days", async () => {
  const t = await startApp();
  try {
    const referrer = await t.signIn();
    const friend = await t.signIn();
    await call(t, "POST", "/referrals/apply", friend, {
      code: referrer.me.referralCode,
    });
    await qualifyFriend(t, friend, [1500, 800]); // two days only, aged account
    const r2 = await t.signIn(referrer.email);
    assert.equal(
      (await call(t, "GET", "/referrals", r2)).body.referrals[0].status,
      "signed-up",
    );
    // A third day completes it.
    const f2 = await t.signIn(friend.email);
    await call(t, "POST", "/usage", f2, {
      day: new Date(t.clock.now().getTime() - 2 * DAY)
        .toISOString()
        .slice(0, 10),
      words: 50,
    });
    const r3 = await t.signIn(referrer.email);
    const refs = (await call(t, "GET", "/referrals", r3)).body;
    assert.equal(refs.referrals[0].status, "rewarded");
    assert.equal(refs.creditMonths, 1);
  } finally {
    await t.close();
  }
});

test("a referrer earns at most 12 reward months per year", async () => {
  const t = await startApp();
  try {
    const referrer = await t.signIn();
    for (let i = 0; i < 12; i++) {
      const u = await db.user.create({
        data: {
          email: uniqueEmail("capfriend"),
          referralCode: `CAPF${Date.now().toString(36)}${i}`.toUpperCase(),
        },
      });
      await db.referral.create({
        data: {
          referrerId: referrer.me.id,
          refereeId: u.id,
          code: referrer.me.referralCode,
          status: "rewarded",
          rewardedAt: new Date(),
        },
      });
    }
    const friend = await t.signIn();
    await call(t, "POST", "/referrals/apply", friend, {
      code: referrer.me.referralCode,
    });
    await qualifyFriend(t, friend);
    const r2 = await t.signIn(referrer.email);
    const refs = (await call(t, "GET", "/referrals", r2)).body;
    assert.equal(refs.creditMonths, 0);
    assert.equal(
      refs.referrals.find((r: any) => r.status === "signed-up")?.words,
      2000,
    );
    // A year later the cap has rolled over and the next report pays.
    t.clock.advance(366 * DAY);
    const f2 = await t.signIn(friend.email);
    await call(t, "POST", "/usage", f2, {
      day: new Date(t.clock.now().getTime()).toISOString().slice(0, 10),
      words: 10,
    });
    const r3 = await t.signIn(referrer.email);
    assert.equal((await call(t, "GET", "/referrals", r3)).body.creditMonths, 1);
  } finally {
    await t.close();
  }
});

// ---- 2. Seats ----

async function team(members: number) {
  const owner = await h.signIn();
  const joiners: Session[] = [];
  for (let i = 0; i < members; i++) joiners.push(await h.signIn());
  await call(h, "POST", "/teams", owner, {
    name: "Seats",
    invites: joiners.map((m) => m.email),
  });
  for (const m of joiners) {
    const r = await call(h, "POST", "/teams/join", m, {
      token: await h.inviteToken(m.email),
    });
    assert.equal(r.status, 200);
    await new Promise((r) => setTimeout(r, 5)); // distinct joinedAt
  }
  return { owner, joiners };
}

test("seats: only the first N members (owner first, then by join date) get the paid plan", async () => {
  const { owner, joiners } = await team(2); // 3 people
  const plan = async (s: Session) => (await call(h, "GET", "/me", s)).body.plan;
  // During the trial everybody is covered.
  for (const s of [owner, ...joiners])
    assert.equal((await plan(s)).source, "trial");

  assert.equal(
    (
      await call(h, "POST", "/billing/checkout", owner, {
        plan: "pro",
        interval: "monthly",
        seats: 2,
      })
    ).status,
    200,
  );
  // Trial still wins nothing over a subscription for paid seats; the unpaid member keeps the trial.
  assert.equal((await plan(joiners[0])).source, "subscription");
  assert.equal((await plan(joiners[1])).source, "trial");

  h.clock.advance(15 * DAY); // trial over, subscription still current
  const o = await h.signIn(owner.email);
  const a = await h.signIn(joiners[0].email);
  const b = await h.signIn(joiners[1].email);
  assert.equal((await plan(o)).source, "subscription");
  assert.equal((await plan(a)).source, "subscription");
  assert.deepEqual(await plan(b), {
    tier: "free",
    source: "none",
    until: null,
  });
});

test("seats: invites and joins beyond the paid seats are refused with seats-full", async () => {
  const owner = await h.signIn();
  const m1 = await h.signIn();
  const m2 = await h.signIn();
  const m3 = await h.signIn();
  await call(h, "POST", "/teams", owner, {
    name: "Full",
    invites: [m1.email, m3.email],
  });
  await call(h, "POST", "/teams/join", m1, {
    token: await h.inviteToken(m1.email),
  });
  // Trial: no limit on invites.
  assert.equal(
    (
      await call(h, "POST", "/teams/current/invites", owner, {
        emails: [m2.email],
      })
    ).status,
    200,
  );

  await call(h, "POST", "/billing/checkout", owner, {
    plan: "pro",
    interval: "monthly",
    seats: 2,
  });
  // 2 members + 2 pending invites > 2 seats: nothing new, and the pending ones can't be accepted.
  const more = await call(h, "POST", "/teams/current/invites", owner, {
    emails: [uniqueEmail()],
  });
  assert.equal(more.status, 409);
  assert.equal(more.body.code, "seats-full");
  const join = await call(h, "POST", "/teams/join", m3, {
    token: await h.inviteToken(m3.email),
  });
  assert.equal(join.status, 409);
  assert.equal(join.body.code, "seats-full");
  // The invite is not consumed by the refused join.
  const view = (await call(h, "GET", "/teams/current", owner)).body.team;
  assert.equal(view.members.length, 2);
  assert.equal(
    view.invites.find((i: any) => i.email === m3.email).status,
    "pending",
  );

  // More seats: now the join works.
  await call(h, "POST", "/billing/checkout", owner, {
    plan: "pro",
    interval: "monthly",
    seats: 3,
  });
  assert.equal(
    (
      await call(h, "POST", "/teams/join", m3, {
        token: await h.inviteToken(m3.email),
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call(h, "POST", "/teams/current/invites", owner, {
        emails: [uniqueEmail()],
      })
    ).body.code,
    "seats-full",
  );
});

test("seats: creating a team with more invites than your own paid seats is refused up front", async () => {
  const owner = await h.signIn();
  await call(h, "POST", "/billing/checkout", owner, {
    plan: "pro",
    interval: "monthly",
    seats: 2,
  });
  const r = await call(h, "POST", "/teams", owner, {
    name: "Over",
    invites: [uniqueEmail(), uniqueEmail()],
  });
  assert.equal(r.body.code, "seats-full");
  assert.equal((await call(h, "GET", "/teams/current", owner)).body.team, null);
  assert.equal(
    (
      await call(h, "POST", "/teams", owner, {
        name: "Ok",
        invites: [uniqueEmail()],
      })
    ).status,
    201,
  );
});

test("seats: two people joining at once can't both take the last seat", async () => {
  const owner = await h.signIn();
  const a = await h.signIn();
  const b = await h.signIn();
  await call(h, "POST", "/teams", owner, {
    name: "Race",
    invites: [a.email, b.email],
  });
  await call(h, "POST", "/billing/checkout", owner, {
    plan: "pro",
    interval: "monthly",
    seats: 2,
  });
  const [ta, tb] = [await h.inviteToken(a.email), await h.inviteToken(b.email)];
  const rs = await Promise.all([
    call(h, "POST", "/teams/join", a, { token: ta }),
    call(h, "POST", "/teams/join", b, { token: tb }),
  ]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
});

// ---- 7 and 8. Names and emails ----

test("names with control characters are refused by the API", async () => {
  const s = await h.signIn();
  for (const bad of ["Eve\r\nBcc: a@b.co", "Tab\there", "Zero​width"]) {
    assert.equal(
      (await call(h, "PATCH", "/me", s, { firstName: bad })).body.code,
      "bad-request",
    );
    assert.equal(
      (await call(h, "POST", "/teams", s, { name: bad })).body.code,
      "bad-request",
    );
  }
  assert.equal(
    (await call(h, "PATCH", "/me", s, { firstName: "Zoë Marie" })).status,
    200,
  );
});

test("emails: fixed subjects, sanitized and limited names, the code first and how to use it", async () => {
  const s = await h.signIn();
  // Names saved before the rule existed can still contain control characters.
  await db.user.update({
    where: { id: s.me.id },
    data: {
      firstName: `Mallory\r\nBcc: victim@example.com ${"x".repeat(100)}`,
    },
  });
  const friend = uniqueEmail("friend");
  await call(h, "POST", "/referrals/invite", s, { emails: [friend] });
  const ref = await outboxFor(h, friend, "referral-invite");
  assert.equal(ref.subject, "You've been invited to try Murmur");
  assert.equal(/[\r\u0000]/.test(ref.body), false);
  assert.equal(ref.body.includes("Bcc: victim@example.com xxx"), true);
  assert.equal(ref.body.includes("x".repeat(60)), false);
  assert.match(
    ref.body,
    new RegExp(`referral code: ${s.me.referralCode}`, "i"),
  );
  assert.match(ref.body, /Get a free month/);
  assert.match(ref.body, /Apply referral/);
  assert.equal(ref.body.includes("/r/"), false);
  assert.ok(
    ref.body.indexOf(s.me.referralCode) < ref.body.indexOf("Apply referral"),
  );

  const created = await call(h, "POST", "/teams", s, { name: "Crew" });
  await db.team.update({
    where: { id: created.body.id },
    data: { name: "Evil\nSubject: spoof" },
  });
  const invitee = uniqueEmail("invitee");
  await call(h, "POST", "/teams/current/invites", s, { emails: [invitee] });
  const inv = await outboxFor(h, invitee, "team-invite");
  assert.equal(inv.subject, "You're invited to join a team on Murmur");
  assert.equal(inv.body.includes("Evil Subject: spoof"), true);
  assert.equal(/Evil\n/.test(inv.body), false);
  assert.match(inv.body, /Your invite code: [A-Z0-9]{4}(-[A-Z0-9]{4}){3}/);
  assert.match(inv.body, /Settings > Team > Join/);
  assert.equal(inv.body.includes("/join/"), false);
  assert.ok(inv.body.indexOf("invite code") < inv.body.indexOf("Settings"));
});
