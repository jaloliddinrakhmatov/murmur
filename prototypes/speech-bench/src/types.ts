/** Provider-independent speech-to-text contract used by the benchmark and, later, the API. */
export interface AudioInput {
  /** 16 kHz mono PCM16 WAV bytes. */
  wav: Uint8Array;
  durationSec: number;
}

export interface TranscribeOptions {
  /** ISO 639-1 code, or undefined for provider auto-detection. */
  language?: string;
  /** Vocabulary hints (Murmur's personal dictionary). */
  vocabulary?: string[];
  signal?: AbortSignal;
}

export interface TranscriptionResult {
  text: string;
  detectedLanguage?: string;
}

export interface TranscriptionProvider {
  readonly id: string;
  readonly model: string;
  /** "local" runs on this machine (no per-use fee); "cloud" bills per audio minute. */
  readonly kind: "local" | "cloud";
  /** USD per audio minute, from configuration. null = not configured, so cost is not estimated. */
  readonly usdPerAudioMinute: number | null;
  start?(): Promise<void>;
  stop?(): Promise<void>;
  transcribe(
    audio: AudioInput,
    options: TranscribeOptions,
  ): Promise<TranscriptionResult>;
}

/** Why a provider could not run (shown in results instead of fabricated numbers). */
export interface UnavailableProvider {
  id: string;
  reason: string;
}
