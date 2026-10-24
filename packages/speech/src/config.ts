import {
  DeepgramProvider,
  GeminiProvider,
  OpenAICompatibleProvider,
  UnconfiguredProvider,
  WhisperCppProvider,
} from "./providers.ts";
import type { FetchLike, TranscriptionProvider } from "./types.ts";

export type SpeechProviderKind =
  "whisper.cpp" | "openai" | "groq" | "deepgram" | "gemini";

export interface SpeechConfig {
  provider: SpeechProviderKind;
  /** Secrets are stored separately from settings (OS keychain); passed in resolved. */
  apiKey?: string;
  model?: string;
  /** whisper.cpp only. */
  localServerUrl?: string;
}

export const DEFAULT_MODELS: Record<SpeechProviderKind, string> = {
  "whisper.cpp": "",
  openai: "gpt-4o-transcribe",
  groq: "whisper-large-v3-turbo",
  deepgram: "nova-3",
  gemini: "gemini-3.5-transcribe",
};

/**
 * Groq's default when the user didn't pick a model. The turbo model is fast and accurate in
 * English, but in other languages (Uzbek, measured 2026-10-20) it returns another language or
 * gibberish even with the language set; the full model transcribes them.
 */
export function groqModelFor(language: string | undefined): string {
  return /^en\b/i.test(language ?? "")
    ? "whisper-large-v3-turbo"
    : "whisper-large-v3";
}

export function createProvider(
  config: SpeechConfig,
  fetchFn?: FetchLike,
): TranscriptionProvider {
  const model = config.model || DEFAULT_MODELS[config.provider];
  switch (config.provider) {
    case "whisper.cpp":
      return new WhisperCppProvider({
        baseUrl: config.localServerUrl || "http://127.0.0.1:8178",
        fetch: fetchFn,
      });
    case "openai":
      if (!config.apiKey)
        return new UnconfiguredProvider(
          "OpenAI API key is not set. Open Settings → Transcription.",
        );
      return new OpenAICompatibleProvider({
        id: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: config.apiKey,
        model,
        fetch: fetchFn,
      });
    case "groq":
      if (!config.apiKey)
        return new UnconfiguredProvider(
          "Groq API key is not set. Open Settings → Transcription.",
        );
      return new OpenAICompatibleProvider({
        id: "groq",
        baseUrl: "https://api.groq.com/openai/v1",
        apiKey: config.apiKey,
        model,
        modelFor: config.model ? undefined : groqModelFor,
        fetch: fetchFn,
      });
    case "deepgram":
      if (!config.apiKey)
        return new UnconfiguredProvider(
          "Deepgram API key is not set. Open Settings → Transcription.",
        );
      return new DeepgramProvider({
        apiKey: config.apiKey,
        model,
        fetch: fetchFn,
      });
    case "gemini":
      if (!config.apiKey)
        return new UnconfiguredProvider(
          "Gemini API key is not set. Open Settings → Transcription.",
        );
      return new GeminiProvider({
        apiKey: config.apiKey,
        model,
        fetch: fetchFn,
      });
  }
}
