export interface AudioInput {
  /** 16 kHz mono PCM16 WAV bytes. */
  wav: Uint8Array<ArrayBuffer>;
  durationSec: number;
}

export interface TranscribeOptions {
  /** ISO 639-1 code, or undefined for provider auto-detection. */
  language?: string;
  /** Two or more languages the speaker uses (with no `language`); only services that take such a hint use it. */
  languageHints?: string[];
  /** Vocabulary hints (the user's dictionary). M0 measured a 2.5× WER improvement on technical terms. */
  vocabulary?: string[];
  signal?: AbortSignal;
  /** Ask for timed segments as well (meeting transcripts; dictation never needs them). */
  timestamps?: boolean;
}

/** A stretch of speech with its time in the audio, in seconds. */
export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptionResult {
  text: string;
  detectedLanguage?: string;
  /** Present when timestamps were asked for and the service returned them. */
  segments?: TranscriptSegment[];
}

export interface TranscriptionProvider {
  readonly id: string;
  readonly kind: "local" | "cloud";
  /** Returns null when ready, or a human-readable reason the provider cannot be used yet. */
  readiness(): Promise<string | null>;
  transcribe(
    audio: AudioInput,
    options: TranscribeOptions,
  ): Promise<TranscriptionResult>;
}

/** Thrown for provider-side failures so callers can distinguish them from timeouts and cancellation. */
export class ProviderError extends Error {
  readonly providerId: string;
  readonly status?: number;
  /** A failure kind callers act on: "too-long" = this service cannot take a recording this long. */
  readonly code?: "too-long";
  constructor(
    providerId: string,
    message: string,
    status?: number,
    code?: "too-long",
  ) {
    super(`${providerId}: ${message}`);
    this.name = "ProviderError";
    this.providerId = providerId;
    this.status = status;
    this.code = code;
  }
}

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;
