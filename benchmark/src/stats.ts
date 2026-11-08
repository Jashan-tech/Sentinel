// Percentiles over real measured samples. No interpolation, no smoothing, no estimates:
// nearest-rank on the sorted samples, and `null` when there are too few samples for the
// percentile to mean anything.

/** Minimum samples before a percentile is reported (below this: "Insufficient samples"). */
export const MIN_SAMPLES = { p50: 5, p95: 20, p99: 100 } as const;
export type Pct = keyof typeof MIN_SAMPLES;

/** Nearest-rank percentile of already-sorted ascending samples. */
export function nearestRank(sorted: ArrayLike<number>, p: number): number {
  if (sorted.length === 0) throw new Error("no samples");
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export interface Percentiles {
  p50: number | null;
  p95: number | null;
  p99: number | null;
  samples: number;
}

/** P50/P95/P99 of the samples (sorted in place), each null when samples are insufficient. */
export function percentiles(samples: Float64Array | number[]): Percentiles {
  const sorted = samples instanceof Float64Array ? samples.sort() : Float64Array.from(samples).sort();
  const pick = (k: Pct, p: number) => (sorted.length >= MIN_SAMPLES[k] ? round3(nearestRank(sorted, p)) : null);
  return { p50: pick("p50", 50), p95: pick("p95", 95), p99: pick("p99", 99), samples: sorted.length };
}

/** Growable Float64 sample buffer (avoids millions of boxed numbers). */
export class SampleBuffer {
  private buf = new Float64Array(1024);
  length = 0;
  push(v: number) {
    if (this.length === this.buf.length) {
      const next = new Float64Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.length++] = v;
  }
  /** A copy of the samples (safe to sort). */
  values(): Float64Array {
    return this.buf.slice(0, this.length);
  }
  clear() {
    this.length = 0;
  }
}

/** Rate over a measured interval; null when the interval or count cannot support one. */
export function ratePerSecond(count: number, elapsedMs: number): number | null {
  if (!(elapsedMs > 0) || count < 0) return null; // a measured zero is still a measurement
  return round3((count * 1000) / elapsedMs);
}

export const round3 = (v: number) => Math.round(v * 1000) / 1000;
