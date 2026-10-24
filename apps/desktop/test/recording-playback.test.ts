import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryDb } from "../src/main/history/db.ts";
import { HubService, type HubServiceDeps } from "../src/main/hub/service.ts";
import { VaultLockedError } from "../src/main/history/vault.ts";
import type { DictationRecord } from "../src/main/core/types.ts";
import {
  RecordingPlayer,
  clock,
  NOT_WHILE_RECORDING,
  type PlaybackEngine,
  type PlaybackHooks,
} from "../src/renderer/hub/model/player.ts";
import { noRecordingNote } from "../src/renderer/hub/model/history.ts";
import { DictationController } from "../src/main/core/controller.ts";
import { SettingsSchema, parseSettingsPatch } from "../src/shared/settings.ts";
import { controllerConfig } from "../src/main/settings/controller-config.ts";
import {
  FakeAudio,
  FakeCancelHotkey,
  FakeCapsule,
  FakeClock,
  FakeHistory,
  FakeInserter,
  FakeProvider,
  FakeVault,
  fakeTarget,
  flush,
  realHold,
} from "./helpers.ts";

// ---- Player store ----------------------------------------------------------------------------

function rig() {
  const engines: {
    disposed: boolean;
    playing: boolean;
    hooks: PlaybackHooks;
  }[] = [];
  const errors: string[] = [];
  let failLoad: string | null = null;
  const player = new RecordingPlayer({
    load: async (id) => {
      if (failLoad) throw new Error(failLoad);
      return new ArrayBuffer(id.length);
    },
    createEngine: (_bytes, hooks) => {
      const e = { disposed: false, playing: false, hooks };
      engines.push(e);
      const engine: PlaybackEngine = {
        play: async () => void (e.playing = true),
        pause: () => void (e.playing = false),
        dispose: () => {
          e.disposed = true;
          e.playing = false;
        },
      };
      return engine;
    },
    onError: (m) => errors.push(m),
  });
  return {
    player,
    engines,
    errors,
    failLoadWith: (m: string | null) => (failLoad = m),
  };
}

test("player: play, pause, resume and end release the recording", async () => {
  const { player, engines } = rig();
  await player.toggle("a");
  assert.equal(player.getState().phase, "playing");
  engines[0].hooks.time(2500, 9000);
  assert.equal(player.getState().positionMs, 2500);
  await player.toggle("a");
  assert.equal(player.getState().phase, "paused");
  assert.equal(engines[0].playing, false);
  await player.toggle("a");
  assert.equal(player.getState().phase, "playing");
  assert.equal(engines.length, 1, "resume reuses the same bytes");
  engines[0].hooks.ended();
  assert.equal(player.getState().id, null);
  assert.equal(engines[0].disposed, true, "URL revoked and bytes dropped");
});

test("player: only one recording plays at a time", async () => {
  const { player, engines } = rig();
  await player.toggle("a");
  await player.toggle("bb");
  assert.equal(engines[0].disposed, true);
  assert.equal(player.getState().id, "bb");
  assert.equal(player.getState().phase, "playing");
  // A late event from the first one changes nothing.
  engines[0].hooks.time(999, 1000);
  engines[0].hooks.ended();
  assert.equal(player.getState().id, "bb");
  assert.equal(player.getState().positionMs, 0);
});

test("player: opening the microphone stops playback, and playing is refused while it is open", async () => {
  const { player, engines, errors } = rig();
  await player.toggle("a");
  player.setMicOpen(true);
  assert.equal(engines[0].disposed, true);
  assert.equal(player.getState().phase, "idle");
  await player.toggle("a");
  assert.equal(engines.length, 1, "nothing started");
  assert.deepEqual(errors, [NOT_WHILE_RECORDING]);
  player.setMicOpen(false);
  await player.toggle("a");
  assert.equal(player.getState().phase, "playing");
});

test("player: the microphone opening during a load discards the recording", async () => {
  const { player, engines } = rig();
  const started = player.toggle("a");
  player.setMicOpen(true);
  await started;
  assert.equal(engines.length, 0);
  assert.equal(player.getState().phase, "idle");
});

test("player: a failed load tells the person and leaves nothing behind", async () => {
  const { player, errors, failLoadWith } = rig();
  failLoadWith("The recording is no longer stored.");
  await player.toggle("a");
  assert.deepEqual(errors, ["The recording is no longer stored."]);
  assert.equal(player.getState().phase, "idle");
});

test("player: a playback error disposes and reports", async () => {
  const { player, engines, errors } = rig();
  await player.toggle("a");
  engines[0].hooks.failed();
  assert.equal(engines[0].disposed, true);
  assert.equal(errors.length, 1);
  assert.equal(player.getState().id, null);
});

test("player: release stops only the owner, and notifies subscribers", async () => {
  const { player, engines } = rig();
  let notified = 0;
  player.subscribe(() => notified++);
  await player.toggle("a");
  player.release("other");
  assert.equal(player.getState().id, "a");
  player.release("a");
  assert.equal(engines[0].disposed, true);
  assert.equal(player.getState().phase, "idle");
  assert.ok(notified >= 3);
});

test("clock formats whole seconds", () => {
  assert.equal(clock(0), "0:00");
  assert.equal(clock(7999), "0:07");
  assert.equal(clock(65_000), "1:05");
});

// ---- Why there is no recording ----------------------------------------------------------------

test("noRecordingNote explains from known fields only", () => {
  const DAY = 86_400_000;
  const now = 100 * DAY;
  const base = { status: "failed" as const, error: null, startedAt: now - DAY };
  assert.equal(
    noRecordingNote({ ...base, error: "secure-field" }, 7, now),
    "Not kept for password fields",
  );
  assert.match(
    noRecordingNote({ ...base, status: "inserted" }, 7, now),
    /Deleted once the text was inserted/,
  );
  assert.match(
    noRecordingNote({ ...base, startedAt: now - 8 * DAY }, 7, now),
    /^Recording deleted after 7 days \(Settings → Data and Privacy\)$/,
  );
  assert.match(
    noRecordingNote({ ...base, startedAt: now - 8 * DAY }, 1, now),
    /after 1 day /,
  );
  assert.match(noRecordingNote(base, 0, now), /deleted right away/);
  assert.equal(noRecordingNote(base, 7, now), "Recording wasn't saved");
  assert.match(
    noRecordingNote(
      { ...base, error: "recording kept under the previous, unreadable key" },
      7,
      now,
    ),
    /previous, unreadable/,
  );
  assert.match(
    noRecordingNote({ ...base, status: "inserted" }, 7, now),
    /Turn on Keep recordings in Settings → Data and Privacy to play future dictations/,
  );
});

// ---- Keep recordings ---------------------------------------------------------------------------

test("keepRecordings is off by default, patchable, and reaches the controller config", () => {
  const defaults = SettingsSchema.parse({});
  assert.equal(defaults.history.keepRecordings, false);
  assert.equal(controllerConfig(defaults).keepRecordings, false);
  const patch = parseSettingsPatch({ history: { keepRecordings: true } });
  assert.deepEqual(patch.history, { keepRecordings: true });
});

async function dictate(keep: boolean, secure: boolean) {
  const clock = new FakeClock();
  const history = new FakeHistory();
  const vault = new FakeVault();
  const inserter = new FakeInserter();
  if (secure)
    inserter.outcome = { strategy: "rejected", reason: "secure-field" };
  const controller = new DictationController(
    {
      hold: realHold(),
      audio: new FakeAudio(),
      target: fakeTarget(),
      inserter,
      capsule: new FakeCapsule(),
      cancelHotkey: new FakeCancelHotkey(),
      history,
      vault,
      provider: () => new FakeProvider(),
      clock,
      newId: () => "d1",
      log: () => {},
    },
    { resultDisplayMs: 500, keepRecordings: keep },
  );
  controller.hotkey("down");
  await flush();
  await clock.advance(1500);
  controller.hotkey("up");
  await flush();
  await clock.advance(50);
  await flush();
  return { vault, history };
}

test("an inserted dictation keeps its recording only when Keep recordings is on", async () => {
  const off = await dictate(false, false);
  assert.equal(off.history.only.status, "inserted");
  assert.equal(off.vault.files.has("d1"), false);
  assert.equal(off.history.only.hasAudio, false);
  const on = await dictate(true, false);
  assert.equal(on.history.only.status, "inserted");
  assert.equal(on.vault.files.has("d1"), true);
  assert.equal(on.history.only.hasAudio, true);
});

test("a password-field dictation is never kept, even with Keep recordings on", async () => {
  const s = await dictate(true, true);
  assert.equal(s.vault.files.has("d1"), false);
  assert.equal(s.history.only.hasAudio, false);
});

test("turning Keep recordings on while retention is 0 sets 7 days; otherwise retention is untouched", () => {
  const settingsRig = (days: number) => {
    let current = SettingsSchema.parse({
      history: { audioRetentionDays: days },
    });
    const hub = new HubService({
      settings: {
        get: () => current,
        update: (p: { history?: object }) =>
          (current = SettingsSchema.parse({
            ...current,
            history: { ...current.history, ...p.history },
          })),
      },
      hotkeys: { current: { combo: "ctrl+opt+space" } },
      controller: { configure() {} },
    } as unknown as HubServiceDeps);
    return { hub, get: () => current };
  };
  const zero = settingsRig(0);
  zero.hub.updateSettings({ history: { keepRecordings: true } });
  assert.equal(zero.get().history.audioRetentionDays, 7);
  const thirty = settingsRig(30);
  thirty.hub.updateSettings({ history: { keepRecordings: true } });
  assert.equal(thirty.get().history.audioRetentionDays, 30);
});

// ---- Main: the IPC handler ---------------------------------------------------------------------

const record = (id: string, extra: Partial<DictationRecord> = {}) =>
  ({
    id,
    startedAt: Date.now(),
    durationMs: 1000,
    status: "failed",
    strategy: null,
    rawText: null,
    finalText: null,
    wordCount: 0,
    appName: null,
    appBundleId: null,
    error: "HTTP 503",
    provider: "fake",
    hasAudio: true,
    ...extra,
  }) satisfies DictationRecord;

function audioService(vaultOverride?: Partial<FakeVault>) {
  const db = new HistoryDb(
    join(mkdtempSync(join(tmpdir(), "murmur-play-")), "db.sqlite"),
  );
  const vault = Object.assign(new FakeVault(), vaultOverride);
  const state = { phase: "idle", meeting: false };
  const logs: [string, unknown][] = [];
  const hub = new HubService({
    history: db,
    vault,
    controller: {
      get currentPhase() {
        return state.phase;
      },
    },
    meetings: { recordingActive: () => state.meeting },
    log: (e: string, d: unknown) => logs.push([e, d]),
  } as unknown as HubServiceDeps);
  return { db, vault, hub, state, logs };
}

test("dictationAudio returns the stored WAV bytes and logs only a size", async () => {
  const { db, vault, hub, logs } = audioService();
  db.insert(record("ok"));
  await vault.save("ok", new Uint8Array([82, 73, 70, 70, 1, 2]));
  const bytes = await hub.dictationAudio({ id: "ok" });
  assert.ok(bytes instanceof ArrayBuffer);
  assert.deepEqual([...new Uint8Array(bytes)], [82, 73, 70, 70, 1, 2]);
  assert.deepEqual(logs, [["history.audio.played", { bytes: 6 }]]);
  db.close();
});

test("dictationAudio refuses unknown rows, rows without audio and password-field rows", async () => {
  const { db, vault, hub } = audioService();
  db.insert(record("none", { hasAudio: false }));
  db.insert(record("pw", { error: "secure-field" }));
  await vault.save("pw", new Uint8Array([1]));
  await assert.rejects(
    hub.dictationAudio({ id: "gone" }),
    /no longer in History/,
  );
  await assert.rejects(
    hub.dictationAudio({ id: "none" }),
    /no stored recording/,
  );
  await assert.rejects(hub.dictationAudio({ id: "pw" }), /password fields/);
  db.close();
});

test("dictationAudio: a locked vault is an error, and a missing file clears hasAudio", async () => {
  const { db, hub, vault } = audioService({
    load: async () => {
      throw new VaultLockedError();
    },
  } as Partial<FakeVault>);
  db.insert(record("locked"));
  await assert.rejects(hub.dictationAudio({ id: "locked" }), /Keychain/);
  assert.equal(db.get("locked")?.hasAudio, true, "locked changes nothing");

  const missing = audioService();
  missing.db.insert(record("m"));
  await assert.rejects(
    missing.hub.dictationAudio({ id: "m" }),
    /no longer stored/,
  );
  assert.equal(missing.db.get("m")?.hasAudio, false);
  void vault;
  db.close();
  missing.db.close();
});

test("dictationAudio is refused while the microphone is open", async () => {
  const { db, vault, hub, state } = audioService();
  db.insert(record("r"));
  await vault.save("r", new Uint8Array([1]));
  state.phase = "recording";
  await assert.rejects(hub.dictationAudio({ id: "r" }), /Not while recording/);
  state.phase = "idle";
  state.meeting = true;
  await assert.rejects(hub.dictationAudio({ id: "r" }), /Not while recording/);
  db.close();
});
