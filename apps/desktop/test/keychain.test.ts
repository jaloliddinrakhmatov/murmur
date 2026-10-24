// Stage 8 Keychain fix, with a simulated Keychain (no real macOS Keychain is touched): start-up
// never waits on it, one request at a time, late answers applied, and existing encrypted keys and
// recordings are never replaced, deleted or misread while it is unavailable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KeychainSecrets,
  SecureStorage,
  SecureStorageUnavailable,
  VaultKey,
  testKeychain,
  type KeychainPort,
} from "../src/main/settings/secure-storage.ts";
import { SettingsStore, apiKeySecret } from "../src/main/settings/store.ts";
import { AudioVault, VaultLockedError } from "../src/main/history/vault.ts";

/** A Keychain whose answers the test controls: answer now, later, never, or deny. */
/** The one Keychain of this simulated Mac: it outlives app restarts, like the real one. */
const macKeychain = testKeychain();

function scriptedKeychain(real: KeychainPort = macKeychain) {
  const k = {
    calls: 0,
    answers: [] as ((ok: boolean) => void)[],
    port: {
      isAvailable: () => {
        k.calls++;
        return new Promise<boolean>((resolve) => k.answers.push(resolve));
      },
      encrypt: (t: string) => real.encrypt(t),
      decrypt: (b: Buffer) => real.decrypt(b),
    } satisfies KeychainPort,
    answer(ok: boolean) {
      for (const a of k.answers.splice(0)) a(ok);
    },
  };
  return k;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const logs: string[] = [];
const log = (e: string) => logs.push(e);

function profile() {
  const dir = mkdtempSync(join(tmpdir(), "murmur-kc-"));
  const k = scriptedKeychain();
  const secure = new SecureStorage(k.port, log);
  let secrets!: KeychainSecrets;
  const store = new SettingsStore(dir, {
    encrypt: () => {
      throw new Error("async only");
    },
    decrypt: (b) => secrets.decryptCached(b),
  });
  secrets = new KeychainSecrets(store, secure, log);
  const key = new VaultKey(dir, secure, log);
  const vault = new AudioVault(join(dir, "audio"), () => key.key);
  return { dir, k, secure, store, secrets, key, vault };
}

test("an unanswered Keychain dialog blocks nothing: state is 'checking' and concurrent requests share one macOS request", async () => {
  const p = profile();
  const all = [
    p.secure.ready(),
    p.secure.ready(),
    p.secrets.unlock(),
    p.key.load(),
  ];
  await tick();
  assert.equal(p.k.calls, 1, "one Keychain request, so at most one dialog");
  assert.equal(p.secure.state, "checking");
  assert.equal(p.key.state, "pending");
  // Late answer (minutes later is the same): applied to every waiter.
  p.k.answer(true);
  const [a, b] = await Promise.all(all.slice(0, 2));
  await Promise.all(all.slice(2));
  assert.deepEqual([a, b], [true, true]);
  assert.equal(p.secure.state, "available");
  assert.equal(p.key.state, "ready");
});

test("denied: saved keys read as 'locked' (never missing, never garbled); nothing is written; a retry after allowing works", async () => {
  const p = profile();
  // A key saved earlier, when the Keychain worked.
  const first = p.secure.ready();
  p.k.answer(true);
  await first;
  await p.secrets.set(apiKeySecret("groq"), "gsk-test-key-1");
  const onDisk = readFileSync(join(p.dir, "secrets.json"), "utf8");
  assert.ok(!onDisk.includes("gsk-test-key-1"), "never stored in plaintext");

  // New start: the Keychain is denied.
  const q = { ...profile(), dir: p.dir };
  const k2 = scriptedKeychain();
  const secure2 = new SecureStorage(k2.port, log);
  let secrets2!: KeychainSecrets;
  const store2 = new SettingsStore(p.dir, {
    encrypt: () => {
      throw new Error("async only");
    },
    decrypt: (b) => secrets2.decryptCached(b),
  });
  secrets2 = new KeychainSecrets(store2, secure2, log);
  void q;
  const unlocking = secrets2.unlock();
  k2.answer(false);
  await unlocking;
  assert.equal(secure2.state, "unavailable");
  assert.equal(secrets2.status(apiKeySecret("groq")), "locked");
  assert.equal(
    store2.getSecret(apiKeySecret("groq")),
    null,
    "not garbled text",
  );
  assert.equal(store2.hasSecret(apiKeySecret("groq")), true, "still saved");
  await assert.rejects(
    secrets2.set(apiKeySecret("openai"), "sk-new"),
    SecureStorageUnavailable,
  );
  assert.equal(
    readFileSync(join(p.dir, "secrets.json"), "utf8"),
    onDisk,
    "nothing written while unavailable",
  );
  assert.equal(k2.calls, 1, "a refused save didn't raise another dialog");
  // The person allows it, then presses Try again.
  const retry = secure2.retry().then(() => secrets2.unlock());
  k2.answer(true);
  await retry;
  assert.equal(store2.getSecret(apiKeySecret("groq")), "gsk-test-key-1");
});

test("recordings: the key is created only on first use, never replaced while locked or unreadable; files are never deleted", async () => {
  const p = profile();
  const loading = p.key.load();
  p.k.answer(true);
  await loading;
  assert.ok(logs.includes("vault.key.created"));
  const keyFile = readFileSync(join(p.dir, "vault.key"));
  await p.vault.save("rec1", new Uint8Array([1, 2, 3]));

  // Restart with the Keychain unavailable: locked; key file and recording untouched.
  const k2 = scriptedKeychain();
  const secure2 = new SecureStorage(k2.port, log);
  const key2 = new VaultKey(p.dir, secure2, log);
  const vault2 = new AudioVault(join(p.dir, "audio"), () => key2.key);
  const l2 = key2.load();
  k2.answer(false);
  await l2;
  assert.equal(key2.state, "locked");
  assert.deepEqual(readFileSync(join(p.dir, "vault.key")), keyFile);
  await assert.rejects(
    vault2.load("rec1"),
    VaultLockedError,
    "locked, not 'missing'",
  );
  await assert.rejects(
    vault2.save("rec2", new Uint8Array([9])),
    VaultLockedError,
  );
  assert.deepEqual(readdirSync(join(p.dir, "audio")), ["rec1.wav.enc"]);

  // Keychain back (Try again): the same key, the old recording opens.
  const l3 = secure2.retry().then(() => key2.load());
  k2.answer(true);
  await l3;
  assert.equal(key2.state, "ready");
  assert.deepEqual([...(await vault2.load("rec1"))!], [1, 2, 3]);

  // A key file the Keychain truly can't decrypt is kept and reported, never replaced.
  writeFileSync(join(p.dir, "vault.key"), "not-a-keychain-blob");
  const k4 = scriptedKeychain();
  const key4 = new VaultKey(p.dir, new SecureStorage(k4.port, log), log);
  const l4 = key4.load();
  k4.answer(true);
  await l4;
  assert.equal(key4.state, "unreadable");
  assert.equal(key4.key, null);
  assert.equal(
    readFileSync(join(p.dir, "vault.key"), "utf8"),
    "not-a-keychain-blob",
  );
  assert.deepEqual(readdirSync(join(p.dir, "audio")), ["rec1.wav.enc"]);
});

test("a restart while a request is pending: the old process's late answer can't touch the new one", async () => {
  const old = profile();
  void old.secure.ready(); // pending, never answered (the process "quit")
  const fresh = new SecureStorage(old.k.port, log);
  const ready = fresh.ready();
  assert.equal(old.k.calls, 2, "the new start asks again");
  old.k.answer(true); // answers both pending requests, in order
  assert.equal(await ready, true);
  assert.equal(fresh.state, "available");
});

test("a failing Keychain call counts as unavailable, and secrets one key can't decrypt stay on disk as 'unreadable'", async () => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-kc-"));
  const broken: KeychainPort = {
    isAvailable: async () => {
      throw new Error("keychain error");
    },
    encrypt: async () => Buffer.alloc(0),
    decrypt: async () => "",
  };
  const s = new SecureStorage(broken, log);
  assert.equal(await s.ready(), false);
  assert.equal(s.state, "unavailable");

  const good = new SecureStorage(testKeychain(), log);
  let secrets!: KeychainSecrets;
  const store = new SettingsStore(dir, {
    encrypt: () => {
      throw new Error("async only");
    },
    decrypt: (b) => secrets.decryptCached(b),
  });
  secrets = new KeychainSecrets(store, good, log);
  store.setEncryptedSecret(
    apiKeySecret("groq"),
    Buffer.from("tk1-but-garbage"),
  );
  await secrets.unlock();
  assert.equal(secrets.status(apiKeySecret("groq")), "unreadable");
  assert.equal(secrets.unreadableCount, 1);
  assert.equal(store.hasSecret(apiKeySecret("groq")), true, "kept");
});

test("a saved key the Keychain hasn't released reads as 'waiting', never as 'not set'", async () => {
  const { HubService } = await import("../src/main/hub/service.ts");
  const dir = mkdtempSync(join(tmpdir(), "murmur-kc-"));
  const store = new SettingsStore(dir, {
    encrypt: () => Buffer.alloc(0),
    decrypt: () => {
      throw new SecureStorageUnavailable();
    },
  });
  store.setEncryptedSecret(apiKeySecret("openai"), Buffer.from("blob"));
  let status: "locked" | "ready" | "unreadable" = "locked";
  const hub = new HubService({
    settings: store,
    env: {},
    secrets: { set: async () => {}, status: () => status },
  } as never);
  assert.match(
    (await hub.provider().readiness()) ?? "",
    /Waiting for Keychain access/,
  );
  status = "unreadable";
  assert.match((await hub.provider().readiness()) ?? "", /can't be read/);
});

test("Settings wording: waiting is never shown as refused; Try again only where it helps; unreadable data is never framed as lost", async () => {
  const { secureStorageText } =
    await import("../src/renderer/hub/model/settings.ts");
  const t = (
    state: "checking" | "available" | "unavailable",
    recordings = "ready",
    unreadableKeys = 0,
  ) =>
    secureStorageText({
      state,
      recordings: recordings as never,
      unreadableKeys,
    });
  assert.deepEqual(
    [t("checking").label, t("checking").retry],
    ["Waiting for the Keychain", false],
  );
  assert.match(t("unavailable", "locked").detail, /kept, unchanged/);
  assert.equal(t("unavailable", "locked").retry, true);
  assert.match(t("available", "unreadable").detail, /kept, not replaced/);
  assert.match(t("available", "ready", 1).detail, /Enter it again/);
  assert.equal(t("available").label, "Protected by the Keychain");
});

test("start a new recording key: only when unreadable and confirmed; the old key and recordings are kept aside, never deleted", async () => {
  const { HistoryDb } = await import("../src/main/history/db.ts");
  const { HubService } = await import("../src/main/hub/service.ts");
  const dir = mkdtempSync(join(tmpdir(), "murmur-newkey-"));
  writeFileSync(join(dir, "vault.key"), "unreadable-old-key-blob");
  const secure = new SecureStorage(macKeychain, log);
  const key = new VaultKey(dir, secure, log);
  await key.load();
  assert.equal(key.state, "unreadable");
  const vault = new AudioVault(join(dir, "audio"), () => key.key);
  // Old recordings on disk (written under the old key) and a History row pointing to one.
  const audioDir = join(dir, "audio");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(audioDir, { recursive: true });
  writeFileSync(join(audioDir, "old1.wav.enc"), "old-recording-1");
  writeFileSync(join(audioDir, "old2.wav.enc"), "old-recording-2");
  const history = new HistoryDb(join(dir, "murmur.sqlite"));
  history.insert({
    id: "old1",
    startedAt: Date.now(),
    durationMs: 2000,
    status: "failed",
    strategy: null,
    rawText: null,
    finalText: null,
    wordCount: 0,
    appName: null,
    appBundleId: null,
    error: "timeout",
    provider: "openai",
    hasAudio: true,
  });
  let stamp = "";
  const hub = new HubService({
    history,
    vault,
    secureStorage: {
      info: () => ({
        state: "available",
        recordings: key.state,
        unreadableKeys: 0,
      }),
      retry: async () => {},
      newRecordingKey: async () => {
        stamp = "2026-10-17T10-00-00-000Z";
        await key.replaceUnreadable(stamp);
        return stamp;
      },
    },
  } as never);

  // Not without the explicit confirmation.
  await assert.rejects(hub.startNewRecordingKey({}));
  assert.equal(key.state, "unreadable");

  const r = await hub.startNewRecordingKey({ confirm: true });
  assert.equal(r.archived, 2);
  // Old key kept byte for byte under another name; a new one in its place.
  assert.equal(
    readFileSync(join(dir, `vault.key.unreadable-${stamp}`), "utf8"),
    "unreadable-old-key-blob",
  );
  assert.notEqual(
    readFileSync(join(dir, "vault.key"), "utf8"),
    "unreadable-old-key-blob",
  );
  assert.equal(key.state, "ready");
  // Old recordings moved aside, not deleted; History no longer offers an impossible retry.
  assert.deepEqual(readdirSync(join(audioDir, `unreadable-${stamp}`)).sort(), [
    "old1.wav.enc",
    "old2.wav.enc",
  ]);
  const row = history.get("old1")!;
  assert.equal(row.hasAudio, false);
  assert.match(row.error ?? "", /previous, unreadable key/);
  // New recordings work again.
  await vault.save("new1", new Uint8Array([7, 8]));
  assert.deepEqual([...(await vault.load("new1"))!], [7, 8]);

  // Never replaces a key that works.
  await assert.rejects(key.replaceUnreadable("again"), /isn't unreadable/);
  history.close();
});

test("start a new recording key: refused while the Keychain is unavailable (nothing changes)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-newkey-"));
  writeFileSync(join(dir, "vault.key"), "unreadable-old-key-blob");
  const k = scriptedKeychain();
  const secure = new SecureStorage(k.port, log);
  const key = new VaultKey(dir, secure, log);
  // Readable Keychain first, so the key is found unreadable…
  const loading = key.load();
  k.answer(true);
  await loading;
  assert.equal(key.state, "unreadable");
  // …then the Keychain becomes unavailable (simulated by a fresh, denied instance).
  const k2 = scriptedKeychain();
  const denied = new SecureStorage(k2.port, log);
  const key2 = new VaultKey(dir, denied, log);
  key2.state = "unreadable";
  const attempt = key2.replaceUnreadable("x");
  k2.answer(false);
  await assert.rejects(attempt, SecureStorageUnavailable);
  assert.equal(
    readFileSync(join(dir, "vault.key"), "utf8"),
    "unreadable-old-key-blob",
  );
});

test("Delete all removes archived 'unreadable-*' recordings too, and nothing else in the folder", async () => {
  const p = profile();
  const loading = p.key.load();
  p.k.answer(true);
  await loading;
  await p.vault.save("rec1", new Uint8Array([1]));
  await p.vault.save("rec2", new Uint8Array([2]));
  assert.equal(await p.vault.archiveAll("unreadable-2026-10-19T10-00-00"), 2);
  await p.vault.save("rec3", new Uint8Array([3]));
  const dir = join(p.dir, "audio");
  writeFileSync(join(dir, "keep.txt"), "not a recording");
  await p.vault.clearAll();
  assert.deepEqual(readdirSync(dir).sort(), ["keep.txt"]);
});
