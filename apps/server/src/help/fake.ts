import { setTimeout as sleep } from "node:timers/promises";
import type { HelpModel } from "./model.ts";
import type { ChatMessage } from "./prompt.ts";

const WORD = /[\p{L}\p{N}]{4,}/gu;
const STOP = new Set(
  "that this with have from what when where which your does about murmur there their would could should please".split(
    " ",
  ),
);

interface Section {
  title: string;
  body: string;
  words: Set<string>;
}

const words = (text: string): string[] =>
  (text.toLowerCase().match(WORD) ?? []).filter((w) => !STOP.has(w));

function sections(knowledge: string): Section[] {
  return knowledge
    .split(/^#{2,3} /m)
    .slice(1)
    .map((chunk) => {
      const [title, ...rest] = chunk.split("\n");
      const body = rest.join("\n").trim();
      return {
        title: title.trim(),
        body,
        words: new Set(words(`${title} ${body}`)),
      };
    });
}

export const FAKE_OFF_TOPIC =
  "I can only help with Murmur and using it on a Mac. Ask me about dictation, setup, shortcuts or troubleshooting.";
export const FAKE_KEY_WARNING =
  "Please don't share API keys or passwords here. If that was a real key, revoke it at the service and create a new one.";

/**
 * Development and test stand-in for an AI service: answers from the knowledge base by picking
 * the section that shares the most words with the last question, and streams it word by word
 * with small delays. It understands no language other than the guide's, so it is only for trying
 * the chat widget and the server without spending credits.
 */
export class FakeHelpModel implements HelpModel {
  private readonly parts: Section[];
  private readonly delayMs: number;

  constructor(knowledge: string, delayMs = 15) {
    this.parts = sections(knowledge);
    this.delayMs = delayMs;
  }

  answer(messages: ChatMessage[]): string {
    const question =
      [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    if (/\b(gsk_|sk-[A-Za-z0-9]|AIza)/.test(question)) return FAKE_KEY_WARNING;
    const asked = new Set(words(question));
    let best: Section | null = null;
    let bestScore = 0;
    for (const s of this.parts) {
      let score = 0;
      for (const w of asked) if (s.words.has(w)) score += 1;
      for (const w of asked) if (words(s.title).includes(w)) score += 2;
      if (score > bestScore) {
        best = s;
        bestScore = score;
      }
    }
    if (!best || bestScore < 2) return FAKE_OFF_TOPIC;
    return `**${best.title}**\n\n${best.body.slice(0, 700).trimEnd()}`;
  }

  async *stream(
    messages: ChatMessage[],
    { signal }: { signal: AbortSignal; maxTokens: number },
  ): AsyncGenerator<string> {
    const pieces = this.answer(messages).match(/\S+\s*|\s+/g) ?? [];
    for (const piece of pieces) {
      if (signal.aborted) return;
      try {
        await sleep(this.delayMs, undefined, { signal });
      } catch {
        return;
      }
      yield piece;
    }
  }
}
