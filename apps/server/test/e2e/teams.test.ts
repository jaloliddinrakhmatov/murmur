import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { RULES, TeamSchema } from "@murmur/account-api";
import { DAY, startApp, uniqueEmail } from "./harness.ts";
import type { Harness, Session } from "./harness.ts";

let h: Harness;
before(async () => {
  h = await startApp();
});
after(() => h.close());

const post = (s: Session, path: string, body?: unknown) =>
  h.call("POST", path, { token: s.accessToken, body });

/** An owner with a team and one member who joined through the real invite flow. */
async function teamWithMember() {
  const owner = await h.signIn();
  const member = await h.signIn();
  const created = await post(owner, "/teams", {
    name: "Acme",
    invites: [member.email],
  });
  const joined = await post(member, "/teams/join", {
    token: await h.inviteToken(member.email),
  });
  return { owner, member, teamId: created.body.id as string, joined };
}

test("create: owner, 14-day trial, contract shape, Pro trial plan", async () => {
  const owner = await h.signIn();
  const r = await post(owner, "/teams", { name: "  Acme  " });
  assert.equal(r.status, 201);
  assert.equal(TeamSchema.safeParse(r.body).success, true);
  assert.equal(r.body.name, "Acme");
  assert.equal(r.body.role, "owner");
  const days = (Date.parse(r.body.trialEndsAt) - Date.now()) / DAY;
  assert.ok(Math.abs(days - RULES.teamTrialDays) < 0.01);
  assert.deepEqual(
    r.body.members.map((m: any) => [m.userId, m.role]),
    [[owner.me.id, "owner"]],
  );
  const me = (await h.call("GET", "/me", { token: owner.accessToken })).body;
  assert.equal(me.plan.tier, "pro");
  assert.equal(me.plan.source, "trial");
  assert.equal(me.plan.until, r.body.trialEndsAt);
  assert.deepEqual(me.team, { id: r.body.id, name: "Acme", role: "owner" });
});

test("create: one team per user; empty name rejected; current is null without a team", async () => {
  const u = await h.signIn();
  assert.deepEqual(
    (await h.call("GET", "/teams/current", { token: u.accessToken })).body,
    { team: null },
  );
  assert.equal(
    (await post(u, "/teams", { name: "  " })).body.code,
    "bad-request",
  );
  await post(u, "/teams", { name: "One" });
  const second = await post(u, "/teams", { name: "Two" });
  assert.equal(second.status, 409);
  assert.equal(second.body.code, "team-exists");
});

test("create with invites emails each address and skips your own", async () => {
  const owner = await h.signIn();
  const a = uniqueEmail("a");
  const r = await post(owner, "/teams", {
    name: "Inv",
    invites: [a, a.toUpperCase(), owner.email],
  });
  assert.deepEqual(
    r.body.invites.map((i: any) => i.email),
    [a],
  );
  const token = await h.inviteToken(a);
  assert.match(token, /^[A-Z0-9]{16}$/);
});

test("trial is claimed once per person", async () => {
  const u = await h.signIn();
  await post(u, "/teams", { name: "First" });
  await post(u, "/teams/current/leave");
  const again = await post(u, "/teams", { name: "Second" });
  assert.equal(again.body.trialEndsAt, null);
  assert.equal(
    (await h.call("GET", "/me", { token: u.accessToken })).body.plan.tier,
    "free",
  );
});

test("invites: join with the code from the email, role member, trial shared", async () => {
  const { owner, member, joined } = await teamWithMember();
  assert.equal(joined.status, 200);
  assert.equal(joined.body.role, "member");
  assert.deepEqual(joined.body.invites, []);
  assert.equal(joined.body.members.length, 2);
  const view = (
    await h.call("GET", "/teams/current", { token: owner.accessToken })
  ).body.team;
  assert.equal(view.invites[0].status, "accepted");
  const me = (await h.call("GET", "/me", { token: member.accessToken })).body;
  assert.equal(me.plan.source, "trial");
  assert.equal(me.team.role, "member");
});

test("join accepts the code in any case and with dashes or spaces", async () => {
  const owner = await h.signIn();
  const guest = await h.signIn();
  await post(owner, "/teams", { name: "Fmt", invites: [guest.email] });
  const token = await h.inviteToken(guest.email);
  const messy = ` ${token.toLowerCase().replace(/(.{4})/g, "$1-")} `;
  assert.equal(
    (await post(guest, "/teams/join", { token: messy })).status,
    200,
  );
});

test("join: wrong email, unknown, revoked, expired and already-in-a-team", async () => {
  const owner = await h.signIn();
  const guest = await h.signIn();
  const stranger = await h.signIn();
  const created = await post(owner, "/teams", {
    name: "Gate",
    invites: [guest.email],
  });
  const token = await h.inviteToken(guest.email);

  const wrongEmail = await post(stranger, "/teams/join", { token });
  assert.equal(wrongEmail.status, 403);
  assert.equal(wrongEmail.body.code, "forbidden");
  assert.equal(
    (await post(stranger, "/teams/join", { token: "ZZZZZZZZZZZZZZZZ" })).body
      .code,
    "not-found",
  );
  assert.equal(
    (await post(stranger, "/teams/join", { token: "short" })).body.code,
    "bad-request",
  );

  const inviteId = created.body.invites[0].id;
  const revoked = await h.call("DELETE", `/teams/current/invites/${inviteId}`, {
    token: owner.accessToken,
  });
  assert.equal(revoked.body.invites[0].status, "revoked");
  assert.equal(
    (await post(guest, "/teams/join", { token })).body.code,
    "not-found",
  );

  // Expiry: a fresh invite becomes "expired" after 14 days.
  const late = await startApp();
  try {
    const o = await late.signIn();
    const g = await late.signIn();
    await late.call("POST", "/teams", {
      token: o.accessToken,
      body: { name: "Late", invites: [g.email] },
    });
    const t = await late.inviteToken(g.email);
    late.clock.advance((RULES.teamInviteDays + 1) * DAY);
    // Sign in again: the clock moved, so the old access token has expired.
    const g2 = await late.signIn(g.email);
    const o2 = await late.signIn(o.email);
    const joinLate = await late.call("POST", "/teams/join", {
      token: g2.accessToken,
      body: { token: t },
    });
    assert.equal(joinLate.body.code, "not-found");
    const listed = await late.call("GET", "/teams/current", {
      token: o2.accessToken,
    });
    assert.equal(listed.body.team.invites[0].status, "expired");
  } finally {
    await late.close();
  }

  const other = await h.signIn();
  await post(other, "/teams", { name: "Other", invites: [owner.email] });
  const busy = await post(owner, "/teams/join", {
    token: await h.inviteToken(owner.email),
  });
  assert.equal(busy.body.code, "team-exists");
});

test("invite dedupes, skips members, needs owner or admin, and only managers see invites", async () => {
  const { owner, member } = await teamWithMember();
  const x = uniqueEmail("x");
  const r = await post(owner, "/teams/current/invites", {
    emails: [x, x, member.email, owner.email],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(
    r.body.invites
      .filter((i: any) => i.status === "pending")
      .map((i: any) => i.email),
    [x],
  );
  const again = await post(owner, "/teams/current/invites", { emails: [x] });
  assert.equal(again.body.invites.filter((i: any) => i.email === x).length, 1);

  assert.equal(
    (await post(member, "/teams/current/invites", { emails: [uniqueEmail()] }))
      .status,
    403,
  );
  const seen = await h.call("GET", "/teams/current", {
    token: member.accessToken,
  });
  assert.deepEqual(seen.body.team.invites, []);
  assert.equal(
    (await post(owner, "/teams/current/invites", { emails: [] })).body.code,
    "bad-request",
  );
  const tooMany = Array.from({ length: RULES.maxInvitesPerRequest + 1 }, () =>
    uniqueEmail(),
  );
  assert.equal(
    (await post(owner, "/teams/current/invites", { emails: tooMany })).body
      .code,
    "bad-request",
  );
});

test("roles: only the owner changes them; the last owner can't be demoted", async () => {
  const { owner, member } = await teamWithMember();
  const promoted = await h.call(
    "PATCH",
    `/teams/current/members/${member.me.id}`,
    {
      token: owner.accessToken,
      body: { role: "admin" },
    },
  );
  assert.equal(
    promoted.body.members.find((m: any) => m.userId === member.me.id).role,
    "admin",
  );
  // An admin can't change roles.
  const byAdmin = await h.call(
    "PATCH",
    `/teams/current/members/${owner.me.id}`,
    {
      token: member.accessToken,
      body: { role: "member" },
    },
  );
  assert.equal(byAdmin.status, 403);
  const demoteOwner = await h.call(
    "PATCH",
    `/teams/current/members/${owner.me.id}`,
    {
      token: owner.accessToken,
      body: { role: "admin" },
    },
  );
  assert.equal(demoteOwner.status, 409);
  assert.equal(demoteOwner.body.code, "team-last-owner");
  assert.equal(
    (
      await h.call("PATCH", `/teams/current/members/${owner.me.id}`, {
        token: owner.accessToken,
        body: { role: "owner" },
      })
    ).body.code,
    "bad-request",
  );
  const stranger = await h.signIn();
  assert.equal(
    (
      await h.call("PATCH", `/teams/current/members/${stranger.me.id}`, {
        token: owner.accessToken,
        body: { role: "admin" },
      })
    ).status,
    404,
  );
});

test("remove member: managers only, never the owner, admins can't remove admins", async () => {
  const { owner, member } = await teamWithMember();
  assert.equal(
    (
      await h.call("DELETE", `/teams/current/members/${owner.me.id}`, {
        token: member.accessToken,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await h.call("DELETE", `/teams/current/members/${owner.me.id}`, {
        token: owner.accessToken,
      })
    ).status,
    400,
  );
  await h.call("PATCH", `/teams/current/members/${member.me.id}`, {
    token: owner.accessToken,
    body: { role: "admin" },
  });
  const third = await h.signIn();
  await post(owner, "/teams/current/invites", { emails: [third.email] });
  await post(third, "/teams/join", { token: await h.inviteToken(third.email) });
  await h.call("PATCH", `/teams/current/members/${third.me.id}`, {
    token: owner.accessToken,
    body: { role: "admin" },
  });
  assert.equal(
    (
      await h.call("DELETE", `/teams/current/members/${third.me.id}`, {
        token: member.accessToken,
      })
    ).status,
    403,
  );
  const removed = await h.call(
    "DELETE",
    `/teams/current/members/${third.me.id}`,
    { token: owner.accessToken },
  );
  assert.equal(removed.status, 200);
  assert.equal(
    removed.body.members.some((m: any) => m.userId === third.me.id),
    false,
  );
  assert.equal(
    (await h.call("GET", "/me", { token: third.accessToken })).body.team,
    null,
  );
});

test("leave: members leave; a sole owner with members can't; alone the team is deleted", async () => {
  const { owner, member, teamId } = await teamWithMember();
  const blocked = await post(owner, "/teams/current/leave");
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "team-last-owner");
  const left = await post(member, "/teams/current/leave");
  assert.deepEqual(left.body, { team: null });
  assert.equal((await post(member, "/teams/current/leave")).status, 404);
  const alone = await post(owner, "/teams/current/leave");
  assert.deepEqual(alone.body, { team: null });
  assert.equal(
    (await h.call("GET", "/teams/current", { token: owner.accessToken })).body
      .team,
    null,
  );
  assert.ok(teamId);
});

test("rename: managers only", async () => {
  const { owner, member } = await teamWithMember();
  assert.equal(
    (
      await h.call("PATCH", "/teams/current", {
        token: member.accessToken,
        body: { name: "Nope" },
      })
    ).status,
    403,
  );
  const r = await h.call("PATCH", "/teams/current", {
    token: owner.accessToken,
    body: { name: " Renamed " },
  });
  assert.equal(r.body.name, "Renamed");
  assert.equal(
    (
      await h.call("PATCH", "/teams/current", {
        token: owner.accessToken,
        body: { name: "x".repeat(61) },
      })
    ).body.code,
    "bad-request",
  );
});

test("teams are isolated: nobody can touch another team's invites or members", async () => {
  const a = await teamWithMember();
  const b = await teamWithMember();
  const aInvite = (
    await h.call("GET", "/teams/current", { token: a.owner.accessToken })
  ).body.team.invites[0].id;
  const cross = await h.call("DELETE", `/teams/current/invites/${aInvite}`, {
    token: b.owner.accessToken,
  });
  assert.equal(cross.status, 404);
  assert.equal(
    (
      await h.call("DELETE", `/teams/current/members/${a.member.me.id}`, {
        token: b.owner.accessToken,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await h.call("PATCH", `/teams/current/members/${a.member.me.id}`, {
        token: b.owner.accessToken,
        body: { role: "admin" },
      })
    ).status,
    404,
  );
  const bView = (
    await h.call("GET", "/teams/current", { token: b.owner.accessToken })
  ).body.team;
  assert.equal(
    bView.members.some((m: any) => m.userId === a.owner.me.id),
    false,
  );
  // Someone without a team can't manage one.
  const loner = await h.signIn();
  assert.equal(
    (await post(loner, "/teams/current/invites", { emails: [uniqueEmail()] }))
      .status,
    404,
  );
});

test("revoking an accepted invite is a conflict; unknown ids are not-found", async () => {
  const { owner } = await teamWithMember();
  const view = (
    await h.call("GET", "/teams/current", { token: owner.accessToken })
  ).body.team;
  const accepted = view.invites.find((i: any) => i.status === "accepted");
  assert.equal(
    (
      await h.call("DELETE", `/teams/current/invites/${accepted.id}`, {
        token: owner.accessToken,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await h.call("DELETE", "/teams/current/invites/nope", {
        token: owner.accessToken,
      })
    ).status,
    404,
  );
});
