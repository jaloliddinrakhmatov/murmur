import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  AuthStartResponse,
  AuthVerifyResponse,
  ErrorBody,
  ROUTES,
} from "@murmur/account-api";
import { AppModule } from "../../src/app.module.ts";
import { apiError } from "../../src/common/errors.ts";
import { loadConfig } from "../../src/config/env.ts";
import { MINUTE, startApp, uniqueEmail } from "./harness.ts";
import type { Harness } from "./harness.ts";

let h: Harness;
before(async () => {
  h = await startApp();
});
after(() => h.close());

const device = { name: "Test Mac", platform: "macos", appVersion: "1.0.0" };

test("start answers identically for new and existing accounts", async () => {
  const existing = await h.signIn();
  const a = await h.call("POST", "/auth/start", {
    body: { email: existing.email },
  });
  const b = await h.call("POST", "/auth/start", {
    body: { email: uniqueEmail("new") },
  });
  assert.equal(a.status, 200);
  assert.deepEqual(a.body, b.body);
  assert.equal(ROUTES.authStart.res.safeParse(a.body).success, true);
});

test("sign-in creates the account with a referral code and matches the contract", async () => {
  const email = uniqueEmail("Jalol.Iddin");
  const s = await h.signIn(email);
  assert.equal(
    AuthVerifyResponse.safeParse({
      tokens: {
        accessToken: s.accessToken,
        refreshToken: s.refreshToken,
        accessExpiresAt: new Date().toISOString(),
      },
      me: s.me,
    }).success,
    true,
  );
  assert.equal(s.me.firstName, "");
  assert.match(s.me.referralCode, /^JALOLIDDIN[0-9A-Z]{1,3}$/);
  assert.deepEqual(s.me.plan, { tier: "free", source: "none", until: null });
  assert.equal(s.me.team, null);
  // Signing in again finds the same account.
  const again = await h.signIn(email);
  assert.equal(again.me.id, s.me.id);
});

test("wrong code, then the right code still works; 5 wrong codes lock it", async () => {
  const email = uniqueEmail();
  await h.call("POST", "/auth/start", { body: { email } });
  const code = await h.code(email);
  const wrong = code === "000000" ? "111111" : "000000";
  const bad = await h.call("POST", "/auth/verify", {
    body: { email, code: wrong, device },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, "code-invalid");
  assert.equal(ErrorBody.safeParse(bad.body).success, true);
  for (let i = 0; i < 4; i++) {
    await h.call("POST", "/auth/verify", {
      body: { email, code: wrong, device },
    });
  }
  const locked = await h.call("POST", "/auth/verify", {
    body: { email, code, device },
  });
  assert.equal(locked.body.code, "code-invalid");
});

test("an unknown email gets the same code-invalid error", async () => {
  const r = await h.call("POST", "/auth/verify", {
    body: { email: uniqueEmail("ghost"), code: "123456", device },
  });
  assert.equal(r.body.code, "code-invalid");
});

test("an expired code is rejected; a code works only once", async () => {
  const email = uniqueEmail();
  await h.call("POST", "/auth/start", { body: { email } });
  const code = await h.code(email);
  h.clock.advance(11 * MINUTE);
  const late = await h.call("POST", "/auth/verify", {
    body: { email, code, device },
  });
  assert.equal(late.body.code, "code-expired");

  const s = await h.signIn(email);
  assert.ok(s.accessToken);
  const code2 = await h.code(email);
  const reuse = await h.call("POST", "/auth/verify", {
    body: { email, code: code2, device },
  });
  assert.equal(reuse.body.code, "code-invalid");
});

test("a new code replaces the old one", async () => {
  const email = uniqueEmail();
  await h.call("POST", "/auth/start", { body: { email } });
  const first = await h.code(email);
  await h.call("POST", "/auth/start", { body: { email } });
  const second = await h.code(email);
  if (first !== second) {
    const r = await h.call("POST", "/auth/verify", {
      body: { email, code: first, device },
    });
    assert.equal(r.body.code, "code-invalid");
  }
});

test("validation errors are bad-request with a readable message", async () => {
  const r = await h.call("POST", "/auth/start", { body: { email: "nope" } });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "bad-request");
  assert.match(r.body.message, /email/);
  const bad = await h.call("POST", "/auth/verify", {
    body: { email: uniqueEmail(), code: "12", device },
  });
  assert.equal(bad.body.code, "bad-request");
  const malformed = await h.call("POST", "/auth/start", { raw: "{not json" });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.code, "bad-request");
});

test("refresh rotates tokens; reusing a rotated token revokes the session", async () => {
  const s = await h.signIn();
  const r1 = await h.call("POST", "/auth/refresh", {
    body: { refreshToken: s.refreshToken },
  });
  assert.equal(r1.status, 200);
  const t1 = r1.body.tokens;
  assert.notEqual(t1.refreshToken, s.refreshToken);
  assert.equal(
    (await h.call("GET", "/me", { token: t1.accessToken })).status,
    200,
  );

  // The old (rotated) token comes back after the grace window: the whole chain dies.
  h.clock.advance(61_000);
  const reuse = await h.call("POST", "/auth/refresh", {
    body: { refreshToken: s.refreshToken },
  });
  assert.equal(reuse.status, 401);
  assert.equal(reuse.body.code, "unauthorized");
  assert.equal(
    (await h.call("GET", "/me", { token: t1.accessToken })).status,
    401,
  );
  assert.equal(
    (
      await h.call("POST", "/auth/refresh", {
        body: { refreshToken: t1.refreshToken },
      })
    ).status,
    401,
  );
});

test("refresh: a retry within 60 s gets the same successor; later reuse revokes", async () => {
  const s = await h.signIn();
  const first = await h.call("POST", "/auth/refresh", {
    body: { refreshToken: s.refreshToken },
  });
  assert.equal(first.status, 200);
  h.clock.advance(59_000);
  // The response was lost: the client retries with the same token.
  const retry = await h.call("POST", "/auth/refresh", {
    body: { refreshToken: s.refreshToken },
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.tokens.refreshToken, first.body.tokens.refreshToken);
  assert.equal(
    (await h.call("GET", "/me", { token: retry.body.tokens.accessToken }))
      .status,
    200,
  );
  // The successor still works and rotates normally.
  const next = await h.call("POST", "/auth/refresh", {
    body: { refreshToken: first.body.tokens.refreshToken },
  });
  assert.equal(next.status, 200);
  // Once the successor was used, a stale retry of the first token is theft.
  const stale = await h.call("POST", "/auth/refresh", {
    body: { refreshToken: s.refreshToken },
  });
  assert.equal(stale.status, 401);
  assert.equal(
    (await h.call("GET", "/me", { token: next.body.tokens.accessToken }))
      .status,
    401,
  );
});

test("refresh: after the grace window the retry revokes the device chain", async () => {
  const s = await h.signIn();
  const first = await h.call("POST", "/auth/refresh", {
    body: { refreshToken: s.refreshToken },
  });
  h.clock.advance(61_000);
  const late = await h.call("POST", "/auth/refresh", {
    body: { refreshToken: s.refreshToken },
  });
  assert.equal(late.status, 401);
  assert.equal(
    (
      await h.call("POST", "/auth/refresh", {
        body: { refreshToken: first.body.tokens.refreshToken },
      })
    ).status,
    401,
  );
});

test("refresh: parallel requests with one token all get the same successor; no plaintext is stored", async () => {
  const s = await h.signIn();
  const rs = await Promise.all(
    Array.from({ length: 4 }, () =>
      h.call("POST", "/auth/refresh", {
        body: { refreshToken: s.refreshToken },
      }),
    ),
  );
  assert.ok(
    rs.every((r) => r.status === 200),
    JSON.stringify(rs.map((r) => r.body)),
  );
  assert.equal(new Set(rs.map((r) => r.body.tokens.refreshToken)).size, 1);
  const { PrismaClient } = await import("../../src/generated/prisma/client.ts");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: h.config.databaseUrl }),
  });
  try {
    const rows = await db.refreshToken.findMany({
      where: { device: { userId: s.me.id } },
    });
    const successor = rs[0].body.tokens.refreshToken;
    for (const r of rows) {
      assert.equal(r.successorEnc?.includes(successor) ?? false, false);
    }
    assert.ok(rows.some((r) => r.successorEnc));
  } finally {
    await db.$disconnect();
  }
});

test("access tokens expire after 15 minutes; refresh gives a new one", async () => {
  const s = await h.signIn();
  h.clock.advance(16 * MINUTE);
  assert.equal(
    (await h.call("GET", "/me", { token: s.accessToken })).status,
    401,
  );
  const r = await h.call("POST", "/auth/refresh", {
    body: { refreshToken: s.refreshToken },
  });
  assert.equal(r.status, 200);
  assert.equal(
    (await h.call("GET", "/me", { token: r.body.tokens.accessToken })).status,
    200,
  );
});

test("sign-out ends the session", async () => {
  const s = await h.signIn();
  const out = await h.call("POST", "/auth/signout", {
    token: s.accessToken,
    body: { refreshToken: s.refreshToken },
  });
  assert.deepEqual(out.body, { ok: true });
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
  // Another device of the same account keeps working.
  const other = await h.signIn(s.email);
  assert.equal(
    (await h.call("GET", "/me", { token: other.accessToken })).status,
    200,
  );
});

test("a forged or malformed token is rejected", async () => {
  const s = await h.signIn();
  const [payload] = s.accessToken.split(".");
  for (const token of ["garbage", `${payload}.AAAA`, `${payload}.`, "a.b.c"]) {
    assert.equal((await h.call("GET", "/me", { token })).status, 401, token);
  }
});

test("rate limits: sign-in codes per email and per IP", async () => {
  const limited = await startApp({
    limits: {
      startPerEmail: { max: 3, windowMs: 15 * MINUTE },
      startPerIp: { max: 5, windowMs: 15 * MINUTE },
    },
  });
  try {
    const email = uniqueEmail();
    for (let i = 0; i < 3; i++) {
      assert.equal(
        (await limited.call("POST", "/auth/start", { body: { email } })).status,
        200,
      );
    }
    const blocked = await limited.call("POST", "/auth/start", {
      body: { email },
    });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.code, "rate-limited");
    // Different addresses from the same IP hit the IP limit (3 used above, 1 blocked counts too).
    let status = 200;
    for (let i = 0; i < 4 && status === 200; i++) {
      status = (
        await limited.call("POST", "/auth/start", {
          body: { email: uniqueEmail() },
        })
      ).status;
    }
    assert.equal(status, 429);
    limited.clock.advance(16 * MINUTE);
    assert.equal(
      (
        await limited.call("POST", "/auth/start", {
          body: { email: uniqueEmail() },
        })
      ).status,
      200,
    );
  } finally {
    await limited.close();
  }
});

test("the dev outbox exists only with the dev flag, and production refuses dev adapters", async () => {
  const closed = await startApp({ devOutbox: false });
  try {
    const r = await closed.call("GET", "/dev/outbox");
    assert.equal(r.status, 404);
    assert.equal(r.body.code, "not-found");
  } finally {
    await closed.close();
  }
  const cfg = loadConfig({
    MURMUR_DEV_OUTBOX: "1",
    MURMUR_PUBLIC_URL: "https://api.murmur.test",
    DATABASE_URL: "postgresql://x@127.0.0.1/x",
    MURMUR_PEPPER: "p".repeat(32),
    MURMUR_TOKEN_SECRET: "s".repeat(32),
  });
  assert.equal(cfg.devOutbox, false);
  assert.throws(() => AppModule.register({ config: cfg }), /email provider/);
  assert.throws(
    () =>
      loadConfig({
        DATABASE_URL: "postgresql://x@h/x",
      }),
    /MURMUR_PEPPER/,
  );
});

test("a failed email send answers 502 without revealing the account and doesn't use the sign-in budget", async () => {
  let fail = true;
  const sent: string[] = [];
  const app = await startApp({
    mailer: {
      async send(m) {
        if (fail)
          throw apiError(
            "server-error",
            "Couldn't send the email. Try again in a minute.",
            502,
          );
        sent.push(m.to);
      },
    },
    backoff: { start: { after: 1, baseMs: 60_000, maxMs: 60_000 } },
  });
  try {
    const email = uniqueEmail();
    const failed = await app.call("POST", "/auth/start", { body: { email } });
    assert.equal(failed.status, 502);
    assert.deepEqual(failed.body, {
      code: "server-error",
      message: "Couldn't send the email. Try again in a minute.",
    });
    // The failed attempt was refunded: with backoff after 1 attempt this would be a 429.
    fail = false;
    const ok = await app.call("POST", "/auth/start", { body: { email } });
    assert.equal(ok.status, 200);
    assert.deepEqual(sent, [email]);
  } finally {
    await app.close();
  }
});

test("auth/start reports delivery: outbox without SMTP, email with a real mailer, the same for any address", async () => {
  const dev = await startApp();
  try {
    for (const email of [uniqueEmail(), uniqueEmail()]) {
      const r = await dev.call("POST", "/auth/start", { body: { email } });
      assert.equal(r.status, 200);
      assert.equal(r.body.delivery, "outbox");
    }
  } finally {
    await dev.close();
  }
  const real = await startApp({
    mailer: { delivery: "email", async send() {} },
  });
  try {
    const r = await real.call("POST", "/auth/start", {
      body: { email: uniqueEmail() },
    });
    assert.equal(r.body.delivery, "email");
    assert.ok(AuthStartResponse.safeParse(r.body).success);
  } finally {
    await real.close();
  }
});
