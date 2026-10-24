import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalEmail } from "../../src/domain/email.ts";
import { decryptSecret, encryptSecret } from "../../src/common/crypto.ts";
import { defaultLimits, loadConfig } from "../../src/config/env.ts";

test("canonicalEmail: case, +tag, gmail dots and googlemail", () => {
  assert.equal(canonicalEmail("Jane.Doe+promo@Gmail.com"), "janedoe@gmail.com");
  assert.equal(canonicalEmail("j.a.n.e@googlemail.com"), "jane@gmail.com");
  assert.equal(
    canonicalEmail("jane.doe+x@example.com"),
    "jane.doe@example.com",
  );
  assert.equal(canonicalEmail("a+b+c@example.com"), "a@example.com");
});

test("encryptSecret round-trips, is bound to its row and detects tampering", () => {
  const c = encryptSecret("s", "p", "row1", "token-value");
  assert.notEqual(c, "token-value");
  assert.equal(c.includes("token-value"), false);
  assert.equal(decryptSecret("s", "p", "row1", c), "token-value");
  assert.equal(decryptSecret("s", "p", "row2", c), null);
  assert.equal(decryptSecret("other", "p", "row1", c), null);
  assert.equal(decryptSecret("s", "p", "row1", c.slice(0, -2) + "AA"), null);
  assert.notEqual(c, encryptSecret("s", "p", "row1", "token-value"));
});

test("config: only MURMUR_ENV=development|test allows dev defaults", () => {
  const strong = "x".repeat(40);
  for (const value of [
    undefined,
    "",
    "production",
    "dev",
    "Development",
    "staging",
  ]) {
    const env: NodeJS.ProcessEnv =
      value === undefined ? {} : { MURMUR_ENV: value };
    assert.throws(() => loadConfig(env), /MURMUR_PEPPER/, String(value));
    assert.throws(
      () =>
        loadConfig({ ...env, NODE_ENV: "development", MURMUR_DEV_OUTBOX: "1" }),
      /MURMUR_PEPPER/,
    );
  }
  const prod = {
    MURMUR_PEPPER: strong,
    MURMUR_TOKEN_SECRET: strong.replace(/x/g, "y"),
    DATABASE_URL: "postgresql://x",
    MURMUR_PUBLIC_URL: "https://api.murmur.test",
    MURMUR_DEV_OUTBOX: "1",
  };
  const c = loadConfig(prod);
  assert.equal(c.production, true);
  assert.equal(c.devOutbox, false);
  assert.equal(c.publicHost, "api.murmur.test");
  assert.throws(
    () => loadConfig({ ...prod, DATABASE_URL: undefined }),
    /DATABASE_URL/,
  );
  assert.throws(
    () => loadConfig({ ...prod, MURMUR_PUBLIC_URL: undefined }),
    /MURMUR_PUBLIC_URL/,
  );
  assert.throws(
    () => loadConfig({ ...prod, MURMUR_PUBLIC_URL: "http://x.test" }),
    /https/,
  );
  assert.throws(
    () => loadConfig({ ...prod, MURMUR_TOKEN_SECRET: strong }),
    /differ/,
  );

  for (const e of ["development", "test"]) {
    const d = loadConfig({ MURMUR_ENV: e, MURMUR_DEV_OUTBOX: "1" });
    assert.equal(d.production, false);
    assert.equal(d.devOutbox, true);
  }
  assert.equal(defaultLimits().startPerEmailDaily.max, 10);
  assert.equal(defaultLimits().verifyPerEmailDaily.max, 50);
});

test("hostAllowed: production accepts only the configured public host", async () => {
  const { hostAllowed } = await import("../../src/common/host.ts");
  const prod = { production: true, publicHost: "api.murmur.test" };
  assert.equal(hostAllowed("api.murmur.test", 443, prod), true);
  assert.equal(hostAllowed("API.murmur.test", 443, prod), true);
  assert.equal(hostAllowed("evil.test", 443, prod), false);
  assert.equal(hostAllowed("127.0.0.1:4000", 4000, prod), false);
  assert.equal(hostAllowed(undefined, 4000, prod), false);
  const dev = { production: false, publicHost: "api.murmur.test" };
  assert.equal(hostAllowed("api.murmur.test", 4000, dev), false);
  assert.equal(hostAllowed("127.0.0.1:4000", 4000, dev), true);
});
