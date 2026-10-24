// Stage 9D-2: meeting recording. The recorder (start only on request, mixing, 30-second encrypted
// parts, pause, the length limit, failures), transcription (batches, silence never sent, the
// audio deleted once the transcript is saved, failures keep it), recovery after a crash (never
// resumes recording), summaries, the dictation block while recording, and the Capsule indicator.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderError } from "@murmur/speech";
import { HistoryDb, MeetingRepo } from "../src/main/history/db.ts";
import {
  MeetingRecorder,
  mixPcm,
  PART_SAMPLES,
  SAMPLE_RATE,
  type RecorderDeps,
} from "../src/main/notetaker/recorder.ts";
import {
  NativeSystemAudioSource,
  RendererMeetingMic,
  VaultAudioParts,
} from "../src/main/notetaker/sources.ts";
import { AudioVault } from "../src/main/history/vault.ts";
import type { AudioRendererMessage } from "../src/main/audio/capture.ts";
import {
  CHUNK_MAX_BYTES,
  parseAudioMessage,
} from "../src/main/audio/message.ts";
import { readdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  NotetakerService,
  PARTS_PER_BATCH,
  peakWindowRms,
} from "../src/main/notetaker/service.ts";
import {
  formatClock,
  meetingMarkdown,
  systemAudioReason,
  type RecordingState,
} from "../src/shared/meetings.ts";
import { present } from "../src/renderer/capsule/model.ts";
import { mergeSpeakers, segmentsOf } from "../src/main/notetaker/speakers.ts";
import { DictationController } from "../src/main/core/controller.ts";
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

const SECOND = SAMPLE_RATE;
const tone = (samples: number, amp = 8000) => {
  const a = new Int16Array(samples);
  for (let i = 0; i < samples; i++) a[i] = Math.round(Math.sin(i / 5) * amp);
  return a;
};

class FakeMic {
  starts = 0;
  stops = 0;
  failWith: Error | null = null;
  private chunk: ((pcm: Int16Array) => void) | null = null;
  private ended: (() => void) | null = null;
  async start(onChunk: (pcm: Int16Array) => void, onEnded: () => void) {
    if (this.failWith) throw this.failWith;
    this.starts++;
    this.chunk = onChunk;
    this.ended = onEnded;
  }
  async stop() {
    this.stops++;
    this.chunk = null;
  }
  get open() {
    return this.chunk !== null;
  }
  send(pcm: Int16Array) {
    this.chunk?.(pcm);
  }
  lose() {
    this.ended?.();
  }
}

class FakeSystem {
  lostReason?: () => string | null;
  droppedBlocks?: () => number;
  supportValue = "available";
  startError: Error | null = null;
  starts = 0;
  stops = 0;
  queued: Int16Array[] = [];
  live = false;
  support() {
    return this.supportValue;
  }
  async start() {
    if (this.startError) throw this.startError;
    this.starts++;
    this.live = true;
  }
  read() {
    const out = this.queued.shift() ?? new Int16Array(0);
    return out;
  }
  stop() {
    this.stops++;
    this.live = false;
  }
}

class MemoryParts {
  files = new Map<string, Int16Array>();
  failSave: Error | null = null;
  removed: string[] = [];
  static key(id: string, index: number, track = "mixed") {
    return track === "mixed" ? `${id}_${index}` : `${id}_${index}_${track}`;
  }
  async save(id: string, index: number, pcm: Int16Array, track = "mixed") {
    if (this.failSave) throw this.failSave;
    this.files.set(MemoryParts.key(id, index, track), pcm);
  }
  async load(id: string, index: number, track = "mixed") {
    return this.files.get(MemoryParts.key(id, index, track)) ?? null;
  }
  async removeMeeting(id: string, parts: number) {
    for (let i = 0; i < parts; i++)
      for (const t of ["mixed", "mic", "system"]) {
        const k = MemoryParts.key(id, i, t);
        if (this.files.delete(k)) this.removed.push(k);
      }
  }
  async clearAll() {
    this.files.clear();
  }
  async archiveAll() {
    const n = this.files.size;
    this.files.clear();
    return n;
  }
}

function setup(
  opts: {
    systemAudio?: boolean;
    maxMinutes?: number;
    speakerLabels?: boolean;
  } = {},
) {
  const db = new HistoryDb(
    join(mkdtempSync(join(tmpdir(), "murmur-9d2-")), "h.sqlite"),
  );
  const meetings = new MeetingRepo(db.db);
  const mic = new FakeMic();
  const system = new FakeSystem();
  const parts = new MemoryParts();
  const states: RecordingState[] = [];
  const recorded: string[] = [];
  const logs: { event: string; data?: Record<string, unknown> }[] = [];
  let now = 1_000_000;
  let blocked: string | null = null;
  const ticks: (() => void)[] = [];
  const options = {
    systemAudio: opts.systemAudio ?? true,
    maxMinutes: opts.maxMinutes ?? 120,
    speakerLabels: opts.speakerLabels ?? false,
  };
  const deps: RecorderDeps = {
    mic,
    system,
    parts,
    meetings,
    options: () => options,
    blocked: () => blocked,
    onState: (s) => states.push(s),
    onRecorded: (id) => recorded.push(id),
    log: (event, data) => logs.push({ event, data }),
    clock: {
      now: () => now,
      every: (_ms, fn) => {
        ticks.push(fn);
        return () => ticks.splice(ticks.indexOf(fn), 1);
      },
    },
  };
  const recorder = new MeetingRecorder(deps);
  const meeting = (id = "m1") =>
    meetings.create({ id, title: "Weekly sync", startedAt: null }, 1);
  /** `seconds` of audio from both sources, then a tick. */
  const feed = (seconds: number, sys = true) => {
    for (let i = 0; i < seconds; i++) {
      mic.send(tone(SECOND));
      if (sys && system.live) system.queued.push(tone(SECOND, 4000));
      now += 1000;
      for (const t of [...ticks]) t();
    }
  };
  return {
    db,
    meetings,
    mic,
    system,
    parts,
    states,
    recorded,
    logs,
    recorder,
    meeting,
    feed,
    options,
    tick: () => [...ticks].forEach((t) => t()),
    setBlocked: (b: string | null) => (blocked = b),
  };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await flush();
};

// ---- Recorder -------------------------------------------------------------------------------------

test("nothing opens until Start: creating the recorder records nothing", () => {
  const s = setup();
  s.meeting();
  assert.equal(s.mic.starts, 0);
  assert.equal(s.system.starts, 0);
  assert.equal(s.recorder.state.phase, "idle");
});

test("start is refused for an unknown or already-recorded meeting, during a dictation, or while another records", async () => {
  const s = setup();
  await assert.rejects(s.recorder.start("nope"), /no longer exists/);
  s.meeting("m1");
  s.meeting("m2");
  s.setBlocked("Finish the dictation first, then start recording.");
  await assert.rejects(s.recorder.start("m1"), /Finish the dictation/);
  assert.equal(s.mic.starts, 0);
  s.setBlocked(null);
  await s.recorder.start("m1");
  await assert.rejects(s.recorder.start("m2"), /already being recorded/);
  await s.recorder.stop();
  await settle();
  // m1 was never fed audio, so it is unrecorded again; record it, then try a second time.
  await s.recorder.start("m1");
  s.feed(2);
  await s.recorder.stop();
  await settle();
  await assert.rejects(s.recorder.start("m1"), /already has a recording/);
});

test("records the microphone and your Mac's sound mixed, in 30-second encrypted parts", async () => {
  const s = setup();
  s.meeting();
  await s.recorder.start("m1");
  assert.equal(s.recorder.state.phase, "recording");
  assert.deepEqual(s.recorder.state.systemAudio, { state: "on" });
  assert.equal(s.meetings.get("m1")?.status, "recording");
  assert.equal(s.meetings.get("m1")?.systemAudio, true);
  s.feed(31);
  await settle();
  assert.equal(s.parts.files.size, 1, "a part is saved after 30 s");
  assert.equal(s.parts.files.get("m1_0")!.length, PART_SAMPLES);
  assert.equal(
    s.meetings.get("m1")?.audioParts,
    1,
    "progress is saved as it goes",
  );
  await s.recorder.stop();
  await settle();
  const m = s.meetings.get("m1")!;
  assert.equal(m.status, "processing");
  assert.equal(m.recordedMs, 31_000);
  assert.equal(m.audioParts, 2, "the last second is saved as its own part");
  assert.equal(s.parts.files.get("m1_1")!.length, SECOND);
  assert.deepEqual(s.recorded, ["m1"], "handed on for transcription");
  assert.equal(s.mic.open, false, "microphone closed");
  assert.equal(s.system.live, false, "system audio closed");
  assert.equal(s.recorder.state.phase, "idle");
});

test("mixing adds both sources and clips; a stalled source is filled with silence", async () => {
  const mixed = mixPcm(
    Int16Array.from([1000, 30000, -30000]),
    Int16Array.from([2000, 10000, -10000]),
  );
  assert.deepEqual([...mixed], [3000, 32767, -32768]);
  const s = setup();
  s.meeting();
  await s.recorder.start("m1");
  // The tap delivers nothing for 3 s; the microphone keeps going.
  for (let i = 0; i < 3; i++) {
    s.mic.send(tone(SECOND));
    s.tick();
  }
  assert.ok(s.recorder.state.elapsedMs >= 2000, "the recording isn't held up");
  await s.recorder.stop();
  await settle();
  assert.equal(s.meetings.get("m1")?.recordedMs, 3000);
});

test("system audio off, unsupported, or refused: the microphone still records, and the state says why", async () => {
  for (const [setupFn, expected] of [
    [
      (s: ReturnType<typeof setup>) => (s.options.systemAudio = false),
      { state: "off" },
    ],
    [
      (s: ReturnType<typeof setup>) =>
        (s.system.supportValue = "missing-usage-description"),
      {
        state: "unavailable",
        reason: systemAudioReason("missing-usage-description"),
      },
    ],
    [
      (s: ReturnType<typeof setup>) =>
        (s.system.startError = new Error(
          "Couldn't start system audio (Core Audio -1).",
        )),
      {
        state: "unavailable",
        reason: "Couldn't start system audio (Core Audio -1).",
      },
    ],
  ] as const) {
    const s = setup();
    setupFn(s);
    s.meeting();
    await s.recorder.start("m1");
    assert.deepEqual(s.recorder.state.systemAudio, expected);
    s.feed(2);
    await s.recorder.stop();
    await settle();
    const m = s.meetings.get("m1")!;
    assert.equal(m.status, "processing");
    assert.equal(m.systemAudio, false);
    assert.equal(m.recordedMs, 2000);
  }
});

test("pause closes the microphone and the tap; nothing is recorded while paused; resume reopens", async () => {
  const s = setup();
  s.meeting();
  await s.recorder.start("m1");
  s.feed(5);
  await s.recorder.pause();
  assert.equal(s.recorder.state.phase, "paused");
  assert.equal(s.mic.open, false);
  assert.equal(s.system.live, false);
  assert.equal(s.recorder.state.micLevel, 0);
  s.tick();
  s.tick();
  assert.equal(s.recorder.state.elapsedMs, 5000);
  await s.recorder.resume();
  assert.equal(s.mic.starts, 2);
  assert.equal(s.system.starts, 2);
  s.feed(3);
  await s.recorder.stop();
  await settle();
  assert.equal(
    s.meetings.get("m1")?.recordedMs,
    8000,
    "paused time isn't counted",
  );
});

test("the maximum length warns a minute before, then stops exactly at the limit", async () => {
  const s = setup({ maxMinutes: 30 });
  s.meeting();
  await s.recorder.start("m1");
  s.feed(29 * 60 - 1);
  assert.equal(s.recorder.state.warning, null);
  s.feed(2);
  assert.match(s.recorder.state.warning ?? "", /Stopping in 1 minute/);
  s.feed(65);
  await settle();
  const m = s.meetings.get("m1")!;
  assert.equal(m.status, "processing");
  assert.equal(m.recordedMs, 30 * 60_000, "never past the limit");
  assert.equal(m.audioParts, 60);
  assert.equal(s.recorder.state.phase, "idle");
  assert.equal(
    s.logs.find((l) => l.event === "meeting.recording.stopped")?.data?.reason,
    "limit",
  );
});

test("stopping before any audio leaves the meeting unrecorded", async () => {
  const s = setup();
  s.meeting();
  await s.recorder.start("m1");
  await s.recorder.stop();
  await settle();
  assert.equal(s.meetings.get("m1")?.status, "notes");
  assert.deepEqual(s.recorded, []);
});

test("a lost microphone stops the recording and keeps what was recorded", async () => {
  const s = setup();
  s.meeting();
  await s.recorder.start("m1");
  s.feed(4);
  s.mic.lose();
  await settle();
  assert.equal(s.meetings.get("m1")?.status, "processing");
  assert.equal(
    s.logs.find((l) => l.event === "meeting.recording.stopped")?.data?.reason,
    "mic-lost",
  );
});

test("a part that can't be saved stops the recording and the meeting says why", async () => {
  const s = setup();
  s.meeting();
  await s.recorder.start("m1");
  s.parts.failSave = new Error(
    "Recordings can't be opened until the Keychain allows Murmur to read its key.",
  );
  s.feed(31);
  await settle();
  await settle();
  const m = s.meetings.get("m1")!;
  assert.equal(m.status, "failed");
  assert.match(m.error ?? "", /couldn't be saved.*Keychain/);
  assert.deepEqual(s.recorded, []);
  assert.equal(s.mic.open, false);
});

test("a microphone that won't open leaves nothing recording", async () => {
  const s = setup();
  s.meeting();
  s.mic.failWith = new Error("Microphone access is off");
  await assert.rejects(s.recorder.start("m1"), /Microphone access is off/);
  assert.equal(s.recorder.state.phase, "idle");
  assert.equal(s.system.live, false, "the tap is closed again");
  assert.equal(s.meetings.get("m1")?.status, "notes");
});

// ---- Service: transcription, recovery, summaries ---------------------------------------------------

function service(over: { ready?: string | null } = {}) {
  const s = setup();
  const provider = new FakeProvider();
  provider.text = "We agreed to ship on Friday.";
  const progress: { done: number; total: number }[] = [];
  const summaries: { requestId: string; text: string }[] = [];
  let summaryReply = "## Summary\nShip on Friday.";
  const logs: { event: string; data?: Record<string, unknown> }[] = [];
  let n = 0;
  const notetaker = new NotetakerService({
    meetings: s.meetings,
    newId: () => `n${++n}`,
    retentionDays: () => 0,
    readiness: async () => {
      throw new Error("unused");
    },
    chooseExportPath: async () => null,
    writeFile: async () => {},
    chooseImportFiles: async () => [],
    readFile: async () => {
      throw new Error("unused");
    },
    onChange: () => {},
    log: (event, data) => logs.push({ event, data }),
    recording: {
      recorder: s.recorder,
      parts: s.parts,
      provider: () => provider,
      transcribeOptions: () => ({ language: "en", vocabulary: ["Murmur"] }),
      serviceLabel: () => "Deepgram (language: ru)",
      summarize: async (requestId, text) => {
        summaries.push({ requestId, text });
        return summaryReply;
      },
      cancelSummary: () => {},
      ready: () => over.ready ?? null,
      onProgress: (p) => progress.push({ done: p.done, total: p.total }),
    },
  });
  return {
    ...s,
    provider,
    progress,
    summaries,
    notetaker,
    logs,
    setSummaryReply: (t: string) => (summaryReply = t),
  };
}

/** A meeting with `parts` saved parts, as a stopped recording leaves it. */
function recordedMeeting(
  s: ReturnType<typeof service>,
  parts: number,
  silentParts: number[] = [],
) {
  s.meeting("m1");
  s.meetings.beginRecording("m1", 1, false);
  for (let i = 0; i < parts; i++)
    s.parts.files.set(
      `m1_${i}`,
      silentParts.includes(i)
        ? new Int16Array(PART_SAMPLES)
        : tone(PART_SAMPLES),
    );
  s.meetings.finishRecording("m1", {
    endedAt: 2,
    recordedMs: parts * 30_000,
    audioParts: parts,
    status: "processing",
    error: null,
  });
}

test("transcription: five-minute batches, silence never sent, transcript saved, audio deleted", async () => {
  const s = service();
  // 12 parts = 2 batches; the second batch (parts 10–11) is silent.
  recordedMeeting(s, 12, [10, 11]);
  await s.notetaker.transcribe({ id: "m1" });
  const m = s.meetings.get("m1")!;
  assert.equal(PARTS_PER_BATCH, 10);
  assert.equal(s.provider.calls, 1, "the silent batch wasn't sent");
  assert.deepEqual(s.progress, [
    { done: 1, total: 2 },
    { done: 2, total: 2 },
  ]);
  assert.equal(m.status, "ready");
  assert.equal(m.hasTranscript, true);
  assert.equal(m.transcript, "We agreed to ship on Friday.");
  assert.equal(m.audioParts, 0);
  await settle();
  assert.equal(
    s.parts.files.size,
    0,
    "the recording is deleted once the transcript is saved",
  );
});

test("transcription failures keep the recording and say why; transcribing again works", async () => {
  const s = service();
  recordedMeeting(s, 2);
  s.provider.fail = new ProviderError(
    "groq",
    "HTTP 401: invalid key sk-should-not-show",
    401,
  );
  await s.notetaker.transcribe({ id: "m1" });
  let m = s.meetings.get("m1")!;
  assert.equal(m.status, "failed");
  assert.match(m.error ?? "", /didn't accept the API key/);
  assert.doesNotMatch(
    m.error ?? "",
    /sk-should-not-show/,
    "no provider text in the message",
  );
  assert.equal(m.audioParts, 2);
  assert.equal(s.parts.files.size, 2, "the recording is kept");
  s.provider.fail = null;
  await s.notetaker.transcribe({ id: "m1" });
  m = s.meetings.get("m1")!;
  assert.equal(m.status, "ready");
  assert.equal(m.transcript, "We agreed to ship on Friday.");
});

test("transcription: a service that isn't set up sends nothing; a missing part is reported", async () => {
  const s = service();
  recordedMeeting(s, 1);
  s.provider.ready = "Add your Groq API key in Settings → Transcription.";
  await s.notetaker.transcribe({ id: "m1" });
  assert.equal(s.provider.calls, 0);
  assert.match(
    s.meetings.get("m1")!.error ?? "",
    /Add your Groq API key.*Nothing was sent/,
  );
  s.provider.ready = null;
  s.parts.files.delete("m1_0");
  await s.notetaker.transcribe({ id: "m1" });
  assert.match(s.meetings.get("m1")!.error ?? "", /missing/);
  await assert.rejects(
    s.notetaker.transcribe({ id: "nope" }),
    /no longer exists/,
  );
});

test("after a crash: a recording is never resumed; saved audio can still be transcribed", async () => {
  const s = service();
  s.meeting("rec");
  s.meetings.beginRecording("rec", 1, true);
  s.meetings.recordingProgress("rec", 60_000, 2);
  s.meeting("empty");
  s.meetings.beginRecording("empty", 1, true);
  s.meeting("proc");
  s.meetings.beginRecording("proc", 1, false);
  s.meetings.finishRecording("proc", {
    endedAt: 2,
    recordedMs: 30_000,
    audioParts: 1,
    status: "processing",
    error: null,
  });
  s.notetaker.recover();
  assert.equal(s.mic.starts, 0, "nothing reopened");
  const rec = s.meetings.get("rec")!;
  assert.equal(rec.status, "failed");
  assert.match(
    rec.error ?? "",
    /quit while recording.*can still be transcribed/,
  );
  assert.equal(rec.audioParts, 2);
  assert.equal(s.meetings.get("empty")!.status, "notes");
  assert.match(s.meetings.get("proc")!.error ?? "", /Transcribe it again/);
});

test("recording needs setup and consent; Start Notetaker leaves nothing behind when it can't start", async () => {
  const blocked = service({ ready: "Set up Notetaker first." });
  blocked.meeting("m1");
  await assert.rejects(
    blocked.notetaker.startRecording({ id: "m1" }),
    /Set up Notetaker/,
  );
  await assert.rejects(blocked.notetaker.startNotetaker(), /Set up Notetaker/);
  assert.equal(blocked.meetings.count(), 1);
  const s = service();
  s.mic.failWith = new Error("Microphone access is off");
  await assert.rejects(
    s.notetaker.startNotetaker(),
    /Microphone access is off/,
  );
  assert.equal(s.meetings.count(), 0);
  s.mic.failWith = null;
  const m = await s.notetaker.startNotetaker();
  assert.equal(m.status, "recording");
  assert.equal(s.notetaker.recordingState().meetingId, m.id);
});

test("a meeting being recorded can't be deleted; deleting one removes its audio", async () => {
  const s = service();
  s.meeting("m1");
  await s.notetaker.startRecording({ id: "m1" });
  assert.throws(
    () => s.notetaker.delete({ id: "m1", confirm: true }),
    /Stop the recording/,
  );
  assert.throws(() => s.notetaker.deleteAll(), /Stop the meeting recording/);
  s.feed(31);
  await s.notetaker.stopRecording();
  await settle();
  // Transcription isn't wired in this setup (onRecorded is the recorder test's), so the parts stay.
  assert.equal(s.parts.files.size, 2);
  assert.equal(s.notetaker.delete({ id: "m1", confirm: true }), true);
  await settle();
  assert.equal(s.parts.files.size, 0);
});

test("deleting a meeting retries a failed audio removal once, then logs it with a count", async () => {
  const s = service();
  s.meeting("m1");
  await s.notetaker.startRecording({ id: "m1" });
  s.feed(31);
  await s.notetaker.stopRecording();
  await settle();
  let calls = 0;
  const real = s.parts.removeMeeting.bind(s.parts);
  s.parts.removeMeeting = async (id: string, parts: number) => {
    calls++;
    if (calls === 1) throw new Error("disk busy");
    return real(id, parts);
  };
  assert.equal(s.notetaker.delete({ id: "m1", confirm: true }), true);
  await settle();
  assert.equal(calls, 2, "retried once");
  assert.equal(s.parts.files.size, 0, "the retry removed the audio");
  assert.deepEqual(
    s.logs
      .filter((l) => l.event.startsWith("meeting.audio.remove"))
      .map((l) => l.event),
    ["meeting.audio.remove.retry"],
  );

  const t = service();
  t.meeting("m2");
  t.parts.removeMeeting = async () => {
    throw new Error("still busy");
  };
  assert.equal(t.notetaker.delete({ id: "m2", confirm: true }), true);
  await settle();
  const failed = t.logs.filter(
    (l) => l.event === "meeting.audio.remove.failed",
  );
  assert.equal(failed.length, 1);
  assert.equal(typeof failed[0].data?.parts, "number");
});

test("summaries: only from a transcript, saved, and never logged", async () => {
  const s = service();
  s.meeting("m1");
  await assert.rejects(
    s.notetaker.summarize({ id: "m1", requestId: "r1" }),
    /no transcript/,
  );
  s.meetings.saveNotes("m1", "Agenda: release", 1);
  s.meetings.saveTranscript("m1", "We agreed to ship on Friday.");
  const m = await s.notetaker.summarize({ id: "m1", requestId: "r1" });
  assert.equal(m.hasSummary, true);
  assert.equal(m.summary, "## Summary\nShip on Friday.");
  assert.match(
    s.summaries[0].text,
    /Notes written during the meeting:\nAgenda: release/,
  );
  assert.match(
    s.summaries[0].text,
    /Transcript:\nWe agreed to ship on Friday\./,
  );
  assert.ok(!JSON.stringify(s.logs).includes("Friday"));
  const md = meetingMarkdown(s.meetings.get("m1")!);
  assert.match(md, /## Summary\n\n## Summary\nShip on Friday\./);
  assert.match(md, /## Transcript\n\nWe agreed to ship on Friday\./);
});

test("the log never carries a transcript or what was said", async () => {
  const s = service();
  recordedMeeting(s, 1);
  s.provider.text = "Confidential: acquisition of Contoso";
  await s.notetaker.transcribe({ id: "m1" });
  assert.ok(!JSON.stringify(s.logs).includes("Contoso"));
  assert.deepEqual(
    Object.keys(
      s.logs.find((l) => l.event === "meeting.transcribed")!.data!,
    ).sort(),
    ["batches", "chars", "id", "ms", "peak", "resumedFrom", "sent"],
  );
});

test("silence detection uses the loudest 100 ms", () => {
  const quiet = new Int16Array(SECOND * 2);
  assert.ok(peakWindowRms(quiet) < 0.004);
  quiet.set(tone(SECOND / 10), SECOND);
  assert.ok(peakWindowRms(quiet) > 0.004, "a short burst of speech counts");
});

test("formatClock shows minutes:seconds, with hours when needed", () => {
  assert.equal(formatClock(0), "0:00");
  assert.equal(formatClock(65_000), "1:05");
  assert.equal(formatClock(3_725_000), "1:02:05");
});

// ---- Dictation while a meeting records; the Capsule ----------------------------------------------

test("while a meeting records, the dictation shortcut says so and starts nothing", async () => {
  const clock = new FakeClock();
  const audio = new FakeAudio();
  const capsule = new FakeCapsule();
  let meeting = true;
  const controller = new DictationController(
    {
      hold: realHold(),
      audio,
      target: fakeTarget(),
      inserter: new FakeInserter(),
      capsule,
      cancelHotkey: new FakeCancelHotkey(),
      history: new FakeHistory(),
      vault: new FakeVault(),
      provider: () => new FakeProvider(),
      clock,
      newId: () => "d1",
      log: () => {},
      busy: () => (meeting ? "Meeting recording on" : null),
    },
    { resultDisplayMs: 500 },
  );
  controller.hotkey("down");
  await flush();
  await clock.advance(1500);
  controller.hotkey("up");
  await flush();
  controller.toggleFromCapsule();
  await flush();
  assert.equal(audio.started, 0);
  assert.equal(controller.currentPhase, "idle");
  assert.deepEqual(
    capsule.states.filter((x) => x.state === "warning").map((x) => x.message),
    ["Meeting recording on", "Meeting recording on"],
  );
  meeting = false;
  controller.hotkey("down");
  await flush();
  assert.equal(
    audio.started,
    1,
    "dictation works again once the meeting stops",
  );
});

test("Capsule at rest shows the meeting recording (time visible, never spoken), and a notice first", () => {
  const rec = present("resting", undefined, null, true, {
    text: "Meeting 12:04",
    paused: false,
  });
  assert.equal(rec.text, "Meeting 12:04");
  assert.equal(rec.icon, "rec");
  assert.equal(rec.tone, "danger");
  assert.equal(rec.spoken, "Meeting recording on");
  const paused = present("resting", undefined, null, true, {
    text: "Meeting 12:04",
    paused: true,
  });
  assert.equal(paused.spoken, "Meeting recording paused");
  assert.equal(paused.tone, "neutral");
  const notice = present("resting", undefined, "Shortcut unavailable", true, {
    text: "Meeting 1:00",
    paused: false,
  });
  assert.equal(notice.text, "Shortcut unavailable");
  assert.equal(
    present("resting").text,
    "",
    "nothing recording: the plain mark",
  );
});

// ---- Adapters ------------------------------------------------------------------------------------

test("audio parts: encrypted in their own folder, read back exactly, removed per meeting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-9d2-vault-"));
  const key = randomBytes(32);
  const parts = new VaultAudioParts(
    new AudioVault(join(dir, "meeting-audio"), key),
  );
  const dictations = new AudioVault(join(dir, "audio"), key);
  await dictations.save("d1", new Uint8Array([1, 2, 3]));
  const a = tone(SECOND);
  await parts.save("m1", 0, a);
  await parts.save("m1", 1, tone(10));
  await parts.save("m2", 0, tone(10));
  assert.deepEqual([...(await parts.load("m1", 0))!], [...a]);
  const raw = readdirSync(join(dir, "meeting-audio"));
  assert.deepEqual(raw.sort(), [
    "m1_0.wav.enc",
    "m1_1.wav.enc",
    "m2_0.wav.enc",
  ]);
  // Clearing History's recordings never touches meeting audio.
  await dictations.clearAll();
  assert.ok(await parts.load("m1", 0));
  await parts.removeMeeting("m1", 3);
  assert.equal(await parts.load("m1", 0), null);
  assert.ok(await parts.load("m2", 0), "other meetings keep theirs");
});

function fakeLink() {
  const sent: { type: string; id?: number }[] = [];
  const listeners = new Set<(m: AudioRendererMessage) => void>();
  return {
    sent,
    listeners,
    emit: (m: AudioRendererMessage) => [...listeners].forEach((l) => l(m)),
    link: {
      send: (c: { type: string; id?: number }) => void sent.push(c),
      onMessage: (cb: (m: AudioRendererMessage) => void) => {
        listeners.add(cb);
        return () => void listeners.delete(cb);
      },
    },
  };
}

test("meeting microphone: its own start ids, chunks only after its start, stop waits for the last ones", async () => {
  const f = fakeLink();
  const mic = new RendererMeetingMic(f.link, () => "usb-mic");
  const chunks: number[] = [];
  const started = mic.start(
    (p) => chunks.push(p.length),
    () => {},
  );
  const start = f.sent[0] as { type: string; id: number };
  assert.equal(start.type, "start");
  assert.ok(start.id > 1_000_000, "apart from dictation's start ids");
  f.emit({ type: "started", id: 1, deviceId: null, fallback: false }); // a dictation's
  f.emit({ type: "chunk", samples: new Int16Array(5).buffer });
  f.emit({
    type: "started",
    id: start.id,
    deviceId: "usb-mic",
    fallback: false,
  });
  await started;
  f.emit({ type: "chunk", samples: new Int16Array(7).buffer });
  const stopping = mic.stop();
  assert.equal(f.sent.at(-1)?.type, "stop");
  f.emit({ type: "chunk", samples: new Int16Array(3).buffer });
  f.emit({ type: "stopped" });
  await stopping;
  assert.deepEqual(chunks, [7, 3]);
  assert.equal(f.listeners.size, 0, "nothing left listening");
});

test("meeting microphone: a refused start rejects with the reason", async () => {
  const f = fakeLink();
  const mic = new RendererMeetingMic(f.link, () => null);
  const p = mic.start(
    () => {},
    () => {},
  );
  f.emit({ type: "error", name: "NotAllowedError", message: "denied" });
  await assert.rejects(
    p,
    (e: Error & { code?: string }) =>
      e.code === "permission-denied" &&
      /Microphone access is off.*Privacy & Security/.test(e.message),
  );
});

test("system audio adapter: copies PCM out of an unaligned Buffer", async () => {
  const backing = Buffer.alloc(9);
  const view = backing.subarray(1); // odd byte offset
  view.writeInt16LE(1234, 0);
  view.writeInt16LE(-5, 2);
  let stopped = 0;
  const source = new NativeSystemAudioSource({
    systemAudioSupport: () => "available",
    SystemAudioTap: class {
      async start() {}
      read() {
        return view.subarray(0, 4);
      }
      stop() {
        stopped++;
      }
    },
  });
  assert.equal(source.read().length, 0, "nothing before start");
  await source.start();
  assert.deepEqual([...source.read()], [1234, -5]);
  source.stop();
  assert.equal(stopped, 1);
});

test("system audio adapter: stopped while macOS is still asking, the tap is released once it starts", async () => {
  let release!: () => void;
  const events: string[] = [];
  const source = new NativeSystemAudioSource({
    systemAudioSupport: () => "available",
    SystemAudioTap: class {
      start() {
        return new Promise<void>((r) => (release = r)).then(() => {
          events.push("started");
        });
      }
      read() {
        return Buffer.alloc(0);
      }
      stop() {
        events.push("stop");
      }
    },
  });
  const starting = source.start();
  source.stop();
  release();
  await starting;
  assert.equal(
    events.at(-1),
    "stop",
    "a stop follows the start, so nothing keeps running",
  );
  assert.ok(events.indexOf("started") < events.lastIndexOf("stop"));
  assert.equal(source.read().length, 0);
});

test("transcription: sound sent but no words back keeps the recording and names the service and language", async () => {
  const s = service();
  recordedMeeting(s, 1);
  s.provider.text = "";
  await s.notetaker.transcribe({ id: "m1" });
  const m = s.meetings.get("m1")!;
  assert.equal(s.provider.calls, 1);
  assert.equal(m.status, "failed");
  assert.equal(m.hasTranscript, false);
  assert.match(
    m.error ?? "",
    /Deepgram \(language: ru\) returned no words.*Language menu.*kept/,
  );
  assert.equal(m.audioParts, 1);
  assert.equal(s.parts.files.size, 1, "the audio is kept for another try");
  s.provider.text = "Мы договорились выпустить в пятницу.";
  await s.notetaker.transcribe({ id: "m1" });
  assert.equal(s.meetings.get("m1")!.status, "ready");
});

test("transcription: a silent recording sends nothing and is saved as silent", async () => {
  const s = service();
  recordedMeeting(s, 2, [0, 1]);
  await s.notetaker.transcribe({ id: "m1" });
  const m = s.meetings.get("m1")!;
  assert.equal(s.provider.calls, 0);
  assert.equal(m.status, "ready");
  assert.equal(m.hasTranscript, true);
  assert.equal(m.transcript, "");
});

// ---- Stage 9D-3: You / Others, resuming, a language per meeting ----------------------------------

test("speakers: both tracks in time order, consecutive lines joined, echo of Others dropped", () => {
  const you = [
    { start: 0, end: 2, text: "Hi everyone." },
    { start: 2.1, end: 3, text: "Shall we start?" },
    // The microphone hearing the speakers: the same words as Others, at the same time.
    { start: 4, end: 6, text: "We ship on Friday" },
    { start: 9, end: 10, text: "Great, thanks." },
  ];
  const others = [{ start: 4.1, end: 6.2, text: "We ship on Friday." }];
  assert.equal(
    mergeSpeakers(you, others),
    "You: Hi everyone. Shall we start?\nOthers: We ship on Friday.\nYou: Great, thanks.",
  );
  assert.equal(mergeSpeakers([], []), "");
  assert.deepEqual(segmentsOf({ text: " Hello " }, 30), [
    { start: 0, end: 30, text: "Hello" },
  ]);
  assert.deepEqual(segmentsOf({ text: "" }, 30), []);
});

test("recorder: with speaker labels and your Mac's sound, the two tracks are saved apart", async () => {
  const s = setup({ speakerLabels: true });
  s.meeting();
  await s.recorder.start("m1");
  s.feed(31);
  await s.recorder.stop();
  await settle();
  assert.deepEqual([...s.parts.files.keys()].sort(), [
    "m1_0_mic",
    "m1_0_system",
    "m1_1_mic",
    "m1_1_system",
  ]);
  assert.equal(
    s.parts.files.get("m1_0_mic")!.length,
    s.parts.files.get("m1_0_system")!.length,
  );
  assert.equal(s.meetings.get("m1")!.audioLayout, "split");
  // Labels on but no Mac sound to label: one mixed track.
  const t = setup({ speakerLabels: true });
  t.system.supportValue = "unsupported-os";
  t.meeting();
  await t.recorder.start("m1");
  t.feed(2);
  await t.recorder.stop();
  await settle();
  assert.deepEqual([...t.parts.files.keys()], ["m1_0"]);
  assert.equal(t.meetings.get("m1")!.audioLayout, "mixed");
});

/** A split meeting: `parts` parts per track; `quietSystem` makes the Mac's-sound track silent. */
function splitMeeting(
  s: ReturnType<typeof service>,
  parts: number,
  quietSystem = false,
) {
  s.meeting("m1");
  s.meetings.beginRecording("m1", 1, true, 1, "split");
  for (let i = 0; i < parts; i++) {
    s.parts.files.set(`m1_${i}_mic`, tone(PART_SAMPLES));
    s.parts.files.set(
      `m1_${i}_system`,
      quietSystem ? new Int16Array(PART_SAMPLES) : tone(PART_SAMPLES),
    );
  }
  s.meetings.finishRecording("m1", {
    endedAt: 2,
    recordedMs: parts * 30_000,
    audioParts: parts,
    status: "processing",
    error: null,
  });
}

test("transcription: split tracks are sent with timestamps and labelled You / Others", async () => {
  const s = service();
  splitMeeting(s, 2);
  const asked: { timestamps?: boolean }[] = [];
  let call = 0;
  s.provider.transcribe = async (_audio, options: { timestamps?: boolean }) => {
    asked.push({ timestamps: options.timestamps });
    return ++call === 1
      ? {
          text: "Hi. Ready?",
          segments: [
            { start: 0, end: 1, text: "Hi." },
            { start: 5, end: 6, text: "Ready?" },
          ],
        }
      : { text: "Hello.", segments: [{ start: 2, end: 3, text: "Hello." }] };
  };
  await s.notetaker.transcribe({ id: "m1" });
  const m = s.meetings.get("m1")!;
  assert.deepEqual(asked, [{ timestamps: true }, { timestamps: true }]);
  assert.equal(m.status, "ready");
  assert.equal(m.transcript, "You: Hi.\nOthers: Hello.\nYou: Ready?");
  await settle();
  assert.equal(
    s.parts.files.size,
    0,
    "both tracks deleted once the transcript is saved",
  );
  assert.match(
    meetingMarkdown(m),
    /\*\*You:\*\* Hi\.\n\*\*Others:\*\* Hello\./,
  );
});

test("transcription: a silent Mac-sound track isn't sent; only You is labelled", async () => {
  const s = service();
  splitMeeting(s, 1, true);
  s.provider.text = "Just me talking.";
  await s.notetaker.transcribe({ id: "m1" });
  assert.equal(s.provider.calls, 1);
  assert.equal(s.meetings.get("m1")!.transcript, "You: Just me talking.");
});

test("transcription: after a failure, Transcribe again continues where it stopped", async () => {
  const s = service();
  recordedMeeting(s, 25); // 3 batches
  let call = 0;
  s.provider.transcribe = async () => {
    call++;
    if (call === 2) throw new ProviderError("groq", "HTTP 503", 503);
    return { text: `Batch text ${call}.` };
  };
  await s.notetaker.transcribe({ id: "m1" });
  let m = s.meetings.get("m1")!;
  assert.equal(m.status, "failed");
  assert.equal(m.doneBatches, 1, "the first batch is kept");
  await s.notetaker.transcribe({ id: "m1" });
  m = s.meetings.get("m1")!;
  assert.equal(call, 4, "batch 1 wasn't sent again");
  assert.equal(m.status, "ready");
  assert.equal(m.transcript, "Batch text 1.\n\nBatch text 3.\n\nBatch text 4.");
  assert.equal(m.doneBatches, 0);
});

test("language per meeting: dictation's by default, automatic detection, or one chosen; a change starts over", async () => {
  const s = service();
  recordedMeeting(s, 1);
  const languages: (string | undefined)[] = [];
  s.provider.transcribe = async (_a, options: { language?: string }) => {
    languages.push(options.language);
    return { text: "" };
  };
  await s.notetaker.transcribe({ id: "m1" });
  s.notetaker.update({ id: "m1", language: "" });
  await s.notetaker.transcribe({ id: "m1" });
  s.notetaker.update({ id: "m1", language: "uz" });
  await s.notetaker.transcribe({ id: "m1" });
  assert.deepEqual(languages, ["en", undefined, "uz"]);
  assert.match(
    s.meetings.get("m1")!.error ?? "",
    /returned no words.*Language menu/,
  );
  assert.throws(() => s.notetaker.update({ id: "m1", language: "klingon!" }));
  // Finished batches in the old language are done again after a change.
  s.meetings.saveBatch("m1", 0, "старый текст");
  assert.equal(s.meetings.get("m1")!.doneBatches, 1);
  s.notetaker.update({ id: "m1", language: "ru" });
  assert.equal(s.meetings.get("m1")!.doneBatches, 0);
});

test("audio window messages: unknown types, oversized or odd-sized chunks and bad levels are dropped", () => {
  const ok = new ArrayBuffer(3200);
  assert.deepEqual(parseAudioMessage({ type: "chunk", samples: ok }), {
    type: "chunk",
    samples: ok,
  });
  assert.equal(parseAudioMessage({ type: "stopped" })?.type, "stopped");
  // A typed-array view (what a structured clone may deliver) is normalised to an exact buffer.
  const pcm = new Int16Array([1, -2, 3]);
  const viaView = parseAudioMessage({
    type: "chunk",
    samples: new Uint8Array(pcm.buffer),
  }) as { samples: ArrayBuffer };
  assert.deepEqual([...new Int16Array(viaView.samples)], [1, -2, 3]);
  const shifted = new Uint8Array(12);
  shifted.set(new Uint8Array(pcm.buffer), 4);
  const viaOffset = parseAudioMessage({
    type: "chunk",
    samples: new Int16Array(shifted.buffer, 4, 3),
  }) as { samples: ArrayBuffer };
  assert.deepEqual([...new Int16Array(viaOffset.samples)], [1, -2, 3]);
  for (const bad of [
    null,
    "chunk",
    {},
    { type: "format-disk" },
    { type: 1 },
    { type: "chunk" },
    { type: "chunk", samples: new Uint8Array(11) },
    { type: "chunk", samples: [1, 2, 3] },
    { type: "chunk", samples: new ArrayBuffer(CHUNK_MAX_BYTES + 2) },
    { type: "chunk", samples: new ArrayBuffer(3) },
    { type: "level", session: 1, rms: "loud", peak: 0, muted: false },
    { type: "level", session: 1, rms: 0.1, peak: 0.2 },
  ])
    assert.equal(parseAudioMessage(bad), null, JSON.stringify(bad));
  assert.ok(
    parseAudioMessage({
      type: "chunk",
      samples: new ArrayBuffer(CHUNK_MAX_BYTES),
    }),
  );
  assert.ok(
    parseAudioMessage({
      type: "level",
      session: 1,
      rms: 0.1,
      peak: 0.2,
      muted: false,
    }),
  );
});

// ---- Review fixes -----------------------------------------------------------------------------------

test("speakers: a service without timing keeps both sides whole; echo is only removed between timed lines", () => {
  const you = [
    { start: 0, end: 30, text: "We ship on Friday after the review." },
  ];
  const others = [
    { start: 0, end: 30, text: "We ship on Friday after the review today." },
  ];
  assert.equal(
    mergeSpeakers(you, others, false),
    "You: We ship on Friday after the review.\nOthers: We ship on Friday after the review today.",
  );
  // Timed: a reply that shares words with Others but isn't a repeat of them is kept.
  assert.equal(
    mergeSpeakers(
      [
        {
          start: 1,
          end: 3,
          text: "Friday works, but can we ship Monday instead?",
        },
      ],
      [{ start: 1, end: 3, text: "We ship on Friday." }],
    ),
    "Others: We ship on Friday.\nYou: Friday works, but can we ship Monday instead?",
  );
  // The same words in a different order are not an echo either.
  assert.equal(
    mergeSpeakers(
      [{ start: 1, end: 3, text: "Friday ship review the" }],
      [{ start: 1, end: 3, text: "the review ship Friday" }],
    ).startsWith("Others:"),
    true,
  );
  assert.match(
    mergeSpeakers(
      [{ start: 1, end: 3, text: "Friday ship review the" }],
      [{ start: 1, end: 3, text: "the review ship Friday" }],
    ),
    /You: Friday ship review the/,
  );
});

test("transcription: a provider that returns no segments keeps what you said", async () => {
  const s = service();
  splitMeeting(s, 1);
  let call = 0;
  s.provider.transcribe = async () => ({
    text:
      ++call === 1
        ? "We ship on Friday after the review."
        : "We ship on Friday after the review today.",
  });
  await s.notetaker.transcribe({ id: "m1" });
  assert.equal(
    s.meetings.get("m1")!.transcript,
    "You: We ship on Friday after the review.\nOthers: We ship on Friday after the review today.",
  );
});

test("resume: a microphone that won't reopen leaves nothing capturing, and the next resume doesn't leak a tap", async () => {
  const s = setup();
  s.meeting();
  await s.recorder.start("m1");
  s.feed(2);
  await s.recorder.pause();
  s.mic.failWith = new Error("Microphone access is off");
  await assert.rejects(s.recorder.resume(), /Microphone access is off/);
  assert.equal(s.recorder.state.phase, "paused");
  assert.equal(s.system.live, false, "the tap opened for the resume is closed");
  assert.equal(s.system.starts, s.system.stops);
  s.mic.failWith = null;
  await s.recorder.resume();
  assert.equal(s.system.live, true);
  await s.recorder.stop();
  assert.equal(s.system.live, false);
});

test("system audio adapter: starting again stops the tap it replaces", async () => {
  const stops: number[] = [];
  let n = 0;
  const source = new NativeSystemAudioSource({
    systemAudioSupport: () => "available",
    SystemAudioTap: class {
      id = ++n;
      async start() {}
      read() {
        return Buffer.alloc(0);
      }
      stop() {
        stops.push(this.id);
      }
    },
  });
  await source.start();
  await source.start();
  assert.deepEqual(stops, [1]);
});

test("stop: a failure while saving still ends the recording, so dictation isn't blocked", async () => {
  const s = setup();
  s.meeting();
  await s.recorder.start("m1");
  s.feed(2);
  s.meetings.finishRecording = () => {
    throw new Error("disk full");
  };
  await s.recorder.stop();
  assert.equal(s.recorder.active, false);
  assert.equal(s.recorder.state.phase, "idle");
  assert.ok(s.logs.some((l) => l.event === "meeting.recording.stop.failed"));
});

test("pause keeps the last audio the tap collected", async () => {
  const s = setup();
  s.meeting();
  await s.recorder.start("m1");
  s.feed(5);
  s.system.queued.push(tone(SECOND / 4, 4000));
  await s.recorder.pause();
  assert.equal(s.recorder.state.elapsedMs, 5250);
});

test("a meeting's language can't change while it is being transcribed", async () => {
  const s = service();
  recordedMeeting(s, 1);
  let release!: () => void;
  s.provider.transcribe = () =>
    new Promise((r) => (release = () => r({ text: "Hello." })));
  const running = s.notetaker.transcribe({ id: "m1" });
  await settle();
  assert.throws(
    () => s.notetaker.update({ id: "m1", language: "ru" }),
    /being transcribed/,
  );
  s.notetaker.update({ id: "m1", title: "Renamed" });
  release();
  await running;
  assert.equal(s.meetings.get("m1")!.language, null);
  s.notetaker.update({ id: "m1", language: "ru" });
  assert.equal(s.meetings.get("m1")!.language, "ru");
});

test("deleting a meeting mid-transcription stops its uploads and saves nothing", async () => {
  const s = service();
  recordedMeeting(s, 25); // 3 batches
  let signal!: AbortSignal;
  let call = 0;
  let release!: () => void;
  s.provider.transcribe = (_a, o: { signal?: AbortSignal }) => {
    call++;
    signal = o.signal!;
    return new Promise((r) => (release = () => r({ text: "Hello." })));
  };
  const running = s.notetaker.transcribe({ id: "m1" });
  await settle();
  assert.equal(call, 1);
  s.notetaker.delete({ id: "m1", confirm: true });
  assert.equal(signal.aborted, true);
  release();
  await running;
  assert.equal(call, 1, "no further batch is sent");
  assert.equal(s.meetings.get("m1"), null);
  assert.equal(s.meetings.batches("m1").length, 0);
});

test("after a crash: a recovered meeting ends when its recorded time ran out, not at the next launch", () => {
  const s = service();
  s.meeting("rec");
  s.meetings.beginRecording("rec", 5_000, true);
  s.meetings.recordingProgress("rec", 60_000, 2);
  s.notetaker.recover();
  assert.equal(s.meetings.get("rec")!.endedAt, 65_000);
});

// ---- Follow-ups: pause keeps the closing microphone's audio, lost system audio, mic listeners -----

test("pause keeps the microphone audio that arrives while the microphone is closing", async () => {
  const s = setup({ systemAudio: false });
  s.meeting();
  await s.recorder.start("m1");
  s.feed(1);
  const closing = tone(SECOND / 2);
  const stop = s.mic.stop.bind(s.mic);
  const chunk = (pcm: Int16Array) => s.mic.send(pcm);
  s.mic.stop = async () => {
    chunk(closing); // the renderer's last chunk, before it reports stopped
    await stop();
  };
  await s.recorder.pause();
  assert.equal(
    s.recorder.state.elapsedMs,
    1500,
    "the last half second before the pause is kept",
  );
});

test("system audio lost mid-recording: the microphone keeps going and the panel says why", async () => {
  const s = setup();
  let lost: string | null = null;
  let dropped = 0;
  s.system.lostReason = () => lost;
  s.system.droppedBlocks = () => dropped;
  s.meeting();
  await s.recorder.start("m1");
  s.feed(2);
  assert.equal(s.recorder.state.systemAudio.state, "on");
  lost = "output-changed";
  dropped = 3;
  s.feed(1);
  assert.deepEqual(s.recorder.state.systemAudio, {
    state: "unavailable",
    reason: "Your Mac's sound stopped: the output device changed",
  });
  assert.equal(s.system.live, false, "the tap is released");
  assert.equal(s.recorder.state.phase, "recording");
  s.feed(2);
  assert.equal(
    s.recorder.state.elapsedMs,
    5000,
    "the microphone kept recording",
  );
  await s.recorder.stop();
  await settle();
  const lostLog = s.logs.find((l) => l.event === "meeting.system-audio.lost");
  assert.deepEqual(lostLog?.data, {
    id: "m1",
    reason: "output-changed",
    droppedBlocks: 3,
  });
  const stopped = s.logs.find((l) => l.event === "meeting.recording.stopped");
  assert.equal(stopped?.data?.systemDroppedBlocks, 3);
});

test("system audio adapter: reads the tap's lost reason and dropped count, nothing before start", async () => {
  const source = new NativeSystemAudioSource({
    systemAudioSupport: () => "available",
    SystemAudioTap: class {
      lostReason = "output-changed";
      droppedBlocks = 4;
      async start() {}
      read() {
        return Buffer.alloc(0);
      }
      stop() {}
    },
  });
  assert.equal(source.lostReason(), null);
  assert.equal(source.droppedBlocks(), 0);
  await source.start();
  assert.equal(source.lostReason(), "output-changed");
  assert.equal(source.droppedBlocks(), 4);
});

test("meeting microphone: a start that timed out leaves no listener and cannot cancel a newer start", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fakeLink();
  const mic = new RendererMeetingMic(f.link, () => null);
  const first = mic.start(
    () => {},
    () => {},
  );
  const firstRejected = assert.rejects(first, /didn't start|cancelled/i);
  t.mock.timers.tick(3000);
  const chunks: number[] = [];
  const second = mic.start(
    (p) => chunks.push(p.length),
    () => {},
  );
  await firstRejected; // superseded: settles instead of hanging
  const id = (f.sent.at(-1) as { id: number }).id;
  f.emit({ type: "started", id, deviceId: null, fallback: false });
  await second;
  // The first start's 4 s timer would fire here; it must be gone.
  t.mock.timers.tick(2000);
  assert.equal(
    f.sent.filter((c) => c.type === "cancel").length,
    0,
    "no stale cancel reached the renderer",
  );
  f.emit({ type: "chunk", samples: new Int16Array(4).buffer });
  assert.deepEqual(chunks, [4], "the newer start still listens");
  assert.equal(f.listeners.size, 1);
});

test("meeting microphone: a start that times out unsubscribes, cancels the renderer, and ignores a late start", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fakeLink();
  const mic = new RendererMeetingMic(f.link, () => null);
  const chunks: number[] = [];
  const p = mic.start(
    (c) => chunks.push(c.length),
    () => {},
  );
  const rejected = assert.rejects(p, /didn't start/);
  t.mock.timers.tick(4000);
  await rejected;
  assert.equal(f.sent.at(-1)?.type, "cancel");
  assert.equal(f.listeners.size, 0);
  const id = (f.sent[0] as { id: number }).id;
  f.emit({ type: "started", id, deviceId: null, fallback: false });
  f.emit({ type: "chunk", samples: new Int16Array(4).buffer });
  assert.deepEqual(chunks, [], "audio after the timeout is not accepted");
});

test("meeting microphone: stopping before the microphone opened cancels that start and leaves nothing listening", async () => {
  const f = fakeLink();
  const mic = new RendererMeetingMic(f.link, () => null);
  const p = mic.start(
    () => {},
    () => {},
  );
  const rejected = assert.rejects(
    p,
    (e: Error & { code?: string }) => e.code === "cancelled",
  );
  await mic.stop();
  await rejected;
  assert.equal(f.sent.at(-1)?.type, "cancel");
  assert.equal(f.listeners.size, 0);
});

test("meeting microphone: a stop that is still waiting cannot unsubscribe a newer start", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fakeLink();
  const mic = new RendererMeetingMic(f.link, () => null);
  const first = mic.start(
    () => {},
    () => {},
  );
  f.emit({
    type: "started",
    id: (f.sent[0] as { id: number }).id,
    deviceId: null,
    fallback: false,
  });
  await first;
  const stopping = mic.stop(); // the renderer never answers
  const chunks: number[] = [];
  const second = mic.start(
    (c) => chunks.push(c.length),
    () => {},
  );
  const startMsg = f.sent.filter((c) => c.type === "start").at(-1) as {
    id: number;
  };
  f.emit({ type: "started", id: startMsg.id, deviceId: null, fallback: false });
  await second;
  await stopping;
  t.mock.timers.tick(2500); // the old stop's timeout
  f.emit({ type: "chunk", samples: new Int16Array(6).buffer });
  assert.deepEqual(chunks, [6]);
});
