import { test } from "node:test";
import assert from "node:assert/strict";
import { cyrillicShare, errorCounts, normalize } from "../src/metrics.ts";
import { concat, mixAtSnr, readWav, rms, writeWav } from "../src/wav.ts";
import { mulberry32 } from "../../lib/stats.ts";

test("normalize unifies Uzbek apostrophe variants and strips punctuation", () => {
  assert.equal(
    normalize("O‘zbekiston, G'alaba! oʻqish ʼ"),
    "o'zbekiston g'alaba o'qish",
  );
  assert.equal(normalize("  Hello,   WORLD.  "), "hello world");
});

test("WER/CER counts substitutions, insertions and deletions", () => {
  assert.deepEqual(errorCounts("the cat sat", "the cat sat"), {
    wordEdits: 0,
    refWords: 3,
    charEdits: 0,
    refChars: 11,
  });
  assert.equal(errorCounts("the cat sat", "the bat sat").wordEdits, 1);
  assert.equal(errorCounts("the cat sat", "the cat").wordEdits, 1);
  assert.equal(errorCounts("the cat sat", "the cat sat down").wordEdits, 1);
  assert.equal(errorCounts("a b", "").wordEdits, 2);
});

test("detects Cyrillic output for Uzbek", () => {
  assert.equal(cyrillicShare("Ўзбекистон"), 1);
  assert.equal(cyrillicShare("O'zbekiston"), 0);
});

test("WAV round-trip, concat and SNR mixing", () => {
  const samples = Float32Array.from(
    { length: 1600 },
    (_, i) => Math.sin(i / 10) * 0.5,
  );
  const back = readWav(writeWav({ sampleRate: 16000, samples }));
  assert.equal(back.sampleRate, 16000);
  assert.ok(Math.abs(back.samples[100] - samples[100]) < 1e-4);
  assert.equal(concat([samples, samples], 160).length, 3360);

  const rng = mulberry32(1);
  const noise = Float32Array.from({ length: 1600 }, () => rng() * 2 - 1);
  const mixed = mixAtSnr(samples, noise, 10);
  const residual = mixed.map((v, i) => v - samples[i]);
  const snr = 20 * Math.log10(rms(samples) / rms(residual));
  assert.ok(Math.abs(snr - 10) < 0.1, `snr ${snr}`);
});

test("latinizes Uzbek/Kazakh Cyrillic output close to the Latin reference", async () => {
  const { latinizeUzbek } = await import("../src/translit.ts");
  assert.equal(latinizeUzbek("Ўзбекистон"), "O'zbekiston");
  assert.equal(latinizeUzbek("интернет ұзды омма"), "internet uzdi omma");
  const ref =
    "Internet o'zida ommaviy hamda shaxslararo aloqa elementlarini mujassamlashtiradi.";
  const hyp =
    "интернет ұзды омма бейхамда шақсылар ару алақа элементларыны мужасы манштырады";
  const raw = errorCounts(ref, hyp);
  const latin = errorCounts(ref, latinizeUzbek(hyp));
  assert.equal(
    raw.wordEdits / raw.refWords > 1,
    true,
    "raw WER counts every word wrong",
  );
  assert.ok(
    latin.charEdits < raw.charEdits * 0.6,
    `latinized CER much lower (${latin.charEdits} vs ${raw.charEdits})`,
  );
});
