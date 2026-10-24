// Rebuilds results/speech-results.json from the saved per-sample hypotheses without re-running any
// provider. Use after changing metrics (e.g. transliteration) so numbers stay tied to real outputs.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { formatRow } from "./aggregate.ts";
import { loadSavedRecords, writeResults } from "./run.ts";
import type { Sample } from "./samples.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const samples: Sample[] = JSON.parse(
  readFileSync(join(ROOT, ".cache/samples/manifest.json"), "utf8"),
);
const previous = JSON.parse(
  readFileSync(join(ROOT, "speech-bench/results/speech-results.json"), "utf8"),
) as { unavailable: unknown };
const records = loadSavedRecords(
  new Map(samples.map((s) => [`${s.set}/${s.id}`, s])),
);
for (const row of writeResults(records, previous.unavailable))
  console.log(formatRow(row));
