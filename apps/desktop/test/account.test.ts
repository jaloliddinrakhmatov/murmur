// Stage B: the Murmur account client, against an in-memory server that speaks the shared
// contract. Nothing here opens a socket, touches the real Keychain or reads real History.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AccountService,
  localDay,
  msUntilNextReport,
  previousDay,
  type TokenVault,
} from "../src/main/account/service.ts";
import { createTokenVault } from "../src/main/account/vault.ts";
import { AccountError, friendlyMessage } from "../src/main/account/errors.ts";
import { fitAvatar, type AvatarImage } from "../src/main/account/avatar.ts";
import { FakeMurmurServer } from "../src/main/account/fake-server.ts";
import {
  KeychainSecrets,
  SecureStorage,
  testKeychain,
} from "../src/main/settings/secure-storage.ts";
import { SettingsStore } from "../src/main/settings/store.ts";
import { checkServerUrl } from "../src/shared/server-url.ts";
import { parseSettingsPatch, SettingsSchema } from "../src/shared/settings.ts";
import type { AccountStatus, LocalDataCounts } from "../src/shared/account.ts";

const EMAIL = "sample.person@example.com";

function rig(
  options: {
    keychain?: string;
    serverUrl?: string;
    packaged?: boolean;
    dir?: string;
    server?: FakeMurmurServer;
    fetch?: typeof fetch;
    now?: () => number;
    localData?: () => LocalDataCounts;
  } = {},
) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "murmur-account-"));
  const server = options.server ?? new FakeMurmurServer();
  const logs: string[] = [];
  const log = (e: string, d?: Record<string, unknown>) =>
    logs.push(e + (d ? JSON.stringify(d) : ""));
  const secure = new SecureStorage(
    testKeychainShared(options.keychain ?? "available"),
    log,
  );
  let secrets!: KeychainSecrets;
  const store = new SettingsStore(dir, {
    encrypt: () => {
      throw new Error("async only");
    },
    decrypt: (b) => secrets.decryptCached(b),
  });
  secrets = new KeychainSecrets(store, secure, log);
  const vault = createTokenVault(secure, secrets, store);
  const words = new Map<string, number>();
  const events: AccountStatus[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const make = (v: TokenVault = vault) =>
    new AccountService({
      fetch: options.fetch ?? server.fetch,
      serverUrl: () => options.serverUrl ?? "http://127.0.0.1:4000",
      packaged: options.packaged ?? false,
      vault: v,
      appVersion: "9.9.9",
      wordsOn: (day) => words.get(day) ?? 0,
      now: options.now ?? (() => server.now()),
      notify: (s) => events.push(s),
      log,
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clearTimer: () => {},
      owner: {
        get: () => store.get().account.owner,
        set: (owner) => store.set("account", { ...store.get().account, owner }),
      },
      localData: options.localData,
    });
  return {
    dir,
    server,
    secure,
    secrets,
    store,
    vault,
    words,
    events,
    timers,
    logs,
    account: make(),
    make,
  };
}

// One simulated Mac Keychain per mode, shared by every profile in a test.
const keychains = new Map<string, ReturnType<typeof testKeychain>>();
function testKeychainShared(mode: string) {
  if (!keychains.has(mode)) keychains.set(mode, testKeychain(mode));
  return keychains.get(mode)!;
}

async function signIn(r: ReturnType<typeof rig>) {
  await r.account.startSignIn({ email: EMAIL });
  return r.account.verify({ email: EMAIL, code: "123456" });
}

const secretsFile = (dir: string) =>
  readFileSync(join(dir, "secrets.json"), "utf8");

test("nothing contacts the server until the person signs in", async () => {
  const r = rig();
  await r.account.restore();
  r.account.snapshot();
  assert.equal(r.server.requests.length, 0);
  assert.equal(r.account.snapshot().phase, "signed-out");
  await r.account.reportUsage();
  assert.equal(r.server.requests.length, 0);
});

test("sign-in: code, profile, and a Keychain-encrypted refresh token", async () => {
  const r = rig();
  const start = await r.account.startSignIn({
    email: ` ${EMAIL.toUpperCase()} `,
  });
  assert.equal(start.expiresInSec, 600);
  assert.deepEqual(r.server.requests.at(-1)?.body, { email: EMAIL });
  const status = await r.account.verify({ email: EMAIL, code: "123456" });
  assert.equal(status.phase, "signed-in");
  assert.equal(status.me?.email, EMAIL);
  assert.ok(status.billing && status.referrals);
  assert.equal(status.team, null);
  const verify = r.server.requests.find((q) => q.path === "/auth/verify");
  assert.deepEqual(verify?.body?.device, {
    name: "Murmur on macOS",
    platform: "macos",
    appVersion: "9.9.9",
  });
  // The token is saved, encrypted, and reads back after a restart of the client.
  const saved = await r.vault.load();
  assert.equal(saved.state, "ok");
  const token = saved.state === "ok" ? saved.token : "";
  assert.ok(token.startsWith("rtok_"));
  assert.ok(
    !secretsFile(r.dir).includes(token),
    "the token is never plaintext",
  );
  assert.ok(
    !JSON.stringify(status).includes(token),
    "the window never sees it",
  );
});

test("a wrong code is explained and leaves you signed out", async () => {
  const r = rig();
  await r.account.startSignIn({ email: EMAIL });
  await assert.rejects(
    r.account.verify({ email: EMAIL, code: "000000" }),
    (e: AccountError) =>
      e.code === "code-invalid" && /isn't right/.test(e.message),
  );
  assert.equal(r.account.snapshot().phase, "signed-out");
  assert.equal((await r.vault.load()).state, "absent");
  await assert.rejects(
    r.account.verify({ email: EMAIL, code: "12" }),
    (e: AccountError) =>
      e.code === "invalid-input" && /6-digit/.test(e.message),
  );
  await assert.rejects(
    r.account.startSignIn({ email: "not an email" }),
    (e: AccountError) => e.code === "invalid-input",
  );
});

test("without a usable Keychain you stay signed out, and say so before asking for a code", async () => {
  const r = rig({ keychain: "deny" });
  await assert.rejects(
    r.account.startSignIn({ email: EMAIL }),
    (e: AccountError) => e.code === "keychain",
  );
  assert.equal(r.server.requests.length, 0, "no email is sent");
  const s = r.account.snapshot();
  assert.equal(s.phase, "signed-out");
  assert.equal(s.keychain, "unavailable");
});

test("a sign-in that can't be saved is revoked and you stay signed out", async () => {
  const r = rig();
  const failing: TokenVault = {
    ...r.vault,
    save: () => Promise.reject(new Error("no keychain")),
  };
  const account = r.make(failing);
  await account.startSignIn({ email: EMAIL });
  await assert.rejects(
    account.verify({ email: EMAIL, code: "123456" }),
    (e: AccountError) => e.code === "keychain",
  );
  assert.equal(account.snapshot().phase, "signed-out");
  assert.ok(r.server.requests.some((q) => q.path === "/auth/signout"));
});

test("a saved sign-in is restored once, in the background", async () => {
  const r = rig();
  await signIn(r);
  const again = r.make();
  assert.equal(again.snapshot().phase, "signed-out");
  const before = r.server.requests.length;
  await again.restore();
  assert.equal(again.snapshot().phase, "signed-in");
  assert.equal(again.snapshot().me?.email, EMAIL);
  const paths = r.server.requests.slice(before).map((q) => q.path);
  assert.equal(paths[0], "/auth/refresh");
  assert.ok(paths.includes("/me"));
});

test("a revoked saved sign-in is cleared and explained", async () => {
  const r = rig();
  await signIn(r);
  r.server.revokeRefreshTokens();
  const again = r.make();
  await again.restore();
  const s = again.snapshot();
  assert.equal(s.phase, "signed-out");
  assert.match(s.notice ?? "", /ended/);
  assert.equal((await r.vault.load()).state, "absent");
});

test("restoring offline keeps the sign-in and offers to try again", async () => {
  const r = rig();
  await signIn(r);
  r.server.offline = true;
  const again = r.make();
  await again.restore();
  let s = again.snapshot();
  assert.equal(s.phase, "signed-in");
  assert.equal(s.offline, true);
  assert.equal(s.me, null);
  r.server.offline = false;
  s = await again.refresh();
  assert.equal(s.offline, false);
  assert.equal(s.me?.email, EMAIL);
});

test("an unreadable saved sign-in is left alone and you are told", async () => {
  const r = rig();
  const locked: TokenVault = {
    ...r.vault,
    load: async () => ({ state: "unreadable" }),
    clear: () => assert.fail("must not delete what it can't read"),
  };
  const account = r.make(locked);
  await account.restore();
  assert.equal(account.snapshot().phase, "signed-out");
  assert.equal(account.snapshot().keychain, "unavailable");
  assert.equal(r.server.requests.length, 0);
});

test("an expired access token is refreshed, and a 401 is retried exactly once", async () => {
  const r = rig();
  await signIn(r);
  const refreshes = () =>
    r.server.requests.filter((q) => q.path === "/auth/refresh").length;
  const oldToken = (await r.vault.load()) as { token: string };
  r.server.expireAccessTokens();
  const s = await r.account.refresh();
  assert.equal(s.me?.email, EMAIL);
  assert.equal(refreshes(), 1);
  const rotated = (await r.vault.load()) as { token: string };
  assert.notEqual(rotated.token, oldToken.token, "the rotated token is saved");
  // The clock passes the access token's expiry: refreshed before the call, no 401 needed.
  const base = r.server.now();
  r.server.now = () => base + 60 * 60_000;
  await r.account.refresh();
  assert.equal(refreshes(), 2);
});

test("simultaneous requests share one refresh", async () => {
  const r = rig();
  await signIn(r);
  r.server.expireAccessTokens();
  const before = r.server.requests.filter(
    (q) => q.path === "/auth/refresh",
  ).length;
  await Promise.all([
    r.account.updateProfile({ firstName: "Sam" }),
    r.account.updateProfile({ lastName: "Rivera" }),
  ]);
  const after = r.server.requests.filter(
    (q) => q.path === "/auth/refresh",
  ).length;
  assert.equal(after - before, 1);
  assert.equal(r.account.snapshot().me?.firstName, "Sam");
});

test("offline: errors say so, the flag follows the network, local state is kept", async () => {
  const r = rig();
  await signIn(r);
  r.server.offline = true;
  await assert.rejects(
    r.account.updateProfile({ firstName: "Sam" }),
    (e: AccountError) =>
      e.code === "offline" && e.message === "Can't reach Murmur's server",
  );
  const s = r.account.snapshot();
  assert.equal(s.offline, true);
  assert.equal(s.phase, "signed-in");
  assert.equal(s.me?.email, EMAIL, "the cached profile stays");
  r.server.offline = false;
  await r.account.refresh();
  assert.equal(r.account.snapshot().offline, false);
});

test("server error codes become plain messages", async () => {
  const r = rig();
  await signIn(r);
  const own = r.account.snapshot().me!.referralCode;
  await assert.rejects(
    r.account.applyReferral({ code: own.toLowerCase() }),
    (e: AccountError) =>
      e.code === "referral-own-code" && /own code/.test(e.message),
  );
  await assert.rejects(
    r.account.applyReferral({ code: "toolate1" }),
    (e: AccountError) =>
      e.code === "referral-too-late" && /30 days/.test(e.message),
  );
  const s = await r.account.applyReferral({ code: " friend12 " });
  assert.equal(s.referrals?.applied?.code, "FRIEND12");
  await assert.rejects(
    r.account.applyReferral({ code: "FRIEND12" }),
    (e: AccountError) => e.code === "referral-already-applied",
  );
  await assert.rejects(
    r.account.applyPromo({ code: "nope" }),
    (e: AccountError) => e.code === "promo-invalid",
  );
  for (const code of [
    "bad-request",
    "unauthorized",
    "forbidden",
    "not-found",
    "conflict",
    "rate-limited",
    "code-invalid",
    "code-expired",
    "team-exists",
    "team-last-owner",
    "seats-full",
    "server-error",
  ] as const)
    assert.ok(friendlyMessage(code).length > 10, code);
  assert.equal(
    friendlyMessage("bad-request", "Name is too long"),
    "Name is too long",
  );
  assert.ok(
    friendlyMessage("bad-request", "x".repeat(500)).length < 100,
    "a long server message isn't shown",
  );
});

test("a reply the contract doesn't allow is reported, not trusted", async () => {
  const bad = rig({
    fetch: async () =>
      new Response(JSON.stringify({ ok: "yes" }), { status: 200 }),
  });
  await assert.rejects(
    bad.account.startSignIn({ email: EMAIL }),
    (e: AccountError) => e.code === "invalid-response",
  );
  const html = rig({
    fetch: async () =>
      new Response("<html>Bad gateway</html>", { status: 502 }),
  });
  await assert.rejects(
    html.account.startSignIn({ email: EMAIL }),
    (e: AccountError) => e.code === "server-error" && /problem/.test(e.message),
  );
});

test("server addresses: https or this Mac; packaged builds nothing else", async () => {
  const ok = (u: string, packaged = true) => checkServerUrl(u, { packaged }).ok;
  assert.ok(ok("https://api.murmur.example"));
  assert.ok(ok("http://127.0.0.1:4000"));
  assert.ok(ok("http://localhost:4000/"));
  assert.ok(ok("http://[::1]:4000"));
  assert.ok(!ok("http://api.murmur.example"));
  assert.ok(!ok("ftp://127.0.0.1"));
  assert.ok(!ok("https://user:pw@api.murmur.example"));
  assert.ok(!ok("https://api.murmur.example/?a=1"));
  assert.ok(!ok("not a url"));
  assert.ok(
    ok("http://192.168.1.20:4000", false),
    "development allows a LAN test server",
  );
  const base = checkServerUrl("https://api.murmur.example/base/", {
    packaged: true,
  });
  assert.equal(base.ok && base.url, "https://api.murmur.example/base");

  let called = 0;
  const r = rig({
    serverUrl: "http://api.murmur.example",
    packaged: true,
    fetch: async () => {
      called++;
      return new Response("{}");
    },
  });
  await assert.rejects(
    r.account.startSignIn({ email: EMAIL }),
    (e: AccountError) => e.code === "server-url",
  );
  assert.equal(called, 0, "nothing is sent to a disallowed address");
  // The settings file and settings patches enforce the same rule.
  const settings = SettingsSchema.parse({
    account: { serverUrl: "http://evil.example" },
  });
  assert.equal(settings.account.serverUrl, "http://127.0.0.1:4000");
  // The renderer can't change it at all (see the next test).
  assert.equal(
    "account" in
      parseSettingsPatch({
        account: { serverUrl: "https://api.murmur.example" },
      }),
    false,
  );
});

test("requests never follow a redirect with the token", async () => {
  let init: RequestInit | undefined;
  const r = rig({
    fetch: async (_u, i) => {
      init = i;
      return new Response(JSON.stringify({ ok: true, expiresInSec: 600 }));
    },
  });
  await r.account.startSignIn({ email: EMAIL });
  assert.equal(init?.redirect, "error");
});

test("sign-out revokes on the server, deletes the token, and works offline", async () => {
  const r = rig();
  await signIn(r);
  const s = await r.account.signOut();
  assert.equal(s.phase, "signed-out");
  assert.equal(s.me, null);
  assert.equal((await r.vault.load()).state, "absent");
  assert.ok(r.server.requests.some((q) => q.path === "/auth/signout"));

  const off = rig();
  await signIn(off);
  off.server.offline = true;
  const out = await off.account.signOut();
  assert.equal(out.phase, "signed-out");
  assert.equal((await off.vault.load()).state, "absent");
  assert.equal(out.offline, false);
});

test("deleting the account needs the typed email", async () => {
  const r = rig();
  await signIn(r);
  const before = r.server.requests.length;
  await assert.rejects(
    r.account.deleteAccount({ confirmEmail: "someone.else@example.com" }),
    (e: AccountError) => e.code === "invalid-input",
  );
  assert.equal(r.server.requests.length, before, "nothing is sent");
  const s = await r.account.deleteAccount({
    confirmEmail: EMAIL.toUpperCase(),
  });
  assert.equal(s.phase, "signed-out");
  assert.equal((await r.vault.load()).state, "absent");
});

test("profile, picture and teams", async () => {
  const r = rig();
  await signIn(r);
  let s = await r.account.updateProfile({
    firstName: " Sam ",
    lastName: "Rivera",
  });
  assert.equal(s.me?.firstName, "Sam");
  s = await r.account.setAvatar("data:image/png;base64,iVBORw0KGgo=");
  assert.ok(s.me?.avatar?.startsWith("data:image/png"));
  s = await r.account.removeAvatar();
  assert.equal(s.me?.avatar, null);
  await assert.rejects(
    r.account.setAvatar("data:text/html;base64,AAAA"),
    (e: AccountError) => e.code === "invalid-input",
  );

  s = await r.account.createTeam({
    name: "Sample team",
    invites: ["a@example.com", "b@example.com"],
  });
  assert.equal(s.team?.name, "Sample team");
  assert.equal(s.me?.team?.role, "owner");
  assert.equal(s.me?.plan.source, "trial", "the team trial is picked up");
  assert.equal(s.team?.invites.length, 2);
  s = await r.account.inviteToTeam({ emails: ["c@example.com"] });
  assert.equal(s.team?.invites.length, 3);
  const id = s.team!.invites[0].id;
  s = await r.account.revokeInvite(id);
  assert.equal(s.team?.invites.find((i) => i.id === id)?.status, "revoked");
  s = await r.account.renameTeam({ name: "Renamed" });
  assert.equal(s.me?.team?.name, "Renamed");
  await assert.rejects(
    r.account.createTeam({ name: "Another" }),
    (e: AccountError) => e.code === "team-exists",
  );
  await assert.rejects(
    r.account.leaveTeam(),
    (e: AccountError) => e.code === "team-last-owner",
  );
  await assert.rejects(
    r.account.inviteToTeam({ emails: ["bad"] }),
    (e: AccountError) => e.code === "invalid-input",
  );
  await assert.rejects(
    r.account.createTeam({ name: "   " }),
    (e: AccountError) => e.code === "invalid-input",
  );
});

test("a second person joins with the invite code and can leave", async () => {
  const owner = rig();
  await signIn(owner);
  await owner.account.createTeam({ name: "Sample team" });
  const token = owner.server.inviteToken()!;
  const guest = rig({ server: owner.server });
  await guest.account.startSignIn({ email: "guest@example.com" });
  await guest.account.verify({ email: "guest@example.com", code: "123456" });
  await assert.rejects(
    guest.account.joinTeam({ token: "short" }),
    (e: AccountError) => e.code === "invalid-input",
  );
  let s = await guest.account.joinTeam({ token });
  assert.equal(s.me?.team?.role, "member");
  assert.equal(s.team?.invites.length, 0, "members don't see invites");
  s = await guest.account.leaveTeam();
  assert.equal(s.team, null);
  assert.equal(s.me?.team, null);
});

test("plans and checkout: test mode, seats, enterprise contact", async () => {
  const r = rig();
  await signIn(r);
  const monthly = await r.account.plans("monthly");
  const annual = await r.account.plans("annual");
  assert.equal(monthly.plans.length, 3);
  assert.ok(annual.plans[1].priceCents! < monthly.plans[1].priceCents!);
  assert.equal(r.account.snapshot().billing?.testMode, true);
  await r.account.createTeam({
    name: "Sample team",
    invites: ["a@example.com"],
  });
  const res = await r.account.checkout({ plan: "pro", interval: "annual" });
  assert.equal(res.kind, "activated");
  const checkout = r.server.requests.find(
    (q) => q.path === "/billing/checkout",
  );
  assert.deepEqual(checkout?.body, {
    plan: "pro",
    interval: "annual",
    seats: 1,
  });
  assert.equal(r.account.snapshot().billing?.subscription?.plan, "pro");
  assert.equal(r.account.snapshot().me?.plan.source, "subscription");
  const contact = await r.account.checkout({
    plan: "enterprise",
    interval: "monthly",
  });
  assert.equal(contact.kind, "contact");
  const s = await r.account.cancelSubscription();
  assert.equal(s.billing?.subscription?.cancelAtPeriodEnd, true);
  const promo = await r.account.applyPromo({ code: "welcome" });
  assert.equal(promo.billing?.promo?.code, "WELCOME");
});

test("usage: a daily word count only, sent while signed in, never repeated", async () => {
  const day = new Date(2026, 9, 20, 14, 0, 0);
  const r = rig({ now: () => day.getTime() });
  r.server.now = () => day.getTime();
  r.words.set("2026-10-20", 1234);
  r.words.set("2026-10-19", 800);
  r.words.set("2026-10-18", 99);
  // Signed out: nothing is sent.
  await r.account.reportUsage();
  assert.equal(r.server.requests.length, 0);

  await signIn(r);
  await new Promise((resolve) => setImmediate(resolve));
  const usage = r.server.requests.filter((q) => q.path === "/usage");
  assert.equal(usage.length, 2, "yesterday's final count and today's so far");
  for (const q of usage) {
    assert.deepEqual(Object.keys(q.body!).sort(), ["day", "words"]);
    assert.equal(typeof q.body!.words, "number");
  }
  assert.equal(r.server.usage.get("2026-10-20"), 1234);
  assert.equal(r.server.usage.get("2026-10-19"), 800);
  assert.equal(r.server.usage.has("2026-10-18"), false);
  assert.deepEqual(r.account.snapshot().usage.day, "2026-10-20");
  assert.equal(r.account.snapshot().usage.words, 1234);

  // Unchanged counts aren't sent again; a changed one is.
  await r.account.reportUsage();
  assert.equal(r.server.requests.filter((q) => q.path === "/usage").length, 2);
  r.words.set("2026-10-20", 1500);
  await r.account.reportUsage();
  assert.equal(r.server.usage.get("2026-10-20"), 1500);
  // A day without words is skipped.
  r.words.clear();
  const n = r.server.requests.length;
  await r.account.reportUsage();
  assert.equal(r.server.requests.length, n);
  // The daily timer is set at sign-in, and ends with the session.
  assert.equal(r.timers.length, 1);
  await r.account.signOut();
  await r.account.reportUsage();
  assert.equal(r.server.requests.filter((q) => q.path === "/usage").length, 3);
});

test("a failed usage report is silent and retried later", async () => {
  const day = new Date(2026, 9, 20, 9, 0, 0);
  const r = rig({ now: () => day.getTime() });
  r.server.now = () => day.getTime();
  await signIn(r);
  r.words.set("2026-10-20", 50);
  r.server.offline = true;
  await r.account.reportUsage();
  assert.ok(r.logs.some((l) => l.startsWith("account.usage.failed")));
  assert.equal(r.server.usage.size, 0);
  r.server.offline = false;
  await r.account.reportUsage();
  assert.equal(r.server.usage.get("2026-10-20"), 50);
});

test("usage helpers: local days and the daily schedule", () => {
  const noon = new Date(2026, 2, 1, 12, 0, 0).getTime();
  assert.equal(localDay(noon), "2026-03-01");
  assert.equal(previousDay("2026-03-01"), "2026-02-28");
  assert.equal(previousDay("2026-01-01"), "2025-12-31");
  const ms = msUntilNextReport(noon);
  assert.equal(localDay(noon + ms), "2026-03-02");
  assert.equal(ms, 12 * 3_600_000 + 60_000);
});

test("pictures are cropped square and fitted under the limit", () => {
  const make = (
    pngBytes: (side: number) => number,
    jpegBytes = 100,
  ): AvatarImage => {
    const build = (side: number): AvatarImage => ({
      isEmpty: () => false,
      square: () => build(side),
      scaled: (s) => build(s),
      size: () => side,
      png: () => Buffer.alloc(pngBytes(side), 1),
      jpeg: () => Buffer.alloc(jpegBytes, 2),
    });
    return build(2000);
  };
  const small = fitAvatar(make((side) => side * 2));
  assert.match(small, /^data:image\/png;base64,/);
  // Too big as a PNG at every size: JPEG is used instead.
  const jpeg = fitAvatar(make(() => 2_000_000, 500_000));
  assert.match(jpeg, /^data:image\/jpeg;base64,/);
  assert.throws(
    () => fitAvatar(make(() => 2_000_000, 2_000_000)),
    (e: AccountError) => e.code === "invalid-input",
  );
  assert.throws(
    () => fitAvatar({ ...make(() => 1), isEmpty: () => true }),
    (e: AccountError) => /PNG or JPEG/.test(e.message),
  );
  // Only as large as it needs to be.
  const decoded = Buffer.from(small.split(",")[1], "base64");
  assert.ok(decoded.length <= 1_000_000);
});

test("the server address can't be changed by a settings patch", () => {
  const patch = parseSettingsPatch({
    account: { serverUrl: "https://attacker.example" },
    appearance: "dark",
  });
  assert.equal("account" in patch, false);
  assert.equal(patch.appearance, "dark");
});

test("the token is kept with its server and never sent to another", async () => {
  const r = rig();
  await signIn(r);
  assert.equal((await r.vault.load()).state, "ok");
  const stored = await r.vault.load();
  assert.equal(stored.state === "ok" && stored.origin, "http://127.0.0.1:4000");

  // The configured address changes: nothing is sent, the session ends.
  let called = 0;
  const moved = new AccountService({
    fetch: async () => {
      called++;
      return new Response("{}");
    },
    serverUrl: () => "https://other.example",
    packaged: false,
    vault: r.vault,
    appVersion: "9.9.9",
    wordsOn: () => 0,
    notify: () => {},
    log: () => {},
  });
  await moved.restore();
  assert.equal(called, 0);
  assert.equal(moved.snapshot().phase, "signed-out");
  assert.match(moved.snapshot().notice ?? "", /server address changed/);
  assert.equal((await r.vault.load()).state, "absent");
});

test("a sign-in saved without a server address is not sent anywhere", async () => {
  const r = rig();
  await signIn(r);
  const old = JSON.parse(r.store.getSecret("account:refresh") ?? "") as {
    token: string;
  };
  await r.secrets.set("account:refresh", old.token); // an earlier version's bare token
  const before = r.server.requests.length;
  const again = r.make();
  await again.restore();
  assert.equal(r.server.requests.length, before);
  assert.equal(again.snapshot().phase, "signed-out");
});

test("a server address that changes mid-session ends it before any request", async () => {
  const r = rig();
  let url = "http://127.0.0.1:4000";
  const seen: string[] = [];
  const account = new AccountService({
    fetch: (u, i) => {
      seen.push(String(u));
      return r.server.fetch(u, i);
    },
    serverUrl: () => url,
    packaged: false,
    vault: r.vault,
    appVersion: "9.9.9",
    wordsOn: () => 0,
    now: () => r.server.now(),
    notify: () => {},
    log: () => {},
    setTimer: () => 1,
    clearTimer: () => {},
  });
  await account.startSignIn({ email: EMAIL });
  await account.verify({ email: EMAIL, code: "123456" });
  seen.length = 0;
  url = "https://other.example";
  await assert.rejects(account.refresh().then(() => account.plans("monthly")));
  assert.deepEqual(seen, []);
  assert.equal(account.snapshot().phase, "signed-out");
});

test("usage starts after a restore that began offline, once a load succeeds", async () => {
  const day = new Date(2026, 9, 20, 14, 0, 0);
  const r = rig({ now: () => day.getTime() });
  r.server.now = () => day.getTime();
  r.words.set("2026-10-20", 77);
  await signIn(r);
  await new Promise((resolve) => setImmediate(resolve));
  r.server.usage.clear();
  r.server.offline = true;
  const again = r.make();
  await again.restore();
  assert.equal(r.timers.length, 1, "only the first sign-in's timer");
  r.server.offline = false;
  await again.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(r.server.usage.get("2026-10-20"), 77);
  assert.equal(r.timers.length, 2);
  await again.refresh();
  assert.equal(r.timers.length, 2, "not started twice");
});

test("sign-out ends the session even when the stored sign-in can't be removed", async () => {
  const r = rig();
  await signIn(r);
  const stuck: TokenVault = {
    ...r.vault,
    clear: () => {
      throw new Error("secrets.json unreadable");
    },
  };
  const account = r.make(stuck);
  await account.restore();
  assert.equal(account.snapshot().phase, "signed-in");
  const s = await account.signOut();
  assert.equal(s.phase, "signed-out");
  assert.equal(s.me, null);
  assert.match(s.notice ?? "", /couldn't remove your saved sign-in/);
  assert.ok(r.logs.some((l) => l.startsWith("account.token.clear-failed")));
  await assert.rejects(
    account.plans("monthly"),
    (e: AccountError) => e.code === "signed-out",
  );
});

test("sign-in reports how the code was delivered; the newest test-outbox code is read only in development", async () => {
  const dev = rig();
  dev.server.delivery = "outbox";
  const start = await dev.account.startSignIn({ email: EMAIL });
  assert.equal(start.delivery, "outbox");
  assert.equal(await dev.account.devOutboxCode(EMAIL), "123456");
  const asked = dev.server.requests.at(-1);
  assert.equal(asked?.path, "/dev/outbox");

  dev.server.delivery = "email";
  assert.equal(
    (await dev.account.startSignIn({ email: EMAIL })).delivery,
    "email",
  );

  dev.server.delivery = undefined;
  assert.equal(
    (await dev.account.startSignIn({ email: EMAIL })).delivery,
    undefined,
  );

  const packaged = rig({ packaged: true });
  const before = packaged.server.requests.length;
  assert.equal(await packaged.account.devOutboxCode(EMAIL), null);
  assert.equal(packaged.server.requests.length, before);
});

test("a slow server (e.g. still sending the email) says so, not that it can't be reached", async () => {
  const r = rig({
    fetch: async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    },
  });
  await assert.rejects(
    r.account.startSignIn({ email: "sam@example.com" }),
    (e: AccountError) =>
      e.code === "offline" &&
      e.message === "Murmur's server didn't answer in time. Try again.",
  );
});

const NO_DATA: LocalDataCounts = {
  dictations: 0,
  notes: 0,
  meetings: 0,
  dictionary: 0,
  snippets: 0,
};

test("whose data: the first account on a Mac without data is recorded silently", async () => {
  const r = rig({ localData: () => NO_DATA });
  const status = await signIn(r);
  assert.equal(status.switchPrompt, null);
  assert.equal(r.store.get().account.owner?.email, EMAIL);
  assert.equal(r.store.get().account.owner?.id, status.me?.id);
});

test("whose data: another account on a Mac with data is asked; keep records it, signing out forgets the question", async () => {
  let counts = NO_DATA;
  const r = rig({ localData: () => counts });
  const first = await signIn(r);
  await r.account.signOut();

  counts = { ...NO_DATA, dictations: 12, notes: 2 };
  await r.account.startSignIn({ email: "second.person@example.com" });
  const second = await r.account.verify({
    email: "second.person@example.com",
    code: "123456",
  });
  assert.notEqual(second.me?.id, first.me?.id);
  assert.deepEqual(second.switchPrompt, { previousEmail: EMAIL, counts });
  assert.equal(r.account.switchPending(), true);
  assert.equal(
    r.store.get().account.owner?.email,
    EMAIL,
    "nothing is handed over until the person chooses",
  );
  // A refresh keeps the same question.
  assert.deepEqual((await r.account.refresh()).switchPrompt?.counts, counts);

  const kept = r.account.acceptOwner();
  assert.equal(kept.switchPrompt, null);
  assert.equal(r.store.get().account.owner?.email, "second.person@example.com");
  assert.equal(r.events.at(-1)?.switchPrompt, null, "the Hub is told");

  // The same account again: no question.
  await r.account.signOut();
  await r.account.startSignIn({ email: "second.person@example.com" });
  const again = await r.account.verify({
    email: "second.person@example.com",
    code: "123456",
  });
  assert.equal(again.switchPrompt, null);

  // Asked, then signed out without choosing: the question goes with the session.
  await r.account.signOut();
  await signIn(r);
  assert.ok(r.account.snapshot().switchPrompt);
  assert.equal((await r.account.signOut()).switchPrompt, null);
});

test("whose data: a Mac with data and no recorded account asks once a saved sign-in is restored", async () => {
  let counts = NO_DATA;
  const r = rig({ localData: () => counts });
  await signIn(r);
  // An older version signed in without recording whose data this is.
  r.store.set("account", { ...r.store.get().account, owner: null });
  counts = { ...NO_DATA, dictionary: 3 };
  const again = r.make();
  await again.restore();
  assert.deepEqual(again.snapshot().switchPrompt, {
    previousEmail: null,
    counts,
  });
});
