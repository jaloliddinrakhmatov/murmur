import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import {
  PlansResponse,
  PublicInviteResponse,
  PublicReferralResponse,
  WaitlistResponse,
  plansFor,
} from "@murmur/account-api";
import { PrismaService } from "../../src/prisma/prisma.service.ts";
import { DAY, startApp, uniqueEmail } from "./harness.ts";
import type { Harness, Session } from "./harness.ts";

let h: Harness;
before(async () => {
  h = await startApp();
});
after(() => h.close());

const get = (path: string, headers?: Record<string, string>) =>
  h.call("GET", `/public${path}`, { headers });
const post = (path: string, body: unknown) =>
  h.call("POST", `/public${path}`, { body });

test("plans: no sign-in, the shared catalog, both intervals", async () => {
  const monthly = await get("/plans");
  assert.equal(monthly.status, 200);
  assert.deepEqual(PlansResponse.parse(monthly.body), plansFor("monthly"));
  const annual = await get("/plans?interval=annual");
  assert.deepEqual(annual.body, plansFor("annual"));
  // The signed-in route returns the very same data.
  const s = await h.signIn();
  const authed = await h.call("GET", "/billing/plans?interval=annual", {
    token: s.accessToken,
  });
  assert.deepEqual(authed.body, annual.body);
  assert.equal((await get("/plans?interval=weekly")).status, 400);
});

async function withName(first: string, last = "Secretname"): Promise<Session> {
  const s = await h.signIn();
  const r = await h.call("PATCH", "/me", {
    token: s.accessToken,
    body: { firstName: first, lastName: last },
  });
  assert.equal(r.status, 200);
  return s;
}

test("referral: valid code gives the first name only; unknown and malformed are just invalid", async () => {
  const s = await withName("Samantha");
  const code: string = s.me.referralCode;
  for (const c of [code, code.toLowerCase()]) {
    const r = await get(`/referral/${c}`);
    assert.equal(r.status, 200);
    assert.deepEqual(PublicReferralResponse.parse(r.body), {
      valid: true,
      firstName: "Samantha",
    });
  }
  const text = JSON.stringify((await get(`/referral/${code}`)).body);
  assert.ok(!text.includes("Secretname") && !text.includes("@"));

  const noName = await h.signIn();
  assert.deepEqual((await get(`/referral/${noName.me.referralCode}`)).body, {
    valid: true,
  });
  assert.deepEqual((await get("/referral/NOSUCHCODE9")).body, {
    valid: false,
  });
  assert.deepEqual((await get("/referral/no%20spaces!")).body, {
    valid: false,
  });
});

async function invite(teamName = "Ops Crew") {
  const owner = await h.signIn();
  const guest = uniqueEmail("guest");
  const t = await h.call("POST", "/teams", {
    token: owner.accessToken,
    body: { name: teamName, invites: [guest] },
  });
  assert.equal(t.status, 201);
  return { owner, guest, token: await h.inviteToken(guest), team: t.body };
}

test("invite: valid gives the team name, never the invitee; revoked, expired and unknown are invalid", async () => {
  const { owner, guest, token, team } = await invite();
  const r = await get(`/invite/${token}`);
  assert.equal(r.status, 200);
  assert.deepEqual(PublicInviteResponse.parse(r.body), {
    valid: true,
    teamName: "Ops Crew",
  });
  assert.ok(!JSON.stringify(r.body).includes(guest));
  // Typed with dashes and lower case, like the email shows it.
  const dashed = token.match(/.{4}/g)!.join("-").toLowerCase();
  assert.equal((await get(`/invite/${dashed}`)).body.valid, true);

  const id = team.invites[0].id;
  await h.call("DELETE", `/teams/current/invites/${id}`, {
    token: owner.accessToken,
  });
  assert.deepEqual((await get(`/invite/${token}`)).body, { valid: false });
  assert.deepEqual((await get("/invite/ABCD2345ABCD2345")).body, {
    valid: false,
  });
  assert.deepEqual((await get("/invite/x")).body, { valid: false });

  const second = await invite("Late Crew");
  h.clock.advance(15 * DAY);
  assert.deepEqual((await get(`/invite/${second.token}`)).body, {
    valid: false,
    expired: true,
  });
});

test("waitlist: stores once, same answer for repeats and +tag variants, no email sent, no leak", async () => {
  const prisma = h.app.get(PrismaService);
  const email = uniqueEmail("wait");
  const first = await post("/waitlist", {
    email: email.toUpperCase(),
    source: "home",
  });
  assert.equal(first.status, 200);
  assert.deepEqual(WaitlistResponse.parse(first.body), { ok: true });
  const again = await post("/waitlist", { email, source: "download" });
  assert.deepEqual(again.body, { ok: true });
  const tagged = await post("/waitlist", {
    email: email.replace("@", "+news@"),
  });
  assert.deepEqual(tagged.body, { ok: true });
  const rows = await prisma.waitlistEntry.findMany({ where: { email } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "home");
  assert.match(rows[0].emailHash, /^[0-9a-f]{64}$/);
  const out = await h.call(
    "GET",
    `/dev/outbox?to=${encodeURIComponent(email)}`,
  );
  assert.deepEqual(out.body.emails, []);

  assert.equal((await post("/waitlist", { email: "nope" })).status, 400);
  assert.equal((await post("/waitlist", {})).status, 400);
  assert.equal(
    (await post("/waitlist", { email, source: "<b>x</b>" })).status,
    400,
  );
});

test("CORS: only the website origin, only on /v1/public", async () => {
  const origin = h.config.webOrigin;
  assert.equal(origin, "http://localhost:3000");
  const ok = await fetch(`${h.url}/v1/public/plans`, { headers: { origin } });
  assert.equal(ok.headers.get("access-control-allow-origin"), origin);
  const evil = await fetch(`${h.url}/v1/public/plans`, {
    headers: { origin: "https://evil.example" },
  });
  assert.equal(evil.headers.get("access-control-allow-origin"), null);
  const pre = await fetch(`${h.url}/v1/public/waitlist`, {
    method: "OPTIONS",
    headers: { origin, "access-control-request-method": "POST" },
  });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), origin);
  assert.match(pre.headers.get("access-control-allow-methods")!, /POST/);
  const other = await fetch(`${h.url}/v1/billing/plans`, {
    headers: { origin },
  });
  assert.equal(other.headers.get("access-control-allow-origin"), null);
});

test("a foreign Host is refused like everywhere else", async () => {
  const port = new URL(h.url).port;
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/v1/public/plans",
        headers: { host: "evil.example" },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 403);
});

test("rate limits: lookups (code enumeration), plans and daily waitlist, each with the 429 shape", async () => {
  const lim = await startApp({
    limits: {
      publicLookup: { max: 3, windowMs: 60_000 },
      publicRead: { max: 2, windowMs: 60_000 },
      waitlistPerIpDaily: { max: 2, windowMs: DAY },
    },
  });
  try {
    const call = (m: string, p: string, body?: unknown) =>
      lim.call(m, `/public${p}`, { body });
    // Referral and invite lookups share one budget per IP.
    assert.equal((await call("GET", "/referral/AAAAAA")).status, 200);
    assert.equal((await call("GET", "/invite/AAAAAAAAAAAA")).status, 200);
    assert.equal((await call("GET", "/referral/BBBBBB")).status, 200);
    const blocked = await call("GET", "/referral/CCCCCC");
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.code, "rate-limited");

    assert.equal((await call("GET", "/plans")).status, 200);
    assert.equal((await call("GET", "/plans")).status, 200);
    assert.equal((await call("GET", "/plans")).status, 429);

    assert.equal(
      (await call("POST", "/waitlist", { email: uniqueEmail() })).status,
      200,
    );
    assert.equal(
      (await call("POST", "/waitlist", { email: uniqueEmail() })).status,
      200,
    );
    const third = await call("POST", "/waitlist", { email: uniqueEmail() });
    assert.equal(third.status, 429);
    lim.clock.advance(DAY + 1);
    assert.equal(
      (await call("POST", "/waitlist", { email: uniqueEmail() })).status,
      200,
    );
  } finally {
    await lim.close();
  }
});
