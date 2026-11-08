// Fleet benchmark rules (pure, unit-tested). The database never measures anything itself:
// it validates configuration, enforces run isolation and stores what the external load
// generator measured. Nothing here produces a performance number.

export const BENCH_MODES = ["FIXED", "RAMP"] as const;
export type BenchMode = (typeof BENCH_MODES)[number];
export const BENCH_STATES = ["REQUESTED", "RUNNING", "STOP_REQUESTED", "COMPLETED", "FAILED", "STOPPED"] as const;
export type BenchState = (typeof BENCH_STATES)[number];
export const ACTIVE_STATES: readonly BenchState[] = ["REQUESTED", "RUNNING", "STOP_REQUESTED"];
export const TERMINAL_STATES: readonly BenchState[] = ["COMPLETED", "FAILED", "STOPPED"];

export const LIMITS = {
  maxRovers: 5000,
  maxEventsPerRoverPerSecond: 10,
  fixedSeconds: [5, 120] as const,
  rampStageSeconds: [5, 30] as const,
  maxSubscribers: 4,
  /** A request nobody claims within this many seconds is failed on the next request. */
  claimTimeoutSeconds: 30,
  /** Hard ceiling on wall-clock run time, enforced by the runner and on the next request. */
  maxRunSeconds: 300,
  /** Completed runs kept (with their stages and samples); older ones are deleted. */
  retainedRuns: 10,
};
/** Ramp stages from the spec. Stages above the selected maximum are skipped; the maximum is the final stage. */
export const RAMP_STAGES = [1, 100, 500, 1000, 2500, 5000];

export function rampStages(maxRovers: number): number[] {
  const stages = RAMP_STAGES.filter((n) => n < maxRovers);
  stages.push(maxRovers);
  return stages;
}

export interface RunRequest {
  mode: string;
  roverCount: number;
  eventsPerRoverPerSecond: number;
  durationSeconds: number;
  subscriberCount: number;
}

/** Throws Error with a readable reason when the configuration is outside the safe limits. */
export function validateRunRequest(r: RunRequest): void {
  if (!(BENCH_MODES as readonly string[]).includes(r.mode)) throw new Error("Mode must be FIXED or RAMP");
  const int = (v: number, lo: number, hi: number, what: string) => {
    if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${what} must be an integer from ${lo} to ${hi}`);
  };
  int(r.roverCount, 1, LIMITS.maxRovers, "Rover count");
  int(r.eventsPerRoverPerSecond, 1, LIMITS.maxEventsPerRoverPerSecond, "Events per rover per second");
  const [lo, hi] = r.mode === "RAMP" ? LIMITS.rampStageSeconds : LIMITS.fixedSeconds;
  int(r.durationSeconds, lo, hi, r.mode === "RAMP" ? "Seconds per ramp stage" : "Duration");
  int(r.subscriberCount, 1, LIMITS.maxSubscribers, "Subscriber count");
  if (r.mode === "RAMP" && r.roverCount < 2) throw new Error("A ramp needs a maximum of at least 2 rovers");
}

/** Allowed transitions. Anything else is rejected. */
export function canTransition(from: string, to: string): boolean {
  const allowed: Record<string, string[]> = {
    REQUESTED: ["RUNNING", "STOPPED", "FAILED"],
    RUNNING: ["STOP_REQUESTED", "COMPLETED", "FAILED", "STOPPED"],
    STOP_REQUESTED: ["STOPPED", "FAILED", "COMPLETED"],
  };
  return (allowed[from] ?? []).includes(to);
}

/** An active run that can no longer be making progress (never claimed, or past the hard ceiling). */
export function isAbandonedRun(
  run: { state: string; requestedMicros: bigint; startedMicros: bigint | null },
  nowMicros: bigint,
): string | null {
  if (run.state === "REQUESTED" && nowMicros - run.requestedMicros > BigInt(LIMITS.claimTimeoutSeconds) * 1_000_000n)
    return `No benchmark runner claimed this run within ${LIMITS.claimTimeoutSeconds} s`;
  const since = run.startedMicros ?? run.requestedMicros;
  if (ACTIVE_STATES.includes(run.state as BenchState) && nowMicros - since > BigInt(LIMITS.maxRunSeconds) * 1_000_000n)
    return `Run exceeded the ${LIMITS.maxRunSeconds} s ceiling without finishing`;
  return null;
}

/** Synthetic sensor value bounds for benchmark events (simulated ambient temperature, °C). */
export const BENCH_VALUE_RANGE = [-50, 100] as const;
export function validateBenchValue(v: number): void {
  if (!Number.isFinite(v) || v < BENCH_VALUE_RANGE[0] || v > BENCH_VALUE_RANGE[1])
    throw new Error(`Simulated value must be within ${BENCH_VALUE_RANGE[0]}..${BENCH_VALUE_RANGE[1]}`);
}

/** Run ids to delete so that at most `keep` terminal runs remain. Active runs are never deleted. */
export function runRetention(runs: { runId: number; state: string }[], keep = LIMITS.retainedRuns): number[] {
  const terminal = runs.filter((r) => TERMINAL_STATES.includes(r.state as BenchState)).sort((a, b) => b.runId - a.runId);
  return terminal.slice(keep).map((r) => r.runId);
}

/** A measured percentile is either a finite non-negative number or absent. Never a placeholder. */
export function validMeasurement(v: number | undefined | null): boolean {
  return v === undefined || v === null || (Number.isFinite(v) && v >= 0);
}
