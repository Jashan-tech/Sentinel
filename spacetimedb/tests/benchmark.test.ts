import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateRunRequest,
  canTransition,
  isAbandonedRun,
  runRetention,
  validMeasurement,
  validateBenchValue,
  rampStages,
  LIMITS,
} from "../src/benchmark";

const ok = { mode: "FIXED", roverCount: 100, eventsPerRoverPerSecond: 1, durationSeconds: 10, subscriberCount: 2 };
const S = 1_000_000n;

test("benchmark: accepts the documented limits and refuses anything outside them", () => {
  validateRunRequest(ok);
  validateRunRequest({ ...ok, roverCount: 5000, eventsPerRoverPerSecond: 10, durationSeconds: 120 });
  validateRunRequest({ ...ok, mode: "RAMP", roverCount: 5000, durationSeconds: 30 });
  for (const bad of [
    { ...ok, roverCount: 0 }, { ...ok, roverCount: 5001 }, { ...ok, roverCount: 1.5 },
    { ...ok, eventsPerRoverPerSecond: 0 }, { ...ok, eventsPerRoverPerSecond: 11 },
    { ...ok, durationSeconds: 4 }, { ...ok, durationSeconds: 121 },
    { ...ok, mode: "RAMP", durationSeconds: 31 }, { ...ok, mode: "RAMP", roverCount: 1 },
    { ...ok, subscriberCount: 0 }, { ...ok, subscriberCount: 5 }, { ...ok, mode: "SPIKE" },
  ])
    assert.throws(() => validateRunRequest(bad), Error, JSON.stringify(bad));
});
test("benchmark: ramp stages skip anything above the maximum", () => {
  assert.deepEqual(rampStages(5000), [1, 100, 500, 1000, 2500, 5000]);
  assert.deepEqual(rampStages(750), [1, 100, 500, 750]);
  assert.deepEqual(rampStages(2), [1, 2]);
});
test("benchmark: state machine allows only forward transitions; terminal states are final", () => {
  assert.ok(canTransition("REQUESTED", "RUNNING"));
  assert.ok(canTransition("RUNNING", "STOP_REQUESTED"));
  assert.ok(canTransition("STOP_REQUESTED", "STOPPED"));
  assert.ok(!canTransition("COMPLETED", "RUNNING"));
  assert.ok(!canTransition("STOPPED", "COMPLETED"));
  assert.ok(!canTransition("REQUESTED", "COMPLETED"));
});
test("benchmark: unclaimed and over-ceiling runs are detected as abandoned", () => {
  const now = 1_000_000n * S;
  assert.match(isAbandonedRun({ state: "REQUESTED", requestedMicros: now - 31n * S, startedMicros: null }, now)!, /claimed/);
  assert.equal(isAbandonedRun({ state: "REQUESTED", requestedMicros: now - 5n * S, startedMicros: null }, now), null);
  assert.match(isAbandonedRun({ state: "RUNNING", requestedMicros: 0n, startedMicros: now - BigInt(LIMITS.maxRunSeconds + 1) * S }, now)!, /ceiling/);
  assert.equal(isAbandonedRun({ state: "COMPLETED", requestedMicros: 0n, startedMicros: 0n }, now), null);
});
test("benchmark: retention keeps the newest terminal runs and never deletes an active run", () => {
  const runs = Array.from({ length: 14 }, (_, i) => ({ runId: i + 1, state: i === 0 ? "RUNNING" : "COMPLETED" }));
  const del = runRetention(runs, 10);
  assert.deepEqual(del.sort((a, b) => a - b), [2, 3, 4]);
  assert.ok(!del.includes(1));
});
test("benchmark: measurements must be real numbers or absent", () => {
  assert.ok(validMeasurement(undefined));
  assert.ok(validMeasurement(0));
  assert.ok(validMeasurement(12.5));
  assert.ok(!validMeasurement(-1));
  assert.ok(!validMeasurement(Number.NaN));
  assert.ok(!validMeasurement(Infinity));
});
test("benchmark: simulated values are bounded", () => {
  validateBenchValue(22.4);
  assert.throws(() => validateBenchValue(500));
  assert.throws(() => validateBenchValue(Number.NaN));
});
