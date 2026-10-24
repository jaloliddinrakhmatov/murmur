import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type {
  AudioInput,
  TranscribeOptions,
  TranscriptionProvider,
  TranscriptionResult,
} from "../types.ts";

/**
 * Local whisper.cpp via its HTTP server, so the model stays loaded and latency excludes model load.
 * Runs on-device (Metal on Apple Silicon); there is no per-minute fee.
 *
 * The server is started WITH timestamps: M0 measured that `--no-timestamps` silently drops the
 * middle segments of audio longer than 30 s (60 of 123 words on a 56 s clip).
 */
export class WhisperCppProvider implements TranscriptionProvider {
  readonly kind = "local";
  readonly usdPerAudioMinute = 0;
  readonly id: string;
  readonly model: string;
  private server?: ChildProcess;
  private readonly binary: string;
  private readonly modelPath: string;
  private readonly port: number;

  constructor(opts: {
    id: string;
    binary: string;
    modelPath: string;
    port: number;
  }) {
    this.id = opts.id;
    this.model = opts.modelPath.split("/").pop() ?? opts.modelPath;
    this.binary = opts.binary;
    this.modelPath = opts.modelPath;
    this.port = opts.port;
  }

  static available(binary: string, modelPath: string): string | null {
    if (!existsSync(binary))
      return `whisper-server not built (${binary}); run prototypes/scripts/setup-local-providers.sh`;
    if (!existsSync(modelPath)) return `model missing (${modelPath})`;
    return null;
  }

  async start(): Promise<void> {
    this.server = spawn(
      this.binary,
      [
        "-m",
        this.modelPath,
        "--host",
        "127.0.0.1",
        "--port",
        String(this.port),
        "-l",
        "auto",
      ],
      {
        stdio: "ignore",
      },
    );
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/`);
        if (res.ok) return;
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`${this.id}: server did not start`);
  }

  async stop(): Promise<void> {
    this.server?.kill("SIGTERM");
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
    form.append("response_format", "verbose_json");
    form.append("temperature", "0.0");
    form.append("language", options.language ?? "auto");
    if (options.vocabulary?.length)
      form.append("prompt", options.vocabulary.join(", "));
    const res = await fetch(`http://127.0.0.1:${this.port}/inference`, {
      method: "POST",
      body: form,
      signal: options.signal,
    });
    if (!res.ok) throw new Error(`${this.id}: HTTP ${res.status}`);
    const body = (await res.json()) as {
      text?: string;
      language?: string;
      error?: string;
    };
    if (body.error) throw new Error(`${this.id}: ${body.error}`);
    return { text: (body.text ?? "").trim(), detectedLanguage: body.language };
  }
}
