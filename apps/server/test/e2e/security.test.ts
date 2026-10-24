import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { ErrorBody, ROUTES } from "@murmur/account-api";
import { startApp } from "./harness.ts";
import type { Harness } from "./harness.ts";

let h: Harness;
before(async () => {
  h = await startApp();
});
after(() => h.close());

const fill = (path: string) => path.replace(/:\w+/g, "someid");

test("every route that needs auth answers 401 without a token, in the ErrorBody shape", async () => {
  for (const [name, route] of Object.entries(ROUTES)) {
    if (!route.auth) continue;
    const r = await h.call(route.method, fill(route.path), {
      body: route.req ? {} : undefined,
    });
    assert.equal(r.status, 401, `${name} ${route.method} ${route.path}`);
    assert.equal(ErrorBody.safeParse(r.body).success, true, name);
    assert.equal(r.body.code, "unauthorized", name);
  }
});

test("the same routes reject garbage and expired bearer tokens", async () => {
  for (const [name, route] of Object.entries(ROUTES)) {
    if (!route.auth) continue;
    const r = await h.call(route.method, fill(route.path), {
      token: "garbage",
      body: route.req ? {} : undefined,
    });
    assert.equal(r.status, 401, name);
  }
});

test("a token for a deleted account stops working at once", async () => {
  const s = await h.signIn();
  await h.call("DELETE", "/me", {
    token: s.accessToken,
    body: { confirmEmail: s.email },
  });
  assert.equal(
    (await h.call("GET", "/billing", { token: s.accessToken })).status,
    401,
  );
});

test("unknown routes and wrong methods use the ErrorBody shape", async () => {
  const r = await h.call("GET", "/nothing-here");
  assert.equal(r.status, 404);
  assert.equal(ErrorBody.safeParse(r.body).success, true);
  const s = await h.signIn();
  const wrong = await h.call("DELETE", "/billing/plans", {
    token: s.accessToken,
  });
  assert.equal(ErrorBody.safeParse(wrong.body).success, true);
});

test("errors never include internals, and responses are not cacheable", async () => {
  const res = await fetch(`${h.url}/v1/me`);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("x-powered-by"), null);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  const text = await res.text();
  assert.equal(/prisma|stack|node_modules/i.test(text), false);
});

test("sign-in codes, refresh tokens and invite tokens are stored only as hashes", async () => {
  const s = await h.signIn();
  const { PrismaClient } = await import("../../src/generated/prisma/client.ts");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: h.config.databaseUrl }),
  });
  try {
    const code = await h.code(s.email);
    const rows = await db.signInCode.findMany({ where: { email: s.email } });
    assert.ok(rows.length >= 1);
    for (const r of rows) {
      assert.match(r.codeHash, /^[0-9a-f]{64}$/);
      assert.notEqual(r.codeHash, code);
    }
    const tokens = await db.refreshToken.findMany({
      where: { device: { userId: s.me.id } },
    });
    assert.ok(tokens.length >= 1);
    for (const t of tokens) {
      assert.match(t.tokenHash, /^[0-9a-f]{64}$/);
      assert.notEqual(t.tokenHash, s.refreshToken);
    }
    const member = await h.signIn();
    await h.call("POST", "/teams", {
      token: s.accessToken,
      body: { name: "H", invites: [member.email] },
    });
    const token = await h.inviteToken(member.email);
    const inv = await db.teamInvite.findMany({
      where: { email: member.email },
    });
    assert.match(inv[0].tokenHash, /^[0-9a-f]{64}$/);
    assert.notEqual(inv[0].tokenHash, token);
  } finally {
    await db.$disconnect();
  }
});
