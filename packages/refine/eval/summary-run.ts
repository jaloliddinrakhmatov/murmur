// Live evaluation of meeting summaries (Stage D): the instructions the app ships
// (SUMMARY_PROMPT) on the cases in summary-cases.ts.
//   GROQ_API_KEY=… npm run eval:summary -w packages/refine [-- --providers=groq --reps=2]
// Writes results/summary-eval-<date>.json. A provider qualifies when every case passes on every
// repetition, no injected instruction was obeyed, and no call failed.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCleanupProvider, type AiProviderKind } from "../src/config.ts";
import type { CleanupProvider, TextGenerator } from "../src/types.ts";
import {
  SUMMARY_MAX_TOKENS,
  SUMMARY_PROMPT,
  summaryInput,
} from "../src/summary.ts";
import { SUMMARY_CASES } from "./summary-cases.ts";
import { scoreSummary } from "./summary-score.ts";

const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const REPS = Number(arg("reps") ?? 1);
const filter = arg("providers")?.split(",");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const keys: Record<AiProviderKind, string | undefined> = {
    groq: process.env.GROQ_API_KEY,
    openai: process.env.OPENAI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
    gemini: process.env.GEMINI_API_KEY,
  };
  const summaries: Record<string, unknown>[] = [];
  const outputs: Record<string, unknown>[] = [];
  const unavailable: string[] = [];
  for (const kind of [
    "groq",
    "openai",
    "anthropic",
    "gemini",
  ] as AiProviderKind[]) {
    if (filter && !filter.includes(kind)) continue;
    if (!keys[kind]) {
      unavailable.push(`${kind}: ${kind.toUpperCase()}_API_KEY not set`);
      continue;
    }
    // Every cloud cleanup provider also generates text (the app relies on the same).
    const provider = createCleanupProvider({
      provider: kind,
      apiKey: keys[kind],
      model: process.env[`${kind.toUpperCase()}_CLEANUP_MODEL`],
    }) as CleanupProvider & TextGenerator;
    let passed = 0;
    let errors = 0;
    let injectionsObeyed = 0;
    let firstError: string | null = null;
    const latencies: number[] = [];
    console.log(`${provider.id}: ${SUMMARY_CASES.length} meetings × ${REPS}…`);
    for (const [n, c] of SUMMARY_CASES.entries())
      for (let rep = 0; rep < REPS; rep++) {
        process.stdout.write(
          `  meeting ${n + 1}/${SUMMARY_CASES.length} ${c.id}\r`,
        );
        const started = Date.now();
        let text = "";
        for (let attempt = 0; ; attempt++) {
          try {
            text = (
              await provider.generate(
                SUMMARY_PROMPT,
                summaryInput(c.notes ?? "", c.transcript),
                {
                  signal: AbortSignal.timeout(120_000),
                  maxTokens: SUMMARY_MAX_TOKENS,
                },
              )
            ).text;
            break;
          } catch (err) {
            const msg = String((err as Error).message);
            // Rate limits are an account property, not quality: wait and retry.
            if (/HTTP 429|rate.?limit/i.test(msg) && attempt < 6) {
              await sleep(Math.min(30_000, 2_000 * 2 ** attempt));
              continue;
            }
            errors++;
            firstError ??= msg
              .replace(/sk-[A-Za-z0-9_-]+|gsk_[A-Za-z0-9]+/g, "[key]")
              .slice(0, 200);
            break;
          }
        }
        latencies.push(Date.now() - started);
        const score = scoreSummary(c, text);
        if (score.pass) passed++;
        if (c.id === "injection" && score.forbidden.length) injectionsObeyed++;
        outputs.push({
          provider: provider.id,
          case: c.id,
          rep,
          summary: text,
          score,
        });
      }
    const total = SUMMARY_CASES.length * REPS;
    const sorted = [...latencies].sort((a, b) => a - b);
    const summary = {
      provider: provider.id,
      cases: SUMMARY_CASES.length,
      reps: REPS,
      passRate: +(passed / total).toFixed(2),
      injectionsObeyed,
      providerErrors: errors,
      firstError,
      latencyMs: {
        p50: sorted[Math.floor(sorted.length / 2)],
        max: sorted.at(-1),
      },
      qualifies: errors === 0 && injectionsObeyed === 0 && passed === total,
    };
    summaries.push(summary);
    console.log(
      `${provider.id.padEnd(30)} pass ${summary.passRate} (${passed}/${total}) injections obeyed ${injectionsObeyed} errors ${errors} p50 ${summary.latencyMs.p50}ms qualifies=${summary.qualifies}`,
    );
    for (const o of outputs.filter((x) => x.provider === provider.id))
      if (!(o.score as { pass: boolean }).pass)
        console.log(`  ${o.case}: ${JSON.stringify(o.score)}`);
  }
  if (!summaries.length) {
    console.log(
      `Nothing measured: ${unavailable.join("; ")}. Set an API key to run it.`,
    );
    return;
  }
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "results");
  mkdirSync(dir, { recursive: true });
  const file = join(
    dir,
    `summary-eval-${arg("tag") ? `${arg("tag")}-` : ""}${new Date().toISOString().slice(0, 10)}.json`,
  );
  writeFileSync(
    file,
    JSON.stringify(
      { measuredAt: new Date().toISOString(), unavailable, summaries, outputs },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `\nUnavailable: ${unavailable.join("; ") || "none"}\nWrote ${file}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
