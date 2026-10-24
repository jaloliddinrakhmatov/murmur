import type { HelpChatEvent } from "@murmur/account-api";
import type { z } from "zod";

export type HelpEvent = z.output<typeof HelpChatEvent>;

/** What one line of an upstream OpenAI-compatible stream means. */
export type UpstreamItem =
  | { kind: "delta"; text: string }
  | { kind: "finish"; reason: string }
  | { kind: "done" }
  | { kind: "error" };

/**
 * Incremental parser for the upstream `data:` lines of a chat-completions stream. Chunks may
 * split anywhere (UTF-8 is decoded before this).
 * Comment lines, event names and blank lines are ignored; `data: [DONE]` ends the stream; a
 * chunk with an `error` object is reported as an error without its text (provider messages are
 * never passed on). Chunks that are not JSON are skipped.
 */
export class UpstreamParser {
  private buffer = "";

  push(chunk: string): UpstreamItem[] {
    this.buffer += chunk;
    const out: UpstreamItem[] = [];
    let at: number;
    while ((at = this.buffer.search(/\r\n|\n|\r/)) >= 0) {
      const sep = this.buffer.startsWith("\r\n", at) ? 2 : 1;
      const line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + sep);
      out.push(...this.line(line));
    }
    return out;
  }

  /** The stream ended: a final line without a newline still counts. */
  end(): UpstreamItem[] {
    const rest = this.buffer;
    this.buffer = "";
    return rest ? this.line(rest) : [];
  }

  private line(line: string): UpstreamItem[] {
    if (!line.startsWith("data:")) return [];
    const data = line.slice(5).trim();
    if (!data) return [];
    if (data === "[DONE]") return [{ kind: "done" }];
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return [];
    }
    if (typeof json !== "object" || json === null) return [];
    const obj = json as {
      error?: unknown;
      choices?: {
        delta?: { content?: unknown };
        finish_reason?: unknown;
      }[];
    };
    if (obj.error) return [{ kind: "error" }];
    const out: UpstreamItem[] = [];
    const choice = obj.choices?.[0];
    const text = choice?.delta?.content;
    if (typeof text === "string" && text) out.push({ kind: "delta", text });
    if (typeof choice?.finish_reason === "string") {
      out.push({ kind: "finish", reason: choice.finish_reason });
    }
    return out;
  }
}

export const encodeEvent = (event: HelpEvent): string =>
  `data: ${JSON.stringify(event)}\n\n`;
