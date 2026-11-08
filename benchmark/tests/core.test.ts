// UNIT tests (scripted inputs, fake clocks). Nothing here talks to SpacetimeDB and none of these
// numbers are benchmark results. Live checks are scripts/benchmark-live.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RateController, RoverCursor } from "../src/rate";
import { planStages, simulatedValue } from "../src/plan";
import { Collector, deliverySuccess } from "../src/collector";
import { nearestRank, percentiles, ratePerSecond, MIN_SAMPLES } from "../src/stats";

const fixed = { mode: "FIXED", roverCount: 10, eventsPerRoverPerSecond: 2, durationSeconds: 5, subscriberCount: 2 };

// ---- rate control ----
test("rate: schedules exactly rate × duration events with unlimited capacity", () => {
  const r = new RateController(250, 0);
  let sent = 0;
  for (let t = 0; t < 4000; t += 7) sent += r.take(t, Infinity);
  assert.equal(sent, 1000); // 250/s × 4 s
  assert.equal(r.notSentBackpressure, 0);
});
test("rate: first event is due at t=0; a 1/s stage of 5 s sends 5", () => {
  const r = new RateController(1, 0);
  let sent = 0;
  for (let t = 0; t < 5000; t += 1) sent += r.take(t, Infinity);
  assert.equal(sent, 5);
});
test("rate: events due while the in-flight window is full are skipped and counted, never queued", () => {
  const r = new RateController(1000, 0);
  assert.equal(r.take(100, 10), 10); // 101 due, room for 10
  assert.equal(r.notSentBackpressure, 91);
  assert.equal(r.take(100, 1000), 0); // skipped events do not come back later
  assert.equal(r.take(200, 1000), 100);
  assert.equal(r.issued + r.notSentBackpressure, 201);
});
test("rate: a stalled loop catches up only within free capacity", () => {
  const r = new RateController(100, 0);
  assert.equal(r.take(0, 50), 1);
  assert.equal(r.take(1000, 50), 50); // 100 due after a 1 s stall
  assert.equal(r.notSentBackpressure, 50);
});
test("rate: rejects a non-positive target", () => {
  assert.throws(() => new RateController(0, 0));
});
test("rovers: round-robin gives each rover an equal share and its own sequence", () => {
  const c = new RoverCursor(3);
  const got = Array.from({ length: 7 }, () => c.take());
  assert.deepEqual(got.map((g) => g.roverIndex), [0, 1, 2, 0, 1, 2, 0]);
  assert.deepEqual(got.filter((g) => g.roverIndex === 0).map((g) => g.roverSeq), [0, 1, 2]);
});

// ---- ramp scheduling ----
test("ramp: stages above the maximum are skipped; the maximum is the final stage", () => {
  const rovers = (max: number) => planStages({ ...fixed, mode: "RAMP", roverCount: max }).map((s) => s.rovers);
  assert.deepEqual(rovers(5000), [1, 100, 500, 1000, 2500, 5000]);
  assert.deepEqual(rovers(1000), [1, 100, 500, 1000]);
  assert.deepEqual(rovers(2000), [1, 100, 500, 1000, 2000]);
  assert.deepEqual(rovers(50), [1, 50]);
});
test("ramp: every stage targets rovers × events per rover, for the per-stage duration", () => {
  const st = planStages({ ...fixed, mode: "RAMP", roverCount: 500, eventsPerRoverPerSecond: 5, durationSeconds: 10 });
  assert.deepEqual(st.map((s) => s.targetRate), [5, 500, 2500]);
  assert.ok(st.every((s) => s.durationMs === 10_000));
});
test("plan: fixed load is a single stage; unsafe configurations are refused", () => {
  assert.equal(planStages(fixed).length, 1);
  assert.throws(() => planStages({ ...fixed, roverCount: 5001 }), /Rover count/);
  assert.throws(() => planStages({ ...fixed, durationSeconds: 1000 }), /Duration/);
  assert.throws(() => planStages({ ...fixed, mode: "RAMP", roverCount: 1 }), /at least 2/);
});
test("plan: simulated sensor values stay within the database's accepted range", () => {
  for (let r = 0; r < 50; r++) for (let s = 0; s < 50; s++) {
    const v = simulatedValue(r, s);
    assert.ok(v >= -50 && v <= 100);
  }
});

// ---- percentiles ----
test("stats: nearest-rank percentiles on real samples, no interpolation", () => {
  const xs = Float64Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(nearestRank(xs, 50), 50);
  assert.equal(nearestRank(xs, 95), 95);
  assert.equal(nearestRank(xs, 99), 99);
  assert.equal(nearestRank(Float64Array.of(7), 99), 7);
});
test("stats: too few samples gives null (Insufficient samples), never a guess", () => {
  const p = percentiles([3, 1, 2]);
  assert.deepEqual(p, { p50: null, p95: null, p99: null, samples: 3 });
  const q = percentiles(Array.from({ length: MIN_SAMPLES.p95 }, (_, i) => i));
  assert.notEqual(q.p95, null);
  assert.equal(q.p99, null);
});
test("stats: rate needs a measured interval; zero events over a real interval is a measured zero", () => {
  assert.equal(ratePerSecond(10, 0), null);
  assert.equal(ratePerSecond(0, 1000), 0);
  assert.equal(ratePerSecond(50, 500), 100);
});

// ---- collector ----
function stage(c: Collector, rovers = 1, rate = 10, t = 0) {
  c.beginStage(0, rovers, rate, t);
}
test("collector: event numbers are unique and sequential across stages", () => {
  const c = new Collector(1, 0);
  stage(c);
  const a = [c.send(1), c.send(2)];
  c.endStage(3, { notSentBackpressure: 0, measuredSubscribers: 1, eventLoopP99Ms: null, complete: true });
  c.beginStage(1, 1, 1, 3);
  const b = [c.send(4), c.send(5)];
  assert.deepEqual([...a, ...b], [0, 1, 2, 3]);
  assert.equal(new Set([...a, ...b]).size, 4);
});
test("collector: the event cap stops allocation instead of overflowing", () => {
  const c = new Collector(1, 0, 2);
  stage(c);
  assert.equal(c.send(0), 0);
  assert.equal(c.send(0), 1);
  assert.equal(c.send(0), null);
});
test("collector: ack, reject and transport are counted separately; duplicate callbacks count once", () => {
  const c = new Collector(1, 0);
  stage(c);
  const [a, b, d, e] = [c.send(0)!, c.send(0)!, c.send(0)!, c.send(0)!];
  c.ack(a, 5);
  c.ack(a, 9); // duplicate
  c.fail(b, "rejected", "Benchmark run 3 is STOPPED; writes are closed");
  c.fail(d, "transport", "socket closed");
  c.fail(a, "transport", "late"); // already acked: ignored
  const r = c.endStage(10, { notSentBackpressure: 0, measuredSubscribers: 1, eventLoopP99Ms: null, complete: true });
  assert.deepEqual([r.attempted, r.acknowledged, r.rejected, r.transportErrors, r.unresolved], [4, 1, 1, 1, 1]);
  assert.equal(r.attempted, r.acknowledged + r.rejected + r.transportErrors + r.unresolved);
  assert.equal(r.rejectionReasons["rejected: Benchmark run 3 is STOPPED; writes are closed"], 1);
  void e;
});
test("collector: latency = observation time − send time on one clock; ack latency separately", () => {
  const c = new Collector(1, 0);
  stage(c);
  for (let i = 0; i < 20; i++) {
    const no = c.send(i * 10)!;
    c.ack(no, i * 10 + 2);
    c.observe(0, no, i * 10 + 3 + (i === 19 ? 50 : 0));
  }
  const r = c.endStage(300, { notSentBackpressure: 0, measuredSubscribers: 1, eventLoopP99Ms: null, complete: true });
  assert.equal(r.ack.p50, 2);
  assert.equal(r.delivery.p50, 3);
  assert.equal(r.delivery.p95, 3); // nearest rank 19 of 20
  assert.equal(r.delivery.samples, 20);
});
test("collector: an ack is not a delivery — unobserved acked events lower delivery success", () => {
  const c = new Collector(2, 0);
  stage(c);
  const nos = Array.from({ length: 4 }, () => c.send(0)!);
  for (const n of nos) c.ack(n, 1);
  for (const n of nos) c.observe(0, n, 2); // subscriber 0 sees all
  c.observe(1, nos[0], 2); // subscriber 1 sees one
  const r = c.endStage(5, { notSentBackpressure: 0, measuredSubscribers: 2, eventLoopP99Ms: null, complete: true });
  assert.equal(r.expectedPairs, 8);
  assert.equal(r.observedPairs, 5);
  assert.equal(deliverySuccess(r), 5 / 8);
});
test("collector: observation before the ack is counted once the ack arrives", () => {
  const c = new Collector(1, 0);
  stage(c);
  const n = c.send(0)!;
  c.observe(0, n, 1);
  assert.equal(c.totalObservedPairs, 0);
  c.ack(n, 2);
  assert.equal(c.totalObservedPairs, 1);
});
test("collector: duplicates and rows never sent are flagged, not counted as deliveries", () => {
  const c = new Collector(1, 0);
  stage(c);
  const n = c.send(0)!;
  c.ack(n, 1);
  c.observe(0, n, 2);
  c.observe(0, n, 3);
  c.observe(0, 999, 3);
  const r = c.endStage(5, { notSentBackpressure: 0, measuredSubscribers: 1, eventLoopP99Ms: null, complete: true });
  assert.equal(r.observedPairs, 1);
  assert.equal(r.duplicateObservations, 1);
  assert.equal(c.unexpectedObservations, 1);
});
test("collector: delivery success is not measurable when nothing was acknowledged", () => {
  const c = new Collector(1, 0);
  stage(c);
  c.fail(c.send(0)!, "rejected", "no");
  const r = c.endStage(5, { notSentBackpressure: 0, measuredSubscribers: 1, eventLoopP99Ms: null, complete: true });
  assert.equal(deliverySuccess(r), null);
  assert.equal(r.achievedRate, null);
  assert.equal(r.delivery.p95, null);
});
test("collector: drained only when nothing is in flight and every acked event reached every subscriber", () => {
  const c = new Collector(2, 0);
  stage(c);
  const n = c.send(0)!;
  assert.equal(c.drained(), false);
  c.ack(n, 1);
  c.observe(0, n, 1);
  assert.equal(c.drained(), false);
  assert.equal(c.drained(0b01), true); // only subscriber 0 still live
  c.observe(1, n, 2);
  assert.equal(c.drained(), true);
});
test("collector: windows report acks per second over the measured window and reset", () => {
  const c = new Collector(1, 0);
  stage(c);
  for (let i = 0; i < 30; i++) {
    const no = c.send(i)!;
    c.ack(no, i + 1);
    c.observe(0, no, i + 2);
  }
  const w = c.window(500, 0);
  assert.equal(w.windowAcknowledged, 30);
  assert.equal(w.achievedRate, 60);
  assert.equal(w.deliverySamples, 30);
  assert.equal(w.deliveryP95, 2);
  const w2 = c.window(1500, 0);
  assert.equal(w2.windowAcknowledged, 0);
  assert.equal(w2.achievedRate, 0);
  assert.equal(w2.deliveryP95, null); // no samples: not measured, not zero
});
test("collector: throughput denominator never shrinks below the send phase", () => {
  const c = new Collector(1, 0);
  c.beginStage(0, 1, 1, 0);
  for (let i = 0; i < 5; i++) c.ack(c.send(i * 1000)!, i * 1000 + 1);
  const r = c.endStage(5000, { notSentBackpressure: 0, measuredSubscribers: 1, eventLoopP99Ms: null, complete: true });
  assert.equal(r.sendWindowMs, 5000);
  assert.equal(r.achievedRate, 1);
});

// ---- server-side counter parsing ----
import { parseTxnMetrics } from "../src/spacetime";
test("server metrics: sums committed/failed bench_write reducer txns for one database only", () => {
  const text = [
    'spacetime_num_txns_total{committed="true",db="aa",reducer="bench_write",txn_type="Reducer"} 120',
    'spacetime_num_txns_total{committed="true",db="aa",reducer="bench_write",txn_type="Update"} 120',
    'spacetime_num_txns_total{committed="false",db="aa",reducer="bench_write",txn_type="Reducer"} 3',
    'spacetime_num_txns_total{committed="true",db="bb",reducer="bench_write",txn_type="Reducer"} 999',
    'spacetime_num_txns_total{committed="true",db="aa",reducer="ingest_simulated_observation",txn_type="Reducer"} 7',
  ].join("\n");
  assert.deepEqual(parseTxnMetrics(text, "aa"), { committed: 120, failed: 3 });
  assert.deepEqual(parseTxnMetrics("", "aa"), { committed: 0, failed: 0 });
});
