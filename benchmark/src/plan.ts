// Stage plan for a run. Ramp stages come from the database rules so the dashboard,
// the reducer validation and the generator always agree.
import { rampStages, validateRunRequest, type RunRequest } from "../../spacetimedb/src/benchmark";

export interface StagePlan {
  index: number;
  rovers: number;
  eventsPerRoverPerSecond: number;
  targetRate: number;
  durationMs: number;
}

export function planStages(req: RunRequest): StagePlan[] {
  validateRunRequest(req);
  const counts = req.mode === "RAMP" ? rampStages(req.roverCount) : [req.roverCount];
  return counts.map((rovers, index) => ({
    index,
    rovers,
    eventsPerRoverPerSecond: req.eventsPerRoverPerSecond,
    targetRate: rovers * req.eventsPerRoverPerSecond,
    durationMs: req.durationSeconds * 1000,
  }));
}

/** Synthetic SIMULATED ambient temperature for a rover event. Deterministic; not a metric. */
export function simulatedValue(roverIndex: number, roverSeq: number): number {
  return Math.round((22 + (roverIndex % 12) + Math.sin(roverSeq / 10) * 1.5) * 100) / 100;
}
