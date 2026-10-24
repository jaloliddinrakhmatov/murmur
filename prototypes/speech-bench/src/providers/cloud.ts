// Cloud adapters. UNTESTED in M0: no credentials were available in the benchmark environment.
// They are enabled only when the matching API key is set, and price per minute must be supplied
// through the environment so the harness never invents a cost.
import type {
  AudioInput,
  TranscribeOptions,
  TranscriptionProvider,
  TranscriptionResult,
  UnavailableProvider,
} from "../types.ts";

function price(envVar: string): number | null {
  const v = process.env[envVar];
  return v ? Number(v) : null;
}

/** OpenAI-compatible `/audio/transcriptions` (OpenAI, Groq, and other compatible hosts). */
export class OpenAICompatibleProvider implements TranscriptionProvider {
  readonly kind = "cloud";
  readonly id: string;
  readonly model: string;
  readonly usdPerAudioMinute: number | null;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(
    id: string,
    model: string,
    baseUrl: string,
    apiKey: string,
    usdPerAudioMinute: number | null,
  ) {
    this.id = id;
    this.model = model;
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.usdPerAudioMinute = usdPerAudioMinute;
  }

  async transcribe(
    audio: AudioInput,
    options: TranscribeOptions,
  ): Promise<TranscriptionResult> {
    const form = new FormData();
    form.append(
      "file",
      new Blob([audio.wav], { type: "audio/wav" }),
      "audio.wav",
    );
    form.append("model", this.model);
    form.append("response_format", "json");
    if (options.language) form.append("language", options.language);
    if (options.vocabulary?.length)
      form.append("prompt", options.vocabulary.join(", "));
    const res = await fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal: options.signal,
    });
    if (!res.ok)
      throw new Error(`${this.id}: HTTP ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { text: string; language?: string };
    return { text: body.text.trim(), detectedLanguage: body.language };
  }
}

export class DeepgramProvider implements TranscriptionProvider {
  readonly kind = "cloud";
  readonly id = "deepgram";
  readonly model: string;
  readonly usdPerAudioMinute: number | null;
  private readonly apiKey: string;

  constructor(model: string, apiKey: string, usdPerAudioMinute: number | null) {
    this.model = model;
    this.apiKey = apiKey;
    this.usdPerAudioMinute = usdPerAudioMinute;
  }

  async transcribe(
    audio: AudioInput,
    options: TranscribeOptions,
  ): Promise<TranscriptionResult> {
    const params = new URLSearchParams({
      model: this.model,
      smart_format: "true",
      punctuate: "true",
    });
    if (options.language) params.set("language", options.language);
    else params.set("detect_language", "true");
    for (const term of options.vocabulary ?? []) params.append("keyterm", term);
    const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
      method: "POST",
      headers: {
        Authorization: `Token ${this.apiKey}`,
        "Content-Type": "audio/wav",
      },
      body: audio.wav,
      signal: options.signal,
    });
    if (!res.ok)
      throw new Error(`deepgram: HTTP ${res.status} ${await res.text()}`);
    const body = (await res.json()) as {
      results: {
        channels: {
          alternatives: { transcript: string }[];
          detected_language?: string;
        }[];
      };
    };
    const channel = body.results.channels[0];
    return {
      text: channel.alternatives[0]?.transcript ?? "",
      detectedLanguage: channel.detected_language,
    };
  }
}

export function cloudProviders(): {
  ready: TranscriptionProvider[];
  unavailable: UnavailableProvider[];
} {
  const ready: TranscriptionProvider[] = [];
  const unavailable: UnavailableProvider[] = [];
  const add = (
    id: string,
    keyVar: string,
    make: (key: string) => TranscriptionProvider,
  ) => {
    const key = process.env[keyVar];
    if (key) ready.push(make(key));
    else unavailable.push({ id, reason: `${keyVar} not set` });
  };
  add(
    "openai:gpt-4o-transcribe",
    "OPENAI_API_KEY",
    (k) =>
      new OpenAICompatibleProvider(
        "openai:gpt-4o-transcribe",
        process.env.OPENAI_STT_MODEL ?? "gpt-4o-transcribe",
        "https://api.openai.com/v1",
        k,
        price("OPENAI_STT_USD_PER_MIN"),
      ),
  );
  add(
    "groq:whisper-large-v3-turbo",
    "GROQ_API_KEY",
    (k) =>
      new OpenAICompatibleProvider(
        "groq:whisper-large-v3-turbo",
        process.env.GROQ_STT_MODEL ?? "whisper-large-v3-turbo",
        "https://api.groq.com/openai/v1",
        k,
        price("GROQ_STT_USD_PER_MIN"),
      ),
  );
  add(
    "deepgram",
    "DEEPGRAM_API_KEY",
    (k) =>
      new DeepgramProvider(
        process.env.DEEPGRAM_MODEL ?? "nova-3",
        k,
        price("DEEPGRAM_USD_PER_MIN"),
      ),
  );
  return { ready, unavailable };
}
