export interface RateDecision {
  allowed: boolean;
  retryAfterMs: number;
}

/** In-memory sliding window per key. One process only: swap for Redis when scaling out. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Records an attempt and says whether it is within `max` per `windowMs`. */
  hit(key: string, max: number, windowMs: number): RateDecision {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => x > t - windowMs);
    if (recent.length >= max) {
      this.hits.set(key, recent);
      return { allowed: false, retryAfterMs: recent[0] + windowMs - t };
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 50_000) this.prune(windowMs);
    return { allowed: true, retryAfterMs: 0 };
  }

  /** Gives back the most recent attempt for `key` (the action it paid for never happened). */
  refund(key: string): void {
    this.hits.get(key)?.pop();
  }

  /** Counts attempts without recording one. */
  remaining(key: string, max: number, windowMs: number): number {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => x > t - windowMs);
    return Math.max(0, max - recent.length);
  }

  /** Records `n` units at once (for "emails per day"); all-or-nothing. */
  hitMany(key: string, n: number, max: number, windowMs: number): RateDecision {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => x > t - windowMs);
    if (recent.length + n > max) {
      this.hits.set(key, recent);
      return {
        allowed: false,
        retryAfterMs: recent.length ? recent[0] + windowMs - t : windowMs,
      };
    }
    for (let i = 0; i < n; i++) recent.push(t);
    this.hits.set(key, recent);
    return { allowed: true, retryAfterMs: 0 };
  }

  private prune(windowMs: number) {
    const t = this.now();
    for (const [k, v] of this.hits) {
      if (v.every((x) => x <= t - windowMs)) this.hits.delete(k);
    }
  }
}
