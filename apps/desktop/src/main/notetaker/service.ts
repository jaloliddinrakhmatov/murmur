// Notetaker: local meeting notes, their times, Export and Import, and what Set up Notetaker
// checks (Stage 9D-1); recording on the person's request, transcription of the saved audio
// (deleted once the transcript is saved), summaries on request, and recovery after a crash that
// never resumes recording (Stage 9D-2). Meeting titles, notes, transcripts and summaries never
// reach the log (ids, sizes and outcomes only).
import { encodeWav, type TranscriptionProvider } from "@murmur/speech";
import { rmsOfPcm16 } from "@murmur/text";
import { summaryInput } from "@murmur/refine";
import {
  IDLE_RECORDING,
  MeetingRecordSchema,
  MeetingSummarizeSchema,
  type RecordingState,
  type TranscriptionProgress,
  MeetingCreateSchema,
  MeetingDeleteSchema,
  MeetingIdSchema,
  MeetingListSchema,
  MeetingNotesSchema,
  MeetingUpdateSchema,
  defaultMeetingTitle,
  meetingFileName,
  meetingMarkdown,
  meetingPreview,
  type Meeting,
  type MeetingSaveResult,
  type MeetingSummary,
  type NotetakerReadiness,
} from "../../shared/meetings.ts";
import type { MeetingRepo } from "../history/db.ts";
import { transcriptionFailure } from "../core/controller.ts";
import { SAMPLE_RATE, type MeetingRecorder, type Track } from "./recorder.ts";
import { isTimed, mergeSpeakers, segmentsOf } from "./speakers.ts";

/** Recording, transcription and summaries (absent where recording isn't available). */
export interface RecordingDeps {
  recorder: Pick<
    MeetingRecorder,
    "start" | "pause" | "resume" | "stop" | "state" | "active"
  >;
  parts: {
    load(
      meetingId: string,
      index: number,
      track?: Track,
    ): Promise<Int16Array | null>;
    removeMeeting(meetingId: string, parts: number): Promise<void>;
    clearAll(): Promise<void>;
    archiveAll(folder: string): Promise<number>;
  };
  provider: () => TranscriptionProvider;
  transcribeOptions: () => {
    language?: string;
    languageHints?: string[];
    vocabulary?: string[];
  };
  /** The transcription service and a language, for messages: "Deepgram (language: ru)". */
  serviceLabel: (language: string | undefined) => string;
  /** The AI summary of `text` (TransformService: readiness, consent, sanitised errors). */
  summarize: (requestId: string, text: string) => Promise<string>;
  cancelSummary: (requestId: string) => void;
  /** Why recording can't be offered yet (setup or consent missing), or null. */
  ready: () => string | null;
  onProgress: (p: TranscriptionProgress) => void;
}

export interface NotetakerDeps {
  meetings: MeetingRepo;
  newId: () => string;
  retentionDays: () => number;
  /** Read-only checks for Set up Notetaker; none of them asks macOS for anything. */
  readiness: () => Promise<NotetakerReadiness>;
  chooseExportPath: (fileName: string) => Promise<string | null>;
  writeFile: (path: string, text: string) => Promise<void>;
  /** A native Open dialog for .txt/.md files; [] when cancelled. */
  chooseImportFiles: () => Promise<string[]>;
  readFile: (path: string) => Promise<{
    name: string;
    text: string;
    size: number;
    modifiedAt: number;
  }>;
  onChange: () => void;
  log?: (event: string, data?: Record<string, unknown>) => void;
  now?: () => number;
  recording?: RecordingDeps;
}

/** Five minutes of audio per transcription request (10 parts of 30 s; about 9.6 MB of WAV). */
export const PARTS_PER_BATCH = 10;
const TRANSCRIBE_TIMEOUT_MS = 5 * 60_000;
/** Below this in every 100 ms window, a batch is silence and isn't sent (dictation's threshold). */
const SILENCE_RMS = 0.004;

/** The loudest 100 ms in `pcm`. */
export function peakWindowRms(pcm: Int16Array): number {
  let peak = 0;
  for (let i = 0; i < pcm.length; i += SAMPLE_RATE / 10)
    peak = Math.max(peak, rmsOfPcm16(pcm.subarray(i, i + SAMPLE_RATE / 10)));
  return peak;
}

/** What a failed transcription says; the recording is always kept for another try. */
export function meetingTranscriptionError(err: unknown): string {
  switch (transcriptionFailure(err).kind) {
    case "auth":
      return "The transcription service didn't accept the API key. Check Settings → Transcription, then transcribe again. The recording is kept.";
    case "quota":
      return "No credits are left on the transcription API key. The recording is kept.";
    case "rate-limit":
      return "The transcription service is busy. Try again in a moment; the recording is kept.";
    case "network":
      return "No connection. Try again when you're online; the recording is kept.";
    case "timeout":
      return "Transcription took too long. Try again; the recording is kept.";
    case "service":
      return "The transcription service had an error. Try again; the recording is kept.";
    case "language":
      return "The transcription service doesn't support the chosen language. Check Settings → Transcription; the recording is kept.";
    default:
      return "Transcription failed. Try again; the recording is kept.";
  }
}

/** Import limits: a file this size is a long document, not meeting notes. */
const IMPORT_MAX_BYTES = 500_000;
const IMPORT_MAX_FILES = 200;
const DAY = 86_400_000;

export class NotetakerService {
  private readonly d: NotetakerDeps;
  constructor(deps: NotetakerDeps) {
    this.d = deps;
  }
  private now() {
    return this.d.now?.() ?? Date.now();
  }
  private log(event: string, data?: Record<string, unknown>) {
    this.d.log?.(event, data);
  }

  list(input: unknown = {}): MeetingSummary[] {
    const { search, sort } = MeetingListSchema.parse(input ?? {});
    return this.d.meetings.list(search ?? "", sort ?? "newest").map((m) => ({
      id: m.id,
      title: m.title,
      status: m.status,
      startedAt: m.startedAt,
      endedAt: m.endedAt,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      preview: meetingPreview(m.notes),
      hasTranscript: m.hasTranscript,
      hasSummary: m.hasSummary,
      recordedMs: m.recordedMs,
    }));
  }

  get(input: unknown): Meeting | null {
    return this.d.meetings.get(MeetingIdSchema.parse(input).id);
  }

  /** A meeting with your notes only; its time defaults to now. Nothing is recorded. */
  create(input: unknown = {}): Meeting {
    const { title, startedAt } = MeetingCreateSchema.parse(input ?? {});
    const now = this.now();
    const at = startedAt === undefined ? now : startedAt;
    const m = this.d.meetings.create(
      {
        id: this.d.newId(),
        title: title || defaultMeetingTitle(at ?? now),
        startedAt: at,
      },
      now,
    );
    this.log("meeting.created", { id: m.id });
    this.d.onChange();
    return m;
  }

  update(input: unknown): Meeting {
    const { id, ...patch } = MeetingUpdateSchema.parse(input);
    if (
      patch.language !== undefined &&
      this.transcribing.has(id) &&
      patch.language !== this.d.meetings.get(id)?.language
    )
      throw new Error(
        "This meeting is being transcribed. Change its language when that finishes.",
      );
    const m = this.d.meetings.update(id, patch, this.now());
    if (!m) throw new Error("This meeting no longer exists.");
    this.d.onChange();
    return m;
  }

  saveNotes(input: unknown): MeetingSaveResult {
    const { id, notes, revision } = MeetingNotesSchema.parse(input);
    const r = this.d.meetings.saveNotes(id, notes, revision, this.now());
    if (!r.ok) this.log("meeting.save.refused", { id, reason: r.reason });
    else this.d.onChange();
    return r;
  }

  delete(input: unknown): boolean {
    const { id } = MeetingDeleteSchema.parse(input);
    if (this.d.recording?.recorder.state.meetingId === id)
      throw new Error("Stop the recording before deleting this meeting.");
    const parts = this.d.meetings.get(id)?.audioParts ?? 0;
    const deleted = this.d.meetings.delete(id);
    if (deleted) {
      this.abortTranscription(id);
      this.removeAudio(id, parts);
    }
    this.log("meeting.deleted", { id, deleted });
    if (deleted) this.d.onChange();
    return deleted;
  }

  deleteAll(): number {
    if (this.d.recording?.recorder.active)
      throw new Error("Stop the meeting recording first.");
    const n = this.d.meetings.deleteAll();
    for (const id of [...this.transcribing.keys()]) this.abortTranscription(id);
    if (this.d.recording)
      void this.d.recording.parts
        .clearAll()
        .catch((e: Error) =>
          this.log("meeting.audio.clear.failed", { error: e.name }),
        );
    if (n) this.d.onChange();
    return n;
  }

  /** Your notes as Markdown, where you choose. */
  async export(input: unknown): Promise<{ saved: boolean; path?: string }> {
    const { id } = MeetingIdSchema.parse(input);
    const m = this.d.meetings.get(id);
    if (!m) throw new Error("This meeting no longer exists.");
    const path = await this.d.chooseExportPath(meetingFileName(m));
    if (!path) return { saved: false };
    await this.d.writeFile(path, meetingMarkdown(m));
    this.log("meeting.exported", { id, chars: m.notes.length });
    return { saved: true, path };
  }

  /**
   * Import your meeting notes: each .txt or .md file you choose becomes a meeting with that text
   * as its notes, named after the file (its first heading for Markdown), dated by the file.
   */
  async import(): Promise<{ imported: number; skipped: string[] }> {
    const paths = await this.d.chooseImportFiles();
    const skipped: string[] = [];
    let imported = 0;
    for (const path of paths.slice(0, IMPORT_MAX_FILES)) {
      try {
        const f = await this.d.readFile(path);
        if (
          !/\.(txt|md|markdown)$/i.test(f.name) ||
          f.size > IMPORT_MAX_BYTES
        ) {
          skipped.push(f.name);
          continue;
        }
        const heading = /^#\s+(.+)$/m.exec(f.text)?.[1]?.trim();
        const title = (heading || f.name.replace(/\.(txt|md|markdown)$/i, ""))
          .slice(0, 120)
          .trim();
        this.d.meetings.create(
          {
            id: this.d.newId(),
            title: title || defaultMeetingTitle(this.now()),
            startedAt: Math.round(f.modifiedAt),
            notes: f.text.slice(0, 500_000),
          },
          this.now(),
        );
        imported++;
      } catch {
        skipped.push(path.split("/").pop() ?? path);
      }
    }
    if (paths.length > IMPORT_MAX_FILES)
      skipped.push(
        `${paths.length - IMPORT_MAX_FILES} more files (limit ${IMPORT_MAX_FILES})`,
      );
    this.log("meeting.imported", { imported, skipped: skipped.length });
    if (imported) this.d.onChange();
    return { imported, skipped };
  }

  /** Every meeting with its notes, oldest first (Data and Privacy → Export). */
  all(): Meeting[] {
    return this.d.meetings.list("", "oldest");
  }

  readiness(): Promise<NotetakerReadiness> {
    return this.d.readiness();
  }

  /** "Keep meetings for": removes meetings older than that (never when it's "until you delete"). */
  purgeExpired(): number {
    const days = this.d.retentionDays();
    if (!days) return 0;
    const old = this.d.meetings.olderThan(this.now() - days * DAY);
    const n = this.d.meetings.deleteOlderThan(this.now() - days * DAY);
    for (const m of old) {
      this.abortTranscription(m.id);
      this.removeAudio(m.id, m.audioParts);
    }
    if (n) {
      this.log("meeting.purged", { count: n });
      this.d.onChange();
    }
    return n;
  }

  /**
   * Deletes a meeting's saved audio (and one more part, in case a crash came mid-save). A failure
   * is retried once, then logged with how many parts were being removed, never dropped silently.
   */
  private removeAudio(id: string, parts: number): void {
    if (!this.d.recording) return;
    const store = this.d.recording.parts;
    void (async () => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await store.removeMeeting(id, parts + 1);
          return;
        } catch (e) {
          this.log(
            attempt === 1
              ? "meeting.audio.remove.retry"
              : "meeting.audio.remove.failed",
            { id, parts: parts + 1, error: (e as Error).name },
          );
        }
      }
    })();
  }

  // ---- Recording (Stage 9D-2) ------------------------------------------------------------------

  private get rec(): RecordingDeps {
    if (!this.d.recording) throw new Error("Recording isn't available here.");
    return this.d.recording;
  }

  recordingState(): RecordingState {
    return this.d.recording?.recorder.state ?? IDLE_RECORDING;
  }

  /** Starts recording a meeting, on the person's request (setup and consent come first). */
  async startRecording(input: unknown): Promise<RecordingState> {
    const { id } = MeetingRecordSchema.parse(input);
    const notReady = this.rec.ready();
    if (notReady) throw new Error(notReady);
    await this.rec.recorder.start(id);
    this.d.onChange();
    return this.rec.recorder.state;
  }

  /** “Start Notetaker”: a new meeting, recording at once. Nothing is left behind if it can't start. */
  async startNotetaker(input: unknown = {}): Promise<Meeting> {
    const notReady = this.rec.ready();
    if (notReady) throw new Error(notReady);
    const m = this.create({
      title: MeetingCreateSchema.parse(input ?? {}).title,
    });
    try {
      await this.startRecording({ id: m.id });
    } catch (err) {
      this.d.meetings.delete(m.id);
      this.d.onChange();
      throw err;
    }
    return this.d.meetings.get(m.id) ?? m;
  }

  async pauseRecording(): Promise<RecordingState> {
    await this.rec.recorder.pause();
    return this.rec.recorder.state;
  }

  async resumeRecording(): Promise<RecordingState> {
    await this.rec.recorder.resume();
    return this.rec.recorder.state;
  }

  async stopRecording(): Promise<RecordingState> {
    await this.rec.recorder.stop("user");
    this.d.onChange();
    return this.rec.recorder.state;
  }

  /** Meetings being transcribed, each with the controller that stops its uploads. */
  private readonly transcribing = new Map<string, AbortController>();

  /** Stops a meeting's transcription (it was deleted): nothing more is sent or saved. */
  private abortTranscription(id: string): void {
    this.transcribing.get(id)?.abort();
  }

  /**
   * Transcribes a meeting's saved audio in five-minute batches through the transcription service
   * chosen for dictation. Silent batches aren't sent. Once the transcript is saved, the audio is
   * deleted; on failure it is kept and the meeting says why.
   */
  async transcribe(input: unknown): Promise<void> {
    const { id } = MeetingRecordSchema.parse(input);
    const rec = this.rec;
    const m = this.d.meetings.get(id);
    if (!m) throw new Error("This meeting no longer exists.");
    if (m.status === "recording")
      throw new Error("This meeting is still being recorded.");
    if (!m.audioParts)
      throw new Error("This meeting has no saved recording to transcribe.");
    if (this.transcribing.has(id)) return;
    const stop = new AbortController();
    this.transcribing.set(id, stop);
    this.d.meetings.setStatus(id, "processing", null);
    this.d.onChange();
    const batches = Math.ceil(m.audioParts / PARTS_PER_BATCH);
    const started = this.now();
    let sent = 0;
    let loudest = 0;
    try {
      const provider = rec.provider();
      let resumed = 0;
      const notReady = await provider.readiness();
      if (notReady)
        throw new UserFacingError(
          `${notReady} Nothing was sent; the recording is kept.`,
        );
      const dictation = rec.transcribeOptions();
      // The meeting's own language: null follows dictation, "" lets the service detect it.
      const language =
        m.language === null ? dictation.language : m.language || undefined;
      const options = {
        vocabulary: dictation.vocabulary,
        language,
        // Only while the meeting follows dictation's languages.
        languageHints:
          m.language === null ? dictation.languageHints : undefined,
      };
      /** Stops quietly once the meeting is deleted: nothing is sent or saved for it. */
      const alive = () => {
        if (stop.signal.aborted || !this.d.meetings.get(id))
          throw new UserFacingError("This meeting was deleted.");
      };
      /** Sends one track of a batch unless it's silent; undefined when nothing was sent. */
      const send = async (samples: Int16Array, timestamps: boolean) => {
        alive();
        const peak = peakWindowRms(samples);
        loudest = Math.max(loudest, peak);
        if (peak < SILENCE_RMS) return undefined;
        const result = await provider.transcribe(
          {
            wav: encodeWav(samples, SAMPLE_RATE),
            durationSec: samples.length / SAMPLE_RATE,
          },
          {
            ...options,
            timestamps,
            signal: AbortSignal.any([
              AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
              stop.signal,
            ]),
          },
        );
        alive();
        sent++;
        return result;
      };
      // Batches finished before (an earlier attempt that stopped) aren't sent again.
      resumed = this.d.meetings.batches(id).length;
      for (let b = resumed; b < batches; b++) {
        const parts = range(
          b * PARTS_PER_BATCH,
          Math.min(m.audioParts, (b + 1) * PARTS_PER_BATCH),
        );
        let text = "";
        if (m.audioLayout === "split") {
          const mic = await loadTrack(rec, id, parts, "mic");
          const sys = await loadTrack(rec, id, parts, "system");
          const seconds = mic.length / SAMPLE_RATE;
          const you = await send(mic, true);
          const others = await send(sys, true);
          text = mergeSpeakers(
            you ? segmentsOf(you, seconds) : [],
            others ? segmentsOf(others, seconds) : [],
            isTimed(you) && isTimed(others),
          );
        } else {
          const result = await send(
            await loadTrack(rec, id, parts, "mixed"),
            false,
          );
          text = result?.text.trim() ?? "";
        }
        alive();
        this.d.meetings.saveBatch(id, b, text);
        rec.onProgress({ meetingId: id, done: b + 1, total: batches });
      }
      const texts = this.d.meetings.batches(id).filter(Boolean);
      if (!this.d.meetings.get(id)) return;
      // Sound was sent but no words came back: usually the language doesn't match the meeting.
      // Keep the recording (and send it all again next time) so it can be retried after a change.
      if (sent > 0 && !texts.length) {
        this.d.meetings.resetBatches(id);
        throw new UserFacingError(
          `${rec.serviceLabel(language)} returned no words for this recording. If the meeting was in another language, choose it in the meeting's Language menu, then transcribe again. The recording is kept.`,
        );
      }
      const transcript = texts.join("\n\n");
      this.d.meetings.saveTranscript(id, transcript, this.now());
      this.removeAudio(id, m.audioParts);
      this.log("meeting.transcribed", {
        id,
        batches,
        resumedFrom: resumed,
        sent,
        chars: transcript.length,
        ms: this.now() - started,
        peak: Math.round(loudest * 1e4) / 1e4,
      });
    } catch (err) {
      const message =
        err instanceof UserFacingError
          ? err.message
          : meetingTranscriptionError(err);
      if (this.d.meetings.get(id))
        this.d.meetings.setStatus(id, "failed", message);
      this.log("meeting.transcribe.failed", {
        id,
        kind:
          err instanceof UserFacingError
            ? "local"
            : transcriptionFailure(err).kind,
        sent,
      });
    } finally {
      this.transcribing.delete(id);
      this.d.onChange();
    }
  }

  /** A summary of the transcript (and your notes), by the AI service, on request only. */
  async summarize(input: unknown): Promise<Meeting> {
    const { id, requestId } = MeetingSummarizeSchema.parse(input);
    const m = this.d.meetings.get(id);
    if (!m) throw new Error("This meeting no longer exists.");
    if (!m.transcript.trim())
      throw new Error("There's no transcript to summarize.");
    const text = summaryInput(m.notes, m.transcript);
    const summary = await this.rec.summarize(requestId, text);
    if (!this.d.meetings.get(id))
      throw new Error("This meeting no longer exists.");
    this.d.meetings.saveSummary(id, summary, this.now());
    this.log("meeting.summarized", { id, chars: summary.length });
    this.d.onChange();
    return this.d.meetings.get(id)!;
  }

  cancelSummary(requestId: unknown): void {
    if (typeof requestId === "string")
      this.d.recording?.cancelSummary(requestId);
  }

  /**
   * After Murmur quit unexpectedly: a meeting left “recording” keeps the audio saved so far and
   * says so (it is never resumed); one left “processing” can be transcribed again.
   */
  recover(): void {
    for (const m of this.d.meetings.withStatus("recording")) {
      if (m.audioParts)
        this.d.meetings.finishRecording(
          m.id,
          {
            endedAt: m.endedAt ?? (m.startedAt ?? m.createdAt) + m.recordedMs,
            recordedMs: m.recordedMs,
            audioParts: m.audioParts,
            status: "failed",
            error:
              "Murmur quit while recording. What was saved can still be transcribed.",
          },
          this.now(),
        );
      else this.d.meetings.setStatus(m.id, "notes", null, this.now());
      this.log("meeting.recovered", {
        id: m.id,
        from: "recording",
        parts: m.audioParts,
      });
    }
    for (const m of this.d.meetings.withStatus("processing")) {
      this.d.meetings.setStatus(
        m.id,
        "failed",
        "Transcription stopped when Murmur quit. Transcribe it again; the recording is kept.",
        this.now(),
      );
      this.log("meeting.recovered", { id: m.id, from: "processing" });
    }
  }

  /**
   * A new recording key was started (the old one can't be read): meeting audio is moved aside
   * with dictation recordings, and meetings waiting for it say why they can't be transcribed.
   */
  async archiveAudio(folder: string): Promise<number> {
    if (!this.d.recording) return 0;
    const moved = await this.d.recording.parts.archiveAll(folder);
    for (const status of ["failed", "processing"] as const)
      for (const m of this.d.meetings.withStatus(status))
        if (m.audioParts) {
          this.d.meetings.recordingProgress(m.id, m.recordedMs, 0, this.now());
          this.d.meetings.setStatus(
            m.id,
            "failed",
            "The recording was kept under the previous, unreadable key, so it can't be transcribed.",
            this.now(),
          );
        }
    this.d.onChange();
    return moved;
  }
}

/** A failure whose message is written for the person (no provider text in it). */
class UserFacingError extends Error {}

const range = (from: number, to: number) =>
  Array.from({ length: Math.max(0, to - from) }, (_, k) => from + k);

/** One track of the given parts, in order; a part that can't be read stops transcription. */
async function loadTrack(
  rec: RecordingDeps,
  id: string,
  parts: number[],
  track: Track,
): Promise<Int16Array> {
  const pcm: Int16Array[] = [];
  for (const i of parts) {
    const part = await rec.parts.load(id, i, track).catch((e: Error) => {
      throw new UserFacingError(
        `The recording couldn't be opened: ${e.message}`,
      );
    });
    if (!part)
      throw new UserFacingError(
        "Part of the recording is missing, so it can't be transcribed.",
      );
    pcm.push(part);
  }
  return concat(pcm);
}

function concat(chunks: Int16Array[]): Int16Array {
  const out = new Int16Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
