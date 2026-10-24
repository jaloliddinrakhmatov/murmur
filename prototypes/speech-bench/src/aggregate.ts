// Turns per-sample records into per-(provider, set, variant) rows. Shared by the runner and by
// `rescore.ts`, so re-scoring saved hypotheses can never diverge from a live run.
import { summarize } from "../../lib/stats.ts";
import { cyrillicShare, errorCounts } from "./metrics.ts";
import { latinizeUzbek } from "./translit.ts";

export interface SampleRecord {
  provider: string;
  kind: "local" | "cloud";
  usdPerAudioMinute: number | null;
  set: string;
  variant: string;
  id: string;
  language: "en" | "uz" | "mixed";
  synthetic: boolean;
  durationSec: number;
  reference: string;
  terms: string[];
  // Present on success:
  latencyMs?: number;
  hypothesis?: string;
  detectedLanguage?: string;
  // Present on failure:
  error?: string;
}

export function languageMatches(
  detected: string | undefined,
  expected: string,
): boolean {
  if (!detected) return false;
  const d = detected.toLowerCase();
  return (
    d === expected ||
    (expected === "uz" && d === "uzbek") ||
    (expected === "en" && d === "english")
  );
}

export function aggregate(samples: SampleRecord[]) {
  const groups = new Map<string, SampleRecord[]>();
  for (const s of samples) {
    const key = `${s.provider}\u0000${s.set}\u0000${s.variant}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(s);
  }
  return [...groups.values()].map((items) => {
    const ok = items.filter((s) => s.hypothesis !== undefined);
    const sum = (f: (s: SampleRecord) => number) =>
      ok.reduce((n, s) => n + f(s), 0);
    const counts = ok.map((s) => errorCounts(s.reference, s.hypothesis!));
    const refWords = counts.reduce((n, c) => n + c.refWords, 0);
    const refChars = counts.reduce((n, c) => n + c.refChars, 0);
    const isUz = items[0].set.startsWith("uz-");
    const latinCounts = isUz
      ? ok.map((s) => errorCounts(s.reference, latinizeUzbek(s.hypothesis!)))
      : [];
    const langChecks = ok.filter(
      (s) => s.language !== "mixed" && s.variant === "auto",
    );
    const termsExpected = sum((s) => s.terms.length);
    const termsFound = sum(
      (s) => s.terms.filter((t) => s.hypothesis!.includes(t)).length,
    );
    const audioSec = sum((s) => s.durationSec);
    const price = items[0].usdPerAudioMinute;
    return {
      provider: items[0].provider,
      kind: items[0].kind,
      set: items[0].set,
      variant: items[0].variant,
      synthetic: items.some((s) => s.synthetic),
      files: items.length,
      audioSec: +audioSec.toFixed(1),
      failures: items.length - ok.length,
      wer: refWords
        ? +(counts.reduce((n, c) => n + c.wordEdits, 0) / refWords).toFixed(3)
        : null,
      cer: refChars
        ? +(counts.reduce((n, c) => n + c.charEdits, 0) / refChars).toFixed(3)
        : null,
      /** Uzbek only: WER after transliterating Cyrillic output to Latin (approximate). */
      werLatinized:
        isUz && refWords
          ? +(
              latinCounts.reduce((n, c) => n + c.wordEdits, 0) / refWords
            ).toFixed(3)
          : null,
      cerLatinized:
        isUz && refChars
          ? +(
              latinCounts.reduce((n, c) => n + c.charEdits, 0) / refChars
            ).toFixed(3)
          : null,
      uzCyrillicOutputs: isUz
        ? ok.filter((s) => cyrillicShare(s.hypothesis!) > 0.5).length
        : null,
      latencyMs: summarize(ok.map((s) => s.latencyMs!)),
      realTimeFactor: summarize(
        ok.map((s) => s.latencyMs! / 1000 / s.durationSec),
      ),
      languageIdAccuracy: langChecks.length
        ? +(
            langChecks.filter((s) =>
              languageMatches(s.detectedLanguage, s.language),
            ).length / langChecks.length
          ).toFixed(2)
        : null,
      termRecall: termsExpected
        ? +(termsFound / termsExpected).toFixed(2)
        : null,
      estimatedUsd:
        price == null ? null : +((audioSec / 60) * price).toFixed(4),
    };
  });
}

export function formatRow(r: ReturnType<typeof aggregate>[number]): string {
  const lat = r.werLatinized == null ? "" : ` latin ${r.werLatinized}`;
  return `${r.provider.padEnd(34)} ${r.set.padEnd(14)} ${r.variant.padEnd(16)} WER ${String(r.wer).padEnd(6)}${lat} p50 ${r.latencyMs.p50}ms RTF ${r.realTimeFactor.p50} lang ${r.languageIdAccuracy} fail ${r.failures}`;
}
