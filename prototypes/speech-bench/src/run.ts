// Runs every available provider over the prepared sample sets and writes results/.
//   node src/run.ts [--providers=id,id] [--sets=set,set] [--limit=N]
// When a filter is given, records for other providers/sets are kept from the previous run and the
// aggregates are rebuilt over the merged records. Providers without credentials or local builds are
// listed as unavailable, never estimated.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregate, formatRow, type SampleRecord } from "./aggregate.ts";
import { buildProviders, providerMeta } from "./registry.ts";
import { TECH_VOCABULARY, type Sample } from "./samples.ts";
import type { TranscriptionProvider } from "./types.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const RESULTS = join(ROOT, "speech-bench/results");
const SAMPLES_FILE = join(RESULTS, "speech-samples.jsonl");
const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];

interface Variant {
  name: string;
  language?: string;
  vocabulary?: string[];
}

/** Every set runs with auto-detect; Uzbek also with the language forced, tech also with a vocabulary prompt. */
function variantsFor(set: string): Variant[] {
  const variants: Variant[] = [{ name: "auto" }];
  if (set.startsWith("uz-")) variants.push({ name: "lang=uz", language: "uz" });
  if (set === "tech-en-tts")
    variants.push({ name: "auto+vocabulary", vocabulary: TECH_VOCABULARY });
  return variants;
}

/** Loads saved records, filling fields that older runs did not store. */
export function loadSavedRecords(
  samplesById: Map<string, Sample>,
): SampleRecord[] {
  if (!existsSync(SAMPLES_FILE)) return [];
  return readFileSync(SAMPLES_FILE, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const r = JSON.parse(line) as Partial<SampleRecord> & {
        provider: string;
        set: string;
        id: string;
        variant: string;
      };
      const s = samplesById.get(`${r.set}/${r.id}`);
      return {
        ...providerMeta(r.provider),
        language: s?.language ?? "en",
        synthetic: s?.synthetic ?? false,
        durationSec: s?.durationSec ?? 0,
        reference: s?.reference ?? "",
        terms: s?.terms ?? [],
        ...r,
      } as SampleRecord;
    });
}

export function writeResults(records: SampleRecord[], unavailable: unknown) {
  mkdirSync(RESULTS, { recursive: true });
  const rows = aggregate(records);
  writeFileSync(
    join(RESULTS, "speech-results.json"),
    JSON.stringify(
      { measuredAt: new Date().toISOString(), unavailable, rows },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    SAMPLES_FILE,
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  return rows;
}

async function runProvider(
  provider: TranscriptionProvider,
  samples: Sample[],
  sets: string[],
  limit: number,
): Promise<SampleRecord[]> {
  const records: SampleRecord[] = [];
  await provider.start?.();
  // Warm-up so the first measured request excludes GPU pipeline compilation.
  const warm = samples[0];
  await provider.transcribe(
    { wav: readFileSync(warm.path), durationSec: warm.durationSec },
    {},
  );
  for (const set of sets) {
    const items = samples.filter((s) => s.set === set).slice(0, limit);
    for (const variant of variantsFor(set)) {
      const batch: SampleRecord[] = [];
      for (const s of items) {
        const base: SampleRecord = {
          provider: provider.id,
          kind: provider.kind,
          usdPerAudioMinute: provider.usdPerAudioMinute,
          set,
          variant: variant.name,
          id: s.id,
          language: s.language,
          synthetic: s.synthetic,
          durationSec: s.durationSec,
          reference: s.reference,
          terms: s.terms ?? [],
        };
        const t0 = performance.now();
        try {
          const r = await provider.transcribe(
            { wav: readFileSync(s.path), durationSec: s.durationSec },
            {
              language: variant.language,
              vocabulary: variant.vocabulary,
              signal: AbortSignal.timeout(180_000),
            },
          );
          batch.push({
            ...base,
            latencyMs: Math.round(performance.now() - t0),
            hypothesis: r.text,
            detectedLanguage: r.detectedLanguage,
          });
        } catch (err) {
          batch.push({ ...base, error: String(err) });
        }
      }
      records.push(...batch);
      console.log(formatRow(aggregate(batch)[0]));
    }
  }
  await provider.stop?.();
  return records;
}

async function main() {
  const samples: Sample[] = JSON.parse(
    readFileSync(join(ROOT, ".cache/samples/manifest.json"), "utf8"),
  );
  const samplesById = new Map(samples.map((s) => [`${s.set}/${s.id}`, s]));
  const setFilter = arg("sets")?.split(",");
  const providerFilter = arg("providers")?.split(",");
  const limit = Number(arg("limit") ?? Infinity);
  const filtered = Boolean(setFilter || providerFilter || arg("limit"));

  const { ready, unavailable } = buildProviders(ROOT);
  const selected = ready.filter(
    (p) => !providerFilter || providerFilter.includes(p.id),
  );
  const sets = [...new Set(samples.map((s) => s.set))].filter(
    (s) => !setFilter || setFilter.includes(s),
  );

  const fresh: SampleRecord[] = [];
  for (const provider of selected)
    fresh.push(...(await runProvider(provider, samples, sets, limit)));

  const replaced = new Set(
    fresh.map((r) => `${r.provider}/${r.set}/${r.variant}`),
  );
  const kept = filtered
    ? loadSavedRecords(samplesById).filter(
        (r) => !replaced.has(`${r.provider}/${r.set}/${r.variant}`),
      )
    : [];
  const rows = writeResults([...kept, ...fresh], unavailable);
  console.log(
    `\n${rows.length} rows (${kept.length} records kept from the previous run). Unavailable:`,
    unavailable,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
