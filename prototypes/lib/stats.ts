export interface Summary {
  n: number;
  mean: number;
  p50: number;
  p95: number;
  max: number;
}

export function summarize(samples: number[]): Summary {
  if (samples.length === 0)
    return { n: 0, mean: NaN, p50: NaN, p95: NaN, max: NaN };
  const s = [...samples].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const round = (v: number) => Math.round(v * 100) / 100;
  return {
    n: s.length,
    mean: round(s.reduce((a, b) => a + b, 0) / s.length),
    p50: round(q(0.5)),
    p95: round(q(0.95)),
    max: round(s[s.length - 1]),
  };
}

/** Deterministic PRNG so generated noise is identical across runs. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
