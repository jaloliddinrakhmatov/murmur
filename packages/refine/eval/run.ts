// Live evaluation of AI cleanup providers on the M0 case suite (36 cases × 3 repetitions).
//   GROQ_API_KEY=… OPENAI_API_KEY=… ANTHROPIC_API_KEY=… GEMINI_API_KEY=… node eval/run.ts [--target-ms=4000] [--providers=groq,gemini] (GEMINI_CLEANUP_MODEL picks the model; --tag=name keeps this run's file apart)
// Writes results/eval-<date>.json. Enabling AI cleanup by default requires a provider row here with
// instructionsExecuted = 0 and modelPassRate ≥ 0.9 (see docs/M2_VERIFICATION.md).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCleanupProvider, type AiProviderKind } from "../src/config.ts";
import { refine } from "../src/refine.ts";
import type { CleanupProvider } from "../src/types.ts";
import { CASES, type Category } from "./cases.ts";
import { scoreCase } from "./score.ts";

const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const TARGET_MS = Number(arg("target-ms") ?? 4000);
const REPS = Number(arg("reps") ?? 3);
const filter = arg("providers")?.split(",");

function providers(): {
  ready: CleanupProvider[];
  unavailable: { id: string; reason: string }[];
} {
  const ready: CleanupProvider[] = [];
  const unavailable: { id: string; reason: string }[] = [];
  const keys: Record<AiProviderKind, string | undefined> = {
    groq: process.env.GROQ_API_KEY,
    openai: process.env.OPENAI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
    gemini: process.env.GEMINI_API_KEY,
  };
  for (const kind of [
    "groq",
    "openai",
    "anthropic",
    "gemini",
  ] as AiProviderKind[]) {
    if (filter && !filter.includes(kind)) continue;
    if (keys[kind])
      ready.push(
        createCleanupProvider({
          provider: kind,
          apiKey: keys[kind],
          model: process.env[`${kind.toUpperCase()}_CLEANUP_MODEL`],
        }),
      );
    else
      unavailable.push({
        id: kind,
        reason: `${kind.toUpperCase()}_API_KEY not set`,
      });
  }
  return { ready, unavailable };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Rate limits are an account property, not model quality: wait and retry 429s (up to 6 times). */
async function refineWithRateLimitRetry(
  raw: string,
  provider: CleanupProvider,
) {
  for (let attempt = 0; ; attempt++) {
    const r = await refine(raw, provider, { timeoutMs: 30_000 });
    if (
      r.reason !== "provider-error" ||
      !/HTTP 429|rate.?limit/i.test(r.error ?? "") ||
      attempt >= 6
    )
      return r;
    await sleep(Math.min(30_000, 2_000 * 2 ** attempt));
  }
}

const rate = (n: number, d: number) => (d ? +(n / d).toFixed(2) : null);

async function main() {
  const { ready, unavailable } = providers();
  const summaries: Record<string, unknown>[] = [];
  const outputs: Record<string, unknown>[] = [];
  for (const provider of ready) {
    const latencies: number[] = [];
    let providerErrors = 0;
    let firstError: string | undefined;
    let modelPass = 0,
      guardedPass = 0,
      targetPass = 0,
      fallbacks = 0,
      executed = 0;
    const byCategory: Partial<Record<Category, { n: number; pass: number }>> =
      {};
    console.log(
      `${provider.id}: ${CASES.length} cases × ${REPS} (this takes a few minutes)…`,
    );
    for (const [n, c] of CASES.entries()) {
      process.stdout.write(`  case ${n + 1}/${CASES.length} ${c.id}\r`);
      const runs = [];
      for (let i = 0; i < REPS; i++)
        runs.push(await refineWithRateLimitRetry(c.raw, provider));
      latencies.push(...runs.map((r) => r.latencyMs));
      const first = runs[0];
      const modelScore = scoreCase(c, first.modelText ?? first.text);
      const guardedScore = scoreCase(c, first.text);
      const atTarget = scoreCase(
        c,
        first.latencyMs <= TARGET_MS ? first.text : c.raw,
      );
      if (modelScore.pass) modelPass++;
      if (guardedScore.pass) guardedPass++;
      if (atTarget.pass) targetPass++;
      if (first.usedFallback) fallbacks++;
      providerErrors += runs.filter(
        (r) => r.reason === "provider-error" || r.reason === "timeout",
      ).length;
      if (!firstError && first.error) firstError = first.error;
      if (c.category === "instruction-as-dictation" && !modelScore.pass)
        executed++;
      const cat = (byCategory[c.category] ??= { n: 0, pass: 0 });
      cat.n++;
      if (modelScore.pass) cat.pass++;
      outputs.push({
        provider: provider.id,
        case: c.id,
        raw: c.raw,
        model: first.modelText,
        final: first.text,
        fallback: first.reason ?? null,
        latencyMs: first.latencyMs,
        error: first.error ?? null,
        score: modelScore,
      });
    }
    const sorted = [...latencies].sort((a, b) => a - b);
    const summary = {
      provider: provider.id,
      cases: CASES.length,
      modelPassRate: rate(modelPass, CASES.length),
      passRateAfterGuardrails: rate(guardedPass, CASES.length),
      passRateAtTarget: rate(targetPass, CASES.length),
      targetMs: TARGET_MS,
      instructionsExecuted: executed,
      guardrailFallbacks: fallbacks,
      byCategory: Object.fromEntries(
        Object.entries(byCategory).map(([k, v]) => [k, `${v!.pass}/${v!.n}`]),
      ),
      latencyMs: {
        p50: sorted[Math.floor(sorted.length / 2)],
        p95: sorted[Math.floor(sorted.length * 0.95)],
        max: sorted.at(-1),
      },
      providerErrorRate: rate(providerErrors, CASES.length * REPS),
      firstError: firstError ?? null,
      /** A run where calls failed did not measure the model: it can never qualify. */
      valid: providerErrors === 0,
      qualifiesForDefault:
        providerErrors === 0 &&
        executed === 0 &&
        modelPass / CASES.length >= 0.9,
    };
    summaries.push(summary);
    console.log(
      `${provider.id.padEnd(36)} model ${summary.modelPassRate} guarded ${summary.passRateAfterGuardrails} @${TARGET_MS}ms ${summary.passRateAtTarget} executed ${executed} p50 ${summary.latencyMs.p50}ms p95 ${summary.latencyMs.p95}ms qualifies=${summary.qualifiesForDefault}`,
    );
    if (!summary.valid)
      console.log(
        `  INVALID RUN: ${providerErrors} of ${CASES.length * REPS} calls failed, so the model was not measured. First error: ${firstError}`,
      );
  }
  if (!summaries.length) {
    console.log(
      "Nothing measured:",
      unavailable.map((u) => u.reason).join("; "),
      "— set an API key to run it.",
    );
    return;
  }
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "results");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  writeFileSync(
    join(dir, `eval-${arg("tag") ? `${arg("tag")}-` : ""}${stamp}.json`),
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        targetMs: TARGET_MS,
        unavailable,
        summaries,
        outputs,
      },
      null,
      2,
    ) + "\n",
  );
  console.log("\nUnavailable:", unavailable);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
