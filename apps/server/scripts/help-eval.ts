// Runs the help chat's evaluation questions (src/help/eval-cases.ts) through the configured
// provider and prints pass/fail per question. Spends credits (about 22 short answers); with
// MURMUR_HELP_PROVIDER=fake it only exercises the harness. Prints problems, never full answers.
import { loadHelpConfig } from "../src/config/env.ts";
import { checkAnswer, EVAL_CASES } from "../src/help/eval-cases.ts";
import { createHelpModel } from "../src/help/model.ts";
import {
  buildMessages,
  buildSystemPrompt,
  loadKnowledge,
} from "../src/help/prompt.ts";

let config;
try {
  config = loadHelpConfig(process.env, false);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Invalid settings.");
  process.exit(1);
}
if (!config) {
  console.error(
    "The help chat isn't set up. Run: npm run help:setup -w apps/server",
  );
  process.exit(1);
}
const fake = config.provider === "fake";
const knowledge = loadKnowledge();
const model = createHelpModel(
  { ...config, dailyLimit: config.dailyLimit },
  knowledge,
);
const system = buildSystemPrompt({ knowledge, contact: config.contact });

let failed = 0;
let skipped = 0;
for (const c of EVAL_CASES) {
  if (fake && c.fake === false) {
    skipped += 1;
    console.log(`SKIP  ${c.id} (the fake provider can't answer this)`);
    continue;
  }
  let answer = "";
  try {
    for await (const text of model.stream(
      buildMessages(system, [{ role: "user", content: c.question }]),
      { signal: AbortSignal.timeout(40_000), maxTokens: 700 },
    )) {
      answer += text;
    }
  } catch (error) {
    failed += 1;
    console.log(
      `FAIL  ${c.id}: provider error (${(error as { failure?: string }).failure ?? "unknown"})`,
    );
    continue;
  }
  const result = checkAnswer(c, answer);
  if (!result.ok) failed += 1;
  console.log(
    `${result.ok ? "PASS" : "FAIL"}  ${c.id}${result.ok ? "" : `: ${result.problems.join("; ")}`}`,
  );
}
const ran = EVAL_CASES.length - skipped;
console.log(
  `\n${ran - failed}/${ran} passed${skipped ? `, ${skipped} skipped` : ""}${fake ? " (fake provider: harness check only)" : ""}`,
);
// The fake provider only proves the harness runs; its answers are not graded.
process.exit(failed && !fake ? 1 : 0);
