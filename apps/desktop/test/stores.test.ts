import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { HistoryDb } from "../src/main/history/db.ts";
import { AudioVault } from "../src/main/history/vault.ts";
import {
  SettingsStore,
  apiKeySecret,
  plainCodec,
} from "../src/main/settings/store.ts";
import { DEFAULT_SETTINGS } from "../src/shared/settings.ts";
import type { DictationRecord } from "../src/main/core/types.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "murmur-test-"));

const row = (
  id: string,
  extra: Partial<DictationRecord> = {},
): DictationRecord => ({
  id,
  startedAt: 1000,
  durationMs: 1500,
  status: "transcribing",
  strategy: null,
  rawText: null,
  finalText: null,
  wordCount: 0,
  appName: "TextEdit",
  appBundleId: "com.apple.TextEdit",
  error: null,
  provider: "fake",
  hasAudio: false,
  ...extra,
});

test("history db migrates, inserts, updates, lists newest first, deletes", () => {
  const db = new HistoryDb(join(tmp(), "h.sqlite"));
  assert.equal(db.schemaVersion, 8);
  db.insert(row("a", { startedAt: 1 }));
  db.insert(row("b", { startedAt: 2 }));
  db.update("a", {
    status: "inserted",
    finalText: "Hello.",
    wordCount: 1,
    hasAudio: true,
  });
  assert.equal(db.get("a")?.status, "inserted");
  assert.equal(db.get("a")?.hasAudio, true);
  assert.deepEqual(
    db.list().map((r) => r.id),
    ["b", "a"],
  );
  assert.deepEqual(db.audioOlderThan(0, 10), ["a"]);
  assert.equal(db.delete("b"), true);
  assert.equal(db.delete("b"), false);
  db.update("a", {});
  db.clear();
  assert.equal(db.list().length, 0);
  db.close();
});

test("history db reopens an existing file without re-running migrations", () => {
  const path = join(tmp(), "h.sqlite");
  const db1 = new HistoryDb(path);
  db1.insert(row("a"));
  db1.close();
  const db2 = new HistoryDb(path);
  assert.equal(db2.get("a")?.id, "a");
  assert.equal(db2.schemaVersion, 8);
  db2.close();
});

test("audio vault encrypts at rest, round-trips, and refuses other keys", async () => {
  const dir = join(tmp(), "audio");
  const key = randomBytes(32);
  const vault = new AudioVault(dir, key);
  const wav = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4, 5]);
  await vault.save("abc", wav);
  const raw = readFileSync(join(dir, "abc.wav.enc"));
  assert.equal(
    raw.includes(Buffer.from([82, 73, 70, 70])),
    false,
    "plaintext header not on disk",
  );
  assert.deepEqual([...(await vault.load("abc"))!], [...wav]);
  assert.equal(await vault.load("missing"), null);
  await assert.rejects(new AudioVault(dir, randomBytes(32)).load("abc"));
  await vault.remove("abc");
  assert.equal(await vault.load("abc"), null);
  await assert.rejects(vault.save("../escape", wav), /invalid id/);
});

test("settings store validates, persists atomically, and survives corrupt files", () => {
  const dir = tmp();
  const store = new SettingsStore(dir, plainCodec);
  assert.deepEqual(store.get(), DEFAULT_SETTINGS);
  const updated = store.update({
    shortcut: "ctrl+opt+k",
    speech: { provider: "groq" },
  });
  assert.equal(updated.shortcut, "ctrl+opt+k");
  assert.equal(updated.speech.provider, "groq");
  assert.equal(
    updated.speech.timeoutMs,
    30000,
    "untouched nested defaults survive",
  );
  assert.throws(() => store.update({ speech: { provider: "nope" } }));
  assert.throws(
    () => store.update({ privacy: { cloudHistory: true } }),
    "privacy decisions cannot be flipped",
  );
  const reopened = new SettingsStore(dir, plainCodec);
  assert.equal(reopened.get().shortcut, "ctrl+opt+k");
  writeFileSync(join(dir, "settings.json"), "{not json");
  assert.deepEqual(new SettingsStore(dir, plainCodec).get(), DEFAULT_SETTINGS);
});

test("a partial settings update never resets fields it did not mention", () => {
  // Regression: Zod 4 fills .default() values inside .partial(), so a patch such as
  // { dictionary: { enabled: false } } used to reset onboarding, the shortcut, appearance
  // and sibling options to their defaults.
  const store = new SettingsStore(tmp(), plainCodec);
  store.update({
    onboardingCompleted: true,
    shortcut: "ctrl+opt+f12",
    appearance: "dark",
    capsule: "whileActive",
    dictionary: { useAsVocabulary: false },
    history: { audioRetentionDays: 30 },
    speech: { provider: "groq", timeoutMs: 45000 },
  });
  for (const patch of [
    { dictionary: { enabled: false } },
    { snippets: { enabled: false } },
    { appearance: "light" },
    { history: { historyRetentionDays: 7 } },
    { cleanup: { mode: "off" } },
  ]) {
    const s = store.update(patch);
    assert.equal(s.onboardingCompleted, true, JSON.stringify(patch));
    assert.equal(s.shortcut, "ctrl+opt+f12");
    assert.equal(s.capsule, "whileActive");
    assert.equal(s.dictionary.useAsVocabulary, false);
    assert.equal(s.history.audioRetentionDays, 30);
    assert.equal(s.speech.provider, "groq");
    assert.equal(s.speech.timeoutMs, 45000);
  }
  const s = store.get();
  assert.equal(s.appearance, "light");
  assert.equal(s.dictionary.enabled, false);
  assert.equal(s.snippets.enabled, false);
  assert.equal(s.history.historyRetentionDays, 7);
  assert.equal(s.cleanup.mode, "off");
});

test("secrets are stored through the codec and never inside settings.json", () => {
  const dir = tmp();
  const codec = {
    encrypt: (s: string) => Buffer.from(`enc:${s}`),
    decrypt: (b: Buffer) => b.toString().replace(/^enc:/, ""),
  };
  const store = new SettingsStore(dir, codec);
  store.setSecret(apiKeySecret("openai"), "sk-test-123");
  assert.equal(store.hasSecret(apiKeySecret("openai")), true);
  assert.equal(store.getSecret(apiKeySecret("openai")), "sk-test-123");
  assert.equal(
    readFileSync(join(dir, "secrets.json"), "utf8").includes("sk-test-123"),
    false,
  );
  assert.equal(
    existsSync(join(dir, "settings.json")) &&
      readFileSync(join(dir, "settings.json"), "utf8").includes("sk-"),
    false,
  );
  store.setSecret(apiKeySecret("openai"), "");
  assert.equal(store.hasSecret(apiKeySecret("openai")), false);
});

test("M1 settings files (cleanup as a string) migrate into the M2 cleanup object", () => {
  const dir = tmp();
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      version: 1,
      cleanup: "light",
      speech: { provider: "groq" },
    }),
  );
  const s = new SettingsStore(dir, plainCodec).get();
  assert.deepEqual(s.cleanup, {
    mode: "deterministic",
    aiProvider: "groq",
    aiModel: "",
    aiTimeoutMs: 4000,
  });
  assert.equal(s.speech.provider, "groq");
  assert.equal(s.dictionary.useAsVocabulary, true);
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ cleanup: "off" }));
  assert.equal(new SettingsStore(dir, plainCodec).get().cleanup.mode, "off");
  const store = new SettingsStore(dir, plainCodec);
  const updated = store.update({
    cleanup: { mode: "ai", aiProvider: "anthropic" },
    history: { historyRetentionDays: 30 },
  });
  assert.equal(updated.cleanup.mode, "ai");
  assert.equal(
    updated.cleanup.aiTimeoutMs,
    4000,
    "untouched nested defaults survive",
  );
  assert.equal(updated.history.historyRetentionDays, 30);
  assert.throws(() => store.update({ cleanup: { mode: "magic" } }));
});

test("Stage 6A system settings: defaults for older files, patched without touching anything else", () => {
  const dir = tmp();
  // A settings file written before these settings existed.
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      ...DEFAULT_SETTINGS,
      system: undefined,
      shortcut: "ctrl+opt+k",
    }),
  );
  const store = new SettingsStore(dir, plainCodec);
  const off = { showInDock: false, sounds: false, muteWhileDictating: false };
  assert.deepEqual(store.get().system, off);
  assert.equal(store.get().shortcut, "ctrl+opt+k");
  store.update({ system: { sounds: true } });
  assert.deepEqual(store.get().system, { ...off, sounds: true });
  assert.deepEqual(new SettingsStore(dir, plainCodec).get().system, {
    ...off,
    sounds: true,
  });
  assert.throws(() => store.update({ system: { sounds: "yes" } }));
});

test("a partial System change keeps the other System setting (Dock stays on when sounds change)", () => {
  const store = new SettingsStore(
    mkdtempSync(join(tmpdir(), "murmur-system-")),
    plainCodec,
  );
  store.update({ system: { showInDock: true } });
  store.update({ system: { sounds: true } });
  assert.deepEqual(store.get().system, {
    showInDock: true,
    sounds: true,
    muteWhileDictating: false,
  });
});

test("one invalid value in settings.json keeps every other setting; the original is backed up once", () => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-badsettings-"));
  const file = join(dir, "settings.json");
  const original = JSON.stringify({
    shortcut: "ctrl+opt+k",
    appearance: "dark",
    speech: { provider: "groq", timeoutMs: "slow" },
    notetaker: { summaryConsent: ["groq", "nope"] },
    capsule: "whileActive",
  });
  writeFileSync(file, original);
  const logs: { event: string; data?: Record<string, unknown> }[] = [];
  const store = new SettingsStore(dir, plainCodec, (event, data) =>
    logs.push({ event, data }),
  );
  const s = store.get();
  assert.equal(s.shortcut, "ctrl+opt+k");
  assert.equal(s.appearance, "dark");
  assert.equal(s.capsule, "whileActive");
  assert.equal(
    s.speech.provider,
    "groq",
    "valid siblings in the same group stay",
  );
  assert.equal(s.speech.timeoutMs, DEFAULT_SETTINGS.speech.timeoutMs);
  assert.deepEqual(s.notetaker.summaryConsent, []);
  assert.deepEqual(logs, [
    {
      event: "settings.recovered",
      data: { failed: ["speech.timeoutMs", "notetaker.summaryConsent"] },
    },
  ]);
  assert.equal(readFileSync(`${file}.bad`, "utf8"), original);
  store.update({ appearance: "light" });
  new SettingsStore(dir, plainCodec);
  assert.equal(
    readFileSync(`${file}.bad`, "utf8"),
    original,
    "the backup is never overwritten",
  );
});

test("an unreadable secrets.json is never replaced by a save", () => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-badsecrets-"));
  const file = join(dir, "secrets.json");
  writeFileSync(file, '{"apiKey:groq": "AAAA"');
  const store = new SettingsStore(dir, plainCodec);
  assert.equal(store.getSecret("apiKey:groq"), null);
  assert.throws(
    () => store.setSecret("apiKey:openai", "sk-x"),
    /couldn't be read/,
  );
  assert.throws(
    () => store.setEncryptedSecret("a", Buffer.from("x")),
    /couldn't be read/,
  );
  assert.throws(() => store.setSecret("apiKey:groq", ""));
  assert.equal(readFileSync(file, "utf8"), '{"apiKey:groq": "AAAA"');
  const fresh = new SettingsStore(
    mkdtempSync(join(tmpdir(), "murmur-nosecrets-")),
    plainCodec,
  );
  fresh.setSecret("apiKey:groq", "k");
  assert.equal(fresh.getSecret("apiKey:groq"), "k");
});
