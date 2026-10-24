// Sends one question through the configured help provider and prints only whether it streamed,
// the first ~200 characters of the answer, and the latency. Spends a tiny amount of credit.
import { loadHelpConfig } from "../src/config/env.ts";
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

const knowledge = loadKnowledge();
const model = createHelpModel(config, knowledge);
const system = buildSystemPrompt({
  knowledge,
  contact: config.contact,
  page: "home",
});
const messages = buildMessages(system, [
  { role: "user", content: "How do I change the dictation shortcut?" },
]);

const started = Date.now();
let first: number | null = null;
let chunks = 0;
let answer = "";
try {
  for await (const text of model.stream(messages, {
    signal: AbortSignal.timeout(40_000),
    maxTokens: 700,
  })) {
    first ??= Date.now() - started;
    chunks += 1;
    answer += text;
  }
  console.log(
    `provider: ${config.provider}${config.model ? ` (${config.model})` : ""}`,
  );
  console.log(
    `streamed: ${chunks > 1 ? "yes" : "no"} (${chunks} chunks, ${answer.length} characters)`,
  );
  console.log(
    `first text after ${first} ms, finished after ${Date.now() - started} ms`,
  );
  console.log(`answer starts: ${answer.slice(0, 200).replace(/\s+/g, " ")}`);
} catch (error) {
  // Only the coarse reason (auth, quota, upstream, timeout, empty), never the provider's text.
  const reason = (error as { failure?: string }).failure ?? "unknown";
  console.error(`FAILED (${reason}) after ${Date.now() - started} ms`);
  process.exit(1);
}
