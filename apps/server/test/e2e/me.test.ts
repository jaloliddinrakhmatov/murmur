import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { MeSchema } from "@murmur/account-api";
import { dataUrl, JPEG, PNG, startApp, uniqueEmail } from "./harness.ts";
import type { Harness } from "./harness.ts";

let h: Harness;
before(async () => {
  h = await startApp();
});
after(() => h.close());

test("GET /me returns the contract shape", async () => {
  const s = await h.signIn();
  const r = await h.call("GET", "/me", { token: s.accessToken });
  assert.equal(r.status, 200);
  assert.equal(MeSchema.safeParse(r.body).success, true);
  assert.equal(r.body.email, s.email);
  assert.equal(r.body.avatar, null);
});

test("PATCH /me trims names and keeps untouched fields", async () => {
  const s = await h.signIn();
  const r = await h.call("PATCH", "/me", {
    token: s.accessToken,
    body: { firstName: "  Ada " },
  });
  assert.equal(r.body.firstName, "Ada");
  const r2 = await h.call("PATCH", "/me", {
    token: s.accessToken,
    body: { lastName: "Lovelace" },
  });
  assert.equal(r2.body.firstName, "Ada");
  assert.equal(r2.body.lastName, "Lovelace");
  const long = await h.call("PATCH", "/me", {
    token: s.accessToken,
    body: { firstName: "x".repeat(61) },
  });
  assert.equal(long.body.code, "bad-request");
});

test("avatar: PNG and JPEG are stored and returned as data URLs; removal works", async () => {
  const s = await h.signIn();
  const png = await h.call("PUT", "/me/avatar", {
    token: s.accessToken,
    body: { dataUrl: dataUrl("image/png", PNG) },
  });
  assert.equal(png.status, 200);
  assert.equal(png.body.avatar, dataUrl("image/png", PNG));
  const jpg = await h.call("PUT", "/me/avatar", {
    token: s.accessToken,
    body: { dataUrl: dataUrl("image/jpeg", JPEG) },
  });
  assert.equal(jpg.body.avatar, dataUrl("image/jpeg", JPEG));
  assert.equal(
    (await h.call("GET", "/me", { token: s.accessToken })).body.avatar,
    dataUrl("image/jpeg", JPEG),
  );
  const gone = await h.call("DELETE", "/me/avatar", { token: s.accessToken });
  assert.equal(gone.body.avatar, null);
});

test("avatar: wrong magic bytes, wrong type and oversize are rejected", async () => {
  const s = await h.signIn();
  const put = (url: string) =>
    h.call("PUT", "/me/avatar", {
      token: s.accessToken,
      body: { dataUrl: url },
    });
  assert.equal(
    (await put(dataUrl("image/png", JPEG))).body.code,
    "bad-request",
  );
  assert.equal(
    (await put(dataUrl("image/jpeg", PNG))).body.code,
    "bad-request",
  );
  assert.equal(
    (await put(dataUrl("image/png", Buffer.from("<svg onload=alert(1)>")))).body
      .code,
    "bad-request",
  );
  assert.equal(
    (await put("data:image/svg+xml;base64,PHN2Zz4=")).body.code,
    "bad-request",
  );
  assert.equal((await put("data:image/png;base64,")).body.code, "bad-request");
  const big = Buffer.concat([PNG, Buffer.alloc(1_000_000)]);
  assert.equal((await put(dataUrl("image/png", big))).body.code, "bad-request");
  const ok = Buffer.concat([PNG, Buffer.alloc(900_000, 7)]);
  assert.equal((await put(dataUrl("image/png", ok))).status, 200);
});

test("requests over the body limit are rejected as bad-request (413)", async () => {
  const s = await h.signIn();
  const r = await h.call("PATCH", "/me", {
    token: s.accessToken,
    body: { firstName: "x".repeat(2_000_000) },
  });
  assert.equal(r.status, 413);
  assert.equal(r.body.code, "bad-request");
});

test("DELETE /me needs the matching email, then removes the account", async () => {
  const s = await h.signIn();
  const wrong = await h.call("DELETE", "/me", {
    token: s.accessToken,
    body: { confirmEmail: uniqueEmail() },
  });
  assert.equal(wrong.body.code, "bad-request");
  const ok = await h.call("DELETE", "/me", {
    token: s.accessToken,
    body: { confirmEmail: s.email.toUpperCase() },
  });
  assert.deepEqual(ok.body, { ok: true });
  assert.equal(
    (await h.call("GET", "/me", { token: s.accessToken })).status,
    401,
  );
  assert.equal(
    (
      await h.call("POST", "/auth/refresh", {
        body: { refreshToken: s.refreshToken },
      })
    ).status,
    401,
  );
  const again = await h.signIn(s.email);
  assert.notEqual(again.me.id, s.me.id);
});

test("deleting an owner hands the team to the oldest admin, or deletes a team of one", async () => {
  const owner = await h.signIn();
  const admin = await h.signIn();
  const member = await h.signIn();
  await h.call("POST", "/teams", {
    token: owner.accessToken,
    body: { name: "Crew", invites: [member.email, admin.email] },
  });
  for (const u of [member, admin]) {
    await h.call("POST", "/teams/join", {
      token: u.accessToken,
      body: { token: await h.inviteToken(u.email) },
    });
  }
  await h.call("PATCH", `/teams/current/members/${admin.me.id}`, {
    token: owner.accessToken,
    body: { role: "admin" },
  });

  await h.call("DELETE", "/me", {
    token: owner.accessToken,
    body: { confirmEmail: owner.email },
  });
  const team = (
    await h.call("GET", "/teams/current", { token: admin.accessToken })
  ).body.team;
  assert.equal(team.role, "owner");
  assert.deepEqual(
    team.members.map((m: any) => m.userId).sort(),
    [admin.me.id, member.me.id].sort(),
  );

  const solo = await h.signIn();
  const created = await h.call("POST", "/teams", {
    token: solo.accessToken,
    body: { name: "Solo" },
  });
  await h.call("DELETE", "/me", {
    token: solo.accessToken,
    body: { confirmEmail: solo.email },
  });
  const fresh = await h.signIn(solo.email);
  assert.equal(
    (await h.call("GET", "/teams/current", { token: fresh.accessToken })).body
      .team,
    null,
  );
  assert.ok(created.body.id);
});
