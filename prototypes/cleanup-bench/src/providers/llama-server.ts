// Local LLM via llama.cpp's server (OpenAI-compatible chat endpoint). Runs on-device; no per-token fee.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { SYSTEM_PROMPT, userMessage } from "../prompt.ts";
import type { CleanupOutput, CleanupProvider } from "../types.ts";

export class LlamaServerProvider implements CleanupProvider {
  readonly kind = "local";
  readonly usdPerMTok = { input: 0, output: 0 };
  readonly id: string;
  private readonly binary: string;
  private readonly modelPath: string;
  private readonly port: number;
  private server?: ChildProcess;

  constructor(opts: {
    id: string;
    binary: string;
    modelPath: string;
    port: number;
  }) {
    this.id = opts.id;
    this.binary = opts.binary;
    this.modelPath = opts.modelPath;
    this.port = opts.port;
  }

  static missing(binary: string, modelPath: string): string | null {
    if (!existsSync(binary))
      return `llama-server not built (${binary}); run prototypes/scripts/setup-local-providers.sh`;
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
        "-c",
        "4096",
        "-ngl",
        "99",
      ],
      {
        stdio: "ignore",
      },
    );
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/health`);
        if (res.ok) return;
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`${this.id}: server did not become healthy`);
  }

  async stop(): Promise<void> {
    this.server?.kill("SIGTERM");
  }

  async cleanup(
    raw: string,
    { signal }: { signal: AbortSignal },
  ): Promise<CleanupOutput> {
    const res = await fetch(
      `http://127.0.0.1:${this.port}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userMessage(raw) },
          ],
          temperature: 0,
          max_tokens: 512,
          cache_prompt: true,
        }),
      },
    );
    if (!res.ok) throw new Error(`${this.id}: HTTP ${res.status}`);
    const body = (await res.json()) as {
      choices: { message: { content: string } }[];
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    return {
      text: body.choices[0]?.message.content ?? "",
      inputTokens: body.usage?.prompt_tokens,
      outputTokens: body.usage?.completion_tokens,
    };
  }
}
