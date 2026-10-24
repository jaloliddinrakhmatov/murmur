import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatInviteToken,
  hashSecret,
  normalizeInviteToken,
  randomInviteToken,
  randomSignInCode,
  safeEqual,
} from "../../src/common/crypto.ts";
import { maskEmail } from "../../src/common/mask.ts";
import { RateLimiter } from "../../src/common/rate-limiter.ts";
import { parseAvatar } from "../../src/services/me.service.ts";

test("rate limiter: allows up to max per window, then blocks, then recovers", () => {
  let t = 1_000;
  const rl = new RateLimiter(() => t);
  for (let i = 0; i < 3; i++) assert.equal(rl.hit("k", 3, 1000).allowed, true);
  const blocked = rl.hit("k", 3, 1000);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterMs, 1000);
  t += 999;
  assert.equal(rl.hit("k", 3, 1000).allowed, false);
  t += 2;
  assert.equal(rl.hit("k", 3, 1000).allowed, true);
});

test("rate limiter: keys are independent and hitMany is all-or-nothing", () => {
  const rl = new RateLimiter(() => 0);
  assert.equal(rl.hit("a", 1, 1000).allowed, true);
  assert.equal(rl.hit("a", 1, 1000).allowed, false);
  assert.equal(rl.hit("b", 1, 1000).allowed, true);
  assert.equal(rl.hitMany("m", 3, 5, 1000).allowed, true);
  assert.equal(rl.hitMany("m", 3, 5, 1000).allowed, false);
  assert.equal(rl.remaining("m", 5, 1000), 2);
  assert.equal(rl.hitMany("m", 2, 5, 1000).allowed, true);
});

test("hashSecret is deterministic, peppered and scoped", () => {
  const h = hashSecret("pepper", "code:a@x.com", "123456");
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, hashSecret("pepper", "code:a@x.com", "123456"));
  assert.notEqual(h, hashSecret("other", "code:a@x.com", "123456"));
  assert.notEqual(h, hashSecret("pepper", "code:b@x.com", "123456"));
  assert.notEqual(h, hashSecret("pepper", "refresh", "123456"));
});

test("safeEqual compares strings of any length", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
});

test("codes and tokens have the expected shape", () => {
  for (let i = 0; i < 200; i++) assert.match(randomSignInCode(), /^\d{6}$/);
  const token = randomInviteToken();
  assert.match(token, /^[A-HJKMNP-Z2-9]{16}$/);
  assert.equal(
    normalizeInviteToken(formatInviteToken(token).toLowerCase()),
    token,
  );
  assert.equal(formatInviteToken("ABCDEFGH"), "ABCD-EFGH");
});

test("maskEmail never reveals more than the first letter and the domain", () => {
  assert.equal(maskEmail("jane@gmail.com"), "j***@gmail.com");
  assert.equal(maskEmail("nonsense"), "***");
});

test("parseAvatar checks the real bytes", () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(4),
  ]);
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  assert.equal(
    parseAvatar(`data:image/png;base64,${png.toString("base64")}`).mime,
    "image/png",
  );
  assert.equal(
    parseAvatar(`data:image/jpeg;base64,${jpg.toString("base64")}`).mime,
    "image/jpeg",
  );
  assert.throws(
    () => parseAvatar(`data:image/png;base64,${jpg.toString("base64")}`),
    /valid PNG or JPEG/,
  );
  assert.throws(
    () => parseAvatar(`data:image/jpeg;base64,${png.toString("base64")}`),
    /valid PNG or JPEG/,
  );
  assert.throws(() => parseAvatar("data:image/gif;base64,R0lG"), /PNG or JPEG/);
});
