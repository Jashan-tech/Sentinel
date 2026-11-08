// UNIT tests for the dashboard's benchmark view model, using hand-written FIXTURE rows.
// Fixtures are test data only; they are never shown as benchmark results.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chartModel, headline, runState, stageRows, niceTicks } from "../../dashboard/src/benchmarkView";
import type { BenchmarkRun, BenchmarkSample, BenchmarkStage } from "../../dashboard/src/module_bindings/types";

const run = (o: Partial<BenchmarkRun> = {}): BenchmarkRun =>
  ({ runId: 5, mode: "RAMP", state: "COMPLETED", roverCount: 100, eventsPerRoverPerSecond: 1, durationSeconds: 10, subscriberCount: 2, currentStage: 1, stageCount: 2, message: "", environmentJson: "{}", runnerConnection: "", ...o }) as BenchmarkRun;
const stage = (o: Partial<BenchmarkStage> = {}): BenchmarkStage =>
  ({
    stageKey: "5:0", runId: 5, stageIndex: 0, roverCount: 1, targetRate: 1, startedElapsedMs: 0, endedElapsedMs: 10000, sendWindowMs: 10000,
    attempted: 10n, acknowledged: 10n, rejected: 0n, transportErrors: 0n, unresolved: 0n, notSentBackpressure: 0n, observedPairs: 20n,
    expectedPairs: 20n, duplicateObservations: 0n, achievedRate: 1, ackP50: 2, ackP95: 3, ackP99: undefined, ackSamples: 10,
    deliveryP50: 2.5, deliveryP95: 3.5, deliveryP99: undefined, deliverySamples: 20, eventLoopP99Ms: 1.2, ...o,
  }) as BenchmarkStage;
const sample = (o: Partial<BenchmarkSample> = {}): BenchmarkSample =>
  ({
    sampleId: 1n, runId: 5, stageIndex: 0, elapsedMs: 1000, windowMs: 1000, activeRovers: 1, activeSubscribers: 2, targetRate: 1,
    windowAcknowledged: 1, achievedRate: 1, deliveryP95: undefined, deliverySamples: 2, ackP95: undefined, totalAttempted: 1n,
    totalAcknowledged: 1n, totalRejected: 0n, totalTransportErrors: 0n, totalObservedPairs: 2n, inFlight: 0, ...o,
  }) as BenchmarkSample;
const byLabel = (ms: ReturnType<typeof headline>) => Object.fromEntries(ms.map((m) => [m.label, m]));

test("view: with no run, all six metrics say Not measured / None, never a number", () => {
  const m = headline(undefined, [], []);
  assert.equal(m.length, 6);
  assert.ok(m.every((x) => !x.measured && !/\d/.test(x.value)));
  assert.equal(runState(undefined), "Idle");
});
test("view: completed run shows stored stage values and sums stored counts", () => {
  const stages = [stage(), stage({ stageKey: "5:1", stageIndex: 1, roverCount: 100, acknowledged: 990n, attempted: 1000n, unresolved: 10n, observedPairs: 1970n, expectedPairs: 1980n, achievedRate: 99.04, deliveryP95: 6.25 })];
  const m = byLabel(headline(run(), stages, [sample()]));
  assert.equal(m["Actual throughput"].value, "99");
  assert.equal(m["Delivery latency P95"].value, "6.3");
  assert.equal(m["Delivery success"].value, "99.50"); // (20 + 1970) / (20 + 1980)
  assert.equal(m["Successfully processed"].value, "1,000");
  assert.equal(m["Active simulated rovers"].value, "None");
  assert.equal(runState(run()), "Completed");
});
test("view: running run uses the latest stored window; delivery success waits for a drained stage", () => {
  const m = byLabel(headline(run({ state: "RUNNING" }), [], [sample({ activeRovers: 500, activeSubscribers: 2, achievedRate: 498.2, deliveryP95: 4.44, deliverySamples: 996, totalAcknowledged: 2490n })]));
  assert.equal(m["Actual throughput"].value, "498");
  assert.equal(m["Delivery latency P95"].value, "4.4");
  assert.equal(m["Delivery success"].value, "Pending");
  assert.equal(m["Active simulated rovers"].value, "500");
  assert.equal(m["Active benchmark subscribers"].value, "2");
  assert.equal(m["Successfully processed"].value, "2,490");
});
test("view: a window with samples but no P95 shows Insufficient samples, not zero", () => {
  const m = byLabel(headline(run({ state: "RUNNING" }), [], [sample({ deliveryP95: undefined, deliverySamples: 4 })]));
  assert.equal(m["Delivery latency P95"].value, "Insufficient samples");
  assert.equal(m["Delivery latency P95"].measured, false);
});
test("view: nothing acknowledged means throughput and delivery are Not measured", () => {
  const s = stage({ acknowledged: 0n, rejected: 10n, observedPairs: 0n, expectedPairs: 0n, achievedRate: undefined, deliveryP95: undefined, deliverySamples: 0 });
  const m = byLabel(headline(run({ state: "FAILED" }), [s], []));
  assert.equal(m["Actual throughput"].value, "Not measured");
  assert.equal(m["Delivery success"].value, "Not measured");
  assert.equal(m["Delivery latency P95"].value, "Not measured");
});
test("view: chart draws only measured windows; gaps break the line instead of interpolating", () => {
  const samples = [
    sample({ elapsedMs: 1000, deliveryP95: 3, stageIndex: 0 }),
    sample({ elapsedMs: 2000, deliveryP95: undefined, stageIndex: 1, activeRovers: 100 }),
    sample({ elapsedMs: 3000, deliveryP95: 5, stageIndex: 1, activeRovers: 100 }),
    sample({ elapsedMs: 4000, deliveryP95: 6, stageIndex: 1, activeRovers: 100 }),
  ];
  const c = chartModel(run(), samples, [stage()], [run()]);
  assert.deepEqual(c.baseline.map((s) => s.map((p) => p.y)), [[3]]);
  assert.deepEqual(c.fleet.map((s) => s.map((p) => p.y)), [[5, 6]]);
  assert.equal(c.gaps, 1);
  assert.equal(c.baselineRef?.p95, 3.5);
  assert.match(c.baselineRef!.label, /this run/);
});
test("view: fixed load uses a previously measured single-rover stage as baseline, labelled as such", () => {
  const prevRun = run({ runId: 3 });
  const fixed = run({ runId: 6, mode: "FIXED", roverCount: 1000 });
  const c = chartModel(fixed, [sample({ runId: 6, activeRovers: 1000, deliveryP95: 9 })], [stage({ runId: 3, stageKey: "3:0" })], [prevRun, fixed]);
  assert.equal(c.baselineRef?.p95, 3.5);
  assert.match(c.baselineRef!.label, /previously measured \(run #3\)/);
  assert.equal(c.baseline.length, 0);
  const none = chartModel(fixed, [], [stage({ runId: 3, stageKey: "3:0" })], [run({ runId: 3, eventsPerRoverPerSecond: 5 }), fixed]);
  assert.equal(none.baselineRef, null); // different event rate: not comparable
});
test("view: stage table shows Insufficient samples for missing percentiles", () => {
  const [r] = stageRows([stage()]);
  assert.equal(r.p99, "Insufficient samples");
  assert.equal(r.delivered, "100.00%");
  assert.equal(r.observed, "20 / 20");
});
test("view: axis ticks cover the measured maximum", () => {
  assert.deepEqual(niceTicks(9.3), [0, 2.5, 5, 7.5, 10]);
  assert.deepEqual(niceTicks(0), [0]);
});
