// Benchmarks every available cleanup provider on CASES.
//   node src/run.ts [--providers=id,id] [--target-ms=1200] [--reps=3]
// Latency is measured with a generous timeout so the true distribution is visible; results "at
// target" then treat any call slower than --target-ms as a raw-transcript fallback, exactly as
// refine() would at that timeout.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { summarize } from "../../lib/stats.ts";
import { CASES, type Category } from "./cases.ts";
import { refine } from "./refine.ts";
import { scoreCase } from "./score.ts";
import { RulesProvider } from "./providers/rules.ts";
import { LlamaServerProvider } from "./providers/llama-server.ts";
import { AnthropicProvider, CLAUDE_MODELS } from "./providers/anthropic.ts";
import type { CleanupProvider } from "./types.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const TARGET_MS = Number(arg("target-ms") ?? 1200);
const REPS = Number(arg("reps") ?? 3);
const MEASURE_TIMEOUT_MS = 30_000;

class RawProvider implements CleanupProvider {
  readonly id = "raw-transcript (no cleanup)";
  readonly kind = "rules";
  readonly usdPerMTok = { input: 0, output: 0 };
  async cleanup(raw: string) {
    return { text: raw };
  }
}

function providers(): {
  ready: CleanupProvider[];
  unavailable: { id: string; reason: string }[];
} {
  const ready: CleanupProvider[] = [new RawProvider(), new RulesProvider()];
  const unavailable: { id: string; reason: string }[] = [];
  const bin = join(ROOT, ".cache/src/llama.cpp/build/bin/llama-server");
  for (const [id, file, port] of [
    [
      "llama.cpp:qwen2.5-1.5b-instruct-q4_k_m",
      "qwen2.5-1.5b-instruct-q4_k_m.gguf",
      8291,
    ],
    [
      "llama.cpp:qwen2.5-3b-instruct-q4_k_m",
      "qwen2.5-3b-instruct-q4_k_m.gguf",
      8292,
    ],
  ] as const) {
    const modelPath = join(ROOT, ".cache/models/llm", file);
    const missing = LlamaServerProvider.missing(bin, modelPath);
    if (missing) unavailable.push({ id, reason: missing });
    else
      ready.push(new LlamaServerProvider({ id, binary: bin, modelPath, port }));
  }
  for (const model of CLAUDE_MODELS) {
    if (process.env.ANTHROPIC_API_KEY) ready.push(new AnthropicProvider(model));
    else
      unavailable.push({
        id: `anthropic:${model}`,
        reason: "ANTHROPIC_API_KEY not set",
      });
  }
  return { ready, unavailable };
}

const rate = (n: number, d: number) => (d ? +(n / d).toFixed(2) : null);

async function main() {
  const filter = arg("providers")?.split(",");
  const { ready, unavailable } = providers();
  const selected = ready.filter(
    (p) => !filter || filter.some((f) => p.id.includes(f)),
  );
  const summaries: Record<string, unknown>[] = [];
  const outputs: Record<string, unknown>[] = [];

  for (const provider of selected) {
    await provider.start?.();
    await refine("warm up the model please", provider, {
      timeoutMs: MEASURE_TIMEOUT_MS,
    });

    const latencies: number[] = [];
    let modelPass = 0,
      guardedPass = 0,
      targetPass = 0,
      fallbacks = 0,
      caught = 0,
      falseFallbacks = 0;
    let terminal = 0,
      english = 0,
      inTok = 0,
      outTok = 0,
      calls = 0;
    const byCategory: Partial<Record<Category, { n: number; pass: number }>> =
      {};
    const reasons: Record<string, number> = {};

    for (const c of CASES) {
      const runs = [];
      for (let r = 0; r < REPS; r++)
        runs.push(
          await refine(c.raw, provider, { timeoutMs: MEASURE_TIMEOUT_MS }),
        );
      for (const r of runs) {
        latencies.push(r.latencyMs);
        inTok += r.inputTokens ?? 0;
        outTok += r.outputTokens ?? 0;
        calls++;
      }
      const first = runs[0];
      const modelScore = scoreCase(c, first.modelText ?? first.text);
      const guardedScore = scoreCase(c, first.text);
      const atTarget = first.latencyMs <= TARGET_MS ? first.text : c.raw;
      const targetScore = scoreCase(c, atTarget);
      if (modelScore.pass) modelPass++;
      if (guardedScore.pass) guardedPass++;
      if (targetScore.pass) targetPass++;
      if (first.usedFallback) {
        fallbacks++;
        reasons[first.reason ?? "?"] = (reasons[first.reason ?? "?"] ?? 0) + 1;
        if (modelScore.pass) falseFallbacks++;
        else caught++;
      }
      if (!["uzbek", "mixed-language"].includes(c.category)) {
        english++;
        if (modelScore.terminalPunctuation) terminal++;
      }
      const cat = (byCategory[c.category] ??= { n: 0, pass: 0 });
      cat.n++;
      if (modelScore.pass) cat.pass++;
      outputs.push({
        provider: provider.id,
        case: c.id,
        category: c.category,
        raw: c.raw,
        model: first.modelText,
        final: first.text,
        fallback: first.reason ?? null,
        latencyMs: first.latencyMs,
        score: modelScore,
      });
    }
    await provider.stop?.();

    const injection = byCategory["instruction-as-dictation"];
    const price = provider.usdPerMTok;
    const summary = {
      provider: provider.id,
      kind: provider.kind,
      cases: CASES.length,
      repsForLatency: REPS,
      modelPassRate: rate(modelPass, CASES.length),
      passRateAfterGuardrails: rate(guardedPass, CASES.length),
      passRateAtTarget: rate(targetPass, CASES.length),
      targetMs: TARGET_MS,
      instructionsExecuted: injection ? injection.n - injection.pass : null,
      byCategory: Object.fromEntries(
        Object.entries(byCategory).map(([k, v]) => [k, `${v!.pass}/${v!.n}`]),
      ),
      guardrailFallbacks: fallbacks,
      fallbackReasons: reasons,
      guardrailCaughtFailures: caught,
      guardrailFalseFallbacks: falseFallbacks,
      terminalPunctuationRate: rate(terminal, english),
      latencyMs: summarize(latencies),
      shareOverMs: Object.fromEntries(
        [800, 1200, 2000].map((t) => [
          t,
          rate(latencies.filter((l) => l > t).length, latencies.length),
        ]),
      ),
      meanTokens:
        calls && inTok
          ? {
              input: Math.round(inTok / calls),
              output: Math.round(outTok / calls),
            }
          : null,
      estUsdPer1000Dictations:
        price && calls && inTok
          ? +(
              ((inTok / calls) * price.input +
                (outTok / calls) * price.output) /
              1000
            ).toFixed(4)
          : price
            ? 0
            : null,
    };
    summaries.push(summary);
    console.log(
      `${provider.id.padEnd(42)} model ${summary.modelPassRate}  guarded ${summary.passRateAfterGuardrails}  @${TARGET_MS}ms ${summary.passRateAtTarget}  executed ${summary.instructionsExecuted}  p50 ${summary.latencyMs.p50}ms p95 ${summary.latencyMs.p95}ms`,
    );
  }

  const dir = join(ROOT, "cleanup-bench/results");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "cleanup-results.json"),
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        targetMs: TARGET_MS,
        unavailable,
        summaries,
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(dir, "cleanup-outputs.jsonl"),
    outputs.map((o) => JSON.stringify(o)).join("\n") + "\n",
  );
  console.log("\nUnavailable:", unavailable);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
