// Pure view model for the Fleet Simulation benchmark. Every value shown is read from rows the
// external load generator stored in SpacetimeDB (benchmark_run / benchmark_stage / benchmark_sample).
// The browser computes no performance numbers of its own beyond summing stored stage counts, runs
// no timers that advance metrics, and shows "Not measured" / "Insufficient samples" for gaps.
import type { BenchmarkRun, BenchmarkSample, BenchmarkStage, BenchmarkStageServer } from "./module_bindings/types";

export type RunState = "Idle" | "Running" | "Completed" | "Failed" | "Stopped";
export const ACTIVE = ["REQUESTED", "RUNNING", "STOP_REQUESTED"];

export function runState(run: BenchmarkRun | undefined): RunState {
  if (!run) return "Idle";
  if (ACTIVE.includes(run.state)) return "Running";
  return ({ COMPLETED: "Completed", FAILED: "Failed", STOPPED: "Stopped" } as const)[run.state as "COMPLETED"] ?? "Idle";
}

export function runPhase(run: BenchmarkRun | undefined): string {
  if (!run) return "No benchmark has run yet";
  switch (run.state) {
    case "REQUESTED": return "Waiting for the benchmark runner to start the run";
    case "RUNNING": return `Stage ${run.currentStage + 1} of ${run.stageCount}`;
    case "STOP_REQUESTED": return "Stopping: draining in-flight writes";
    default: return run.message || run.state;
  }
}

export interface Metric {
  label: string;
  /** Display text: a measured value, or an explicit unavailability reason. */
  value: string;
  measured: boolean;
  unit?: string;
  source: string;
}

const n = (v: bigint | number) => Number(v);
const fmtNum = (v: number, digits = 0) => v.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
const missing = (label: string, value: string, source: string): Metric => ({ label, value, measured: false, source });

export function latestRun(runs: readonly BenchmarkRun[]): BenchmarkRun | undefined {
  return [...runs].sort((a, b) => b.runId - a.runId)[0];
}
export function stagesOf(stages: readonly BenchmarkStage[], runId: number) {
  return stages.filter((s) => s.runId === runId).sort((a, b) => a.stageIndex - b.stageIndex);
}
export function samplesOf(samples: readonly BenchmarkSample[], runId: number) {
  return samples.filter((s) => s.runId === runId).sort((a, b) => a.elapsedMs - b.elapsedMs);
}

function p95Text(p95: number | undefined, samples: number): { value: string; measured: boolean } {
  if (p95 !== undefined && p95 !== null) return { value: fmtNum(p95, 1), measured: true };
  return { value: samples > 0 ? "Insufficient samples" : "Not measured", measured: false };
}

/** The six headline metrics for a run. */
export function headline(run: BenchmarkRun | undefined, stages: readonly BenchmarkStage[], samples: readonly BenchmarkSample[]): Metric[] {
  if (!run) {
    const src = "No benchmark run recorded";
    return [
      missing("Actual throughput", "Not measured", src),
      missing("Delivery latency P95", "Not measured", src),
      missing("Delivery success", "Not measured", src),
      missing("Active simulated rovers", "None", src),
      missing("Active benchmark subscribers", "None", src),
      missing("Successfully processed", "Not measured", src),
    ];
  }
  const active = ACTIVE.includes(run.state);
  const last = samples.at(-1);
  const lastStage = stages.at(-1);
  const out: Metric[] = [];

  // 1. Throughput: acknowledged writes per second.
  if (active) {
    out.push(
      last && last.achievedRate !== undefined
        ? { label: "Actual throughput", value: fmtNum(last.achievedRate, 0), unit: "events/sec", measured: true, source: "Acknowledged writes in the latest ~1 s window" }
        : missing("Actual throughput", "Not measured yet", "No measurement window has completed"),
    );
  } else {
    out.push(
      lastStage && lastStage.achievedRate !== undefined
        ? { label: "Actual throughput", value: fmtNum(lastStage.achievedRate, 0), unit: "events/sec", measured: true, source: `Acknowledged writes ÷ stage time, final stage (${fmtNum(lastStage.roverCount)} rovers)` }
        : missing("Actual throughput", "Not measured", "No stage acknowledged any write"),
    );
  }

  // 2. P95 delivery latency (write sent → subscriber received, same monotonic clock).
  {
    const src = active ? "Latest ~1 s window" : lastStage ? `Final stage (${fmtNum(lastStage.roverCount)} rovers)` : "No stage results";
    const t = active
      ? p95Text(last?.deliveryP95, last?.deliverySamples ?? 0)
      : p95Text(lastStage?.deliveryP95, lastStage?.deliverySamples ?? 0);
    out.push({ label: "Delivery latency P95", ...t, unit: t.measured ? "ms" : undefined, source: `${src}; send → subscriber receipt` });
  }

  // 3. Delivery success: observed (event, subscriber) pairs ÷ expected, over drained stages only.
  {
    const expected = stages.reduce((a, s) => a + n(s.expectedPairs), 0);
    const observed = stages.reduce((a, s) => a + n(s.observedPairs), 0);
    out.push(
      expected > 0
        ? { label: "Delivery success", value: fmtNum((observed / expected) * 100, 2), unit: "%", measured: true, source: `${fmtNum(observed)} of ${fmtNum(expected)} acknowledged events seen by subscribers (${stages.length} stage${stages.length === 1 ? "" : "s"})` }
        : missing("Delivery success", active ? "Pending" : "Not measured", active ? "Computed after each stage drains" : "No acknowledged events"),
    );
  }

  // 4-5. Live counts reported by the generator while running.
  out.push(
    active && last
      ? { label: "Active simulated rovers", value: fmtNum(last.activeRovers), measured: true, source: "Logical rovers in the current stage (generator)" }
      : missing("Active simulated rovers", "None", active ? "Run starting" : `Run ${runState(run).toLowerCase()}`),
  );
  out.push(
    active && last
      ? { label: "Active benchmark subscribers", value: fmtNum(last.activeSubscribers), measured: true, source: "Subscriber connections with an applied subscription" }
      : missing("Active benchmark subscribers", "None", active ? "Run starting" : `Run ${runState(run).toLowerCase()}`),
  );

  // 6. Successfully processed = acknowledged (committed) writes.
  {
    const total = active ? (last ? n(last.totalAcknowledged) : null) : stages.length ? stages.reduce((a, s) => a + n(s.acknowledged), 0) : null;
    out.push(
      total === null
        ? missing("Successfully processed", "Not measured", "No measurement yet")
        : { label: "Successfully processed", value: fmtNum(total), unit: "events", measured: true, source: "Writes acknowledged by SpacetimeDB (committed)" },
    );
  }
  return out;
}

export interface ChartPoint {
  x: number; // seconds since run start (generator clock)
  y: number; // P95 ms
  stage: number;
  rovers: number;
  samples: number;
}
export interface ChartModel {
  baseline: ChartPoint[][]; // segments (gaps break the line; no interpolation)
  fleet: ChartPoint[][];
  /** Measured single-rover P95 used as a reference line, and where it came from. */
  baselineRef: { p95: number; label: string } | null;
  stageMarks: { x: number; rovers: number }[];
  gaps: number; // windows without enough samples for a P95
  xMax: number;
  yMax: number;
}

function segments(points: (ChartPoint | null)[]): ChartPoint[][] {
  const segs: ChartPoint[][] = [];
  let cur: ChartPoint[] = [];
  for (const p of points) {
    if (p) cur.push(p);
    else if (cur.length) {
      segs.push(cur);
      cur = [];
    }
  }
  if (cur.length) segs.push(cur);
  return segs;
}

/**
 * Single Rover vs Fleet P95. Ramp: stage 0 (1 rover) is the baseline series, later stages the
 * fleet series, both from this run. Fixed: the fleet series is this run; the baseline is the most
 * recent measured single-rover stage from an earlier run, labelled as previously measured.
 */
export function chartModel(
  run: BenchmarkRun | undefined,
  samples: readonly BenchmarkSample[],
  allStages: readonly BenchmarkStage[],
  allRuns: readonly BenchmarkRun[],
): ChartModel {
  const empty: ChartModel = { baseline: [], fleet: [], baselineRef: null, stageMarks: [], gaps: 0, xMax: 0, yMax: 0 };
  if (!run) return empty;
  const isBaseline = (s: BenchmarkSample) => run.mode === "RAMP" && s.stageIndex === 0;
  const pt = (s: BenchmarkSample): ChartPoint | null =>
    s.deliveryP95 === undefined ? null : { x: s.elapsedMs / 1000, y: s.deliveryP95, stage: s.stageIndex, rovers: s.activeRovers, samples: s.deliverySamples };
  const gaps = samples.filter((s) => s.deliveryP95 === undefined && s.windowMs >= 500).length;
  const baseline = segments(samples.map((s) => (isBaseline(s) ? pt(s) : null)));
  const fleet = segments(samples.map((s) => (!isBaseline(s) ? pt(s) : null)));
  const stageMarks: ChartModel["stageMarks"] = [];
  for (const s of samples)
    if (!stageMarks.some((m) => m.rovers === s.activeRovers)) stageMarks.push({ x: (s.elapsedMs - s.windowMs) / 1000, rovers: s.activeRovers });

  let baselineRef: ChartModel["baselineRef"] = null;
  const thisStage0 = run.mode === "RAMP" ? allStages.find((s) => s.runId === run.runId && s.stageIndex === 0) : undefined;
  if (thisStage0?.deliveryP95 !== undefined && thisStage0)
    baselineRef = { p95: thisStage0.deliveryP95, label: `Single-rover stage P95 (this run)` };
  else if (run.mode === "FIXED") {
    const eps = new Map(allRuns.map((r) => [r.runId, r]));
    const prev = allStages
      .filter((s) => s.runId < run.runId && s.roverCount === 1 && s.deliveryP95 !== undefined && eps.get(s.runId)?.eventsPerRoverPerSecond === run.eventsPerRoverPerSecond)
      .sort((a, b) => b.runId - a.runId)[0];
    if (prev) baselineRef = { p95: prev.deliveryP95!, label: `Single rover, previously measured (run #${prev.runId})` };
  }
  const ys = [...baseline.flat(), ...fleet.flat()].map((p) => p.y);
  if (baselineRef) ys.push(baselineRef.p95);
  return {
    baseline,
    fleet,
    baselineRef,
    stageMarks,
    gaps,
    xMax: Math.max(0, ...samples.map((s) => s.elapsedMs / 1000)),
    yMax: ys.length ? Math.max(...ys) : 0,
  };
}

/** "Nice" axis maximum and ticks for a measured maximum. Purely presentational. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.999; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return ticks;
}

/** Per-stage detail rows (all values from stored stage rows). */
export function stageRows(stages: readonly BenchmarkStage[], server: readonly BenchmarkStageServer[] = []) {
  const bySrv = new Map(server.map((r) => [r.stageKey, r]));
  const opt = (v: number | undefined, d = 1) => (v === undefined ? "Insufficient samples" : fmtNum(v, d));
  return stages.map((s) => {
    const expected = n(s.expectedPairs);
    return {
      key: s.stageKey,
      stage: s.stageIndex + 1,
      rovers: fmtNum(s.roverCount),
      target: fmtNum(s.targetRate),
      achieved: s.achievedRate === undefined ? "Not measured" : fmtNum(s.achievedRate, 1),
      attempted: fmtNum(n(s.attempted)),
      acknowledged: fmtNum(n(s.acknowledged)),
      observed: `${fmtNum(n(s.observedPairs))} / ${fmtNum(expected)}`,
      delivered: expected > 0 ? `${fmtNum((n(s.observedPairs) / expected) * 100, 2)}%` : "Not measured",
      rejected: fmtNum(n(s.rejected)),
      transport: fmtNum(n(s.transportErrors)),
      unresolved: fmtNum(n(s.unresolved)),
      skipped: fmtNum(n(s.notSentBackpressure)),
      duplicates: fmtNum(n(s.duplicateObservations)),
      p50: opt(s.deliveryP50),
      p95: opt(s.deliveryP95),
      p99: opt(s.deliveryP99),
      ackP95: opt(s.ackP95),
      samples: fmtNum(s.deliverySamples),
      loopP99: s.eventLoopP99Ms === undefined ? "Not measured" : fmtNum(s.eventLoopP99Ms, 1),
      serverCommitted: bySrv.get(s.stageKey)?.committedTxns === undefined ? "Not measured" : fmtNum(n(bySrv.get(s.stageKey)!.committedTxns!)),
    };
  });
}
