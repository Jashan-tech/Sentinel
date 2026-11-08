// UNIT tests for orchestration with a SCRIPTED transport (in-memory writers and subscribers).
// These verify control flow and accounting only; they are not benchmark results.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runBenchmark, WriteError, type BenchEvent, type Reporter, type RunOptions } from "../src/runner";
import { planStages } from "../src/plan";

type Observe = (s: number, no: number, at: number) => void;

function scripted(opts: {
  subscribers?: number;
  reject?: (ev: BenchEvent) => string | null;
  transport?: (ev: BenchEvent) => boolean;
  hang?: boolean;
  deliverTo?: (ev: BenchEvent, s: number) => boolean;
  connectOnly?: number;
}) {
  const subs = opts.subscribers ?? 2;
  let observe: Observe = () => {};
  const samples: unknown[] = [];
  const stages: unknown[] = [];
  const written: BenchEvent[] = [];
  const reporter: Reporter = {
    sample: async (s) => void samples.push(s),
    stage: async (r) => void stages.push(r),
  };
  const writer = {
    write: (ev: BenchEvent) =>
      new Promise<void>((resolve, reject) => {
        written.push(ev);
        if (opts.hang) return;
        const why = opts.reject?.(ev);
        if (why) return setTimeout(() => reject(new WriteError("rejected", why)), 1);
        if (opts.transport?.(ev)) return setTimeout(() => reject(new WriteError("transport", "socket closed")), 1);
        setTimeout(() => {
          for (let s = 0; s < subs; s++) if (opts.deliverTo?.(ev, s) ?? true) observe(s, ev.eventNo, performance.now());
          resolve();
        }, 1);
      }),
  };
  const mask = opts.connectOnly ?? (1 << subs) - 1;
  const base = {
    runId: 7,
    subscribers: subs,
    writers: [writer, writer],
    openSubscribers: async (o: Observe) => {
      observe = o;
      return { activeMask: () => mask, close: async () => {} };
    },
    reporter,
    stopRequested: () => false,
    windowMs: 100,
    drainMs: 300,
  } satisfies Partial<RunOptions>;
  return { base, samples, stages, written };
}
const req = { mode: "FIXED", roverCount: 20, eventsPerRoverPerSecond: 10, durationSeconds: 5, subscriberCount: 2 };
const short = (r = req, ms = 400) => planStages(r).map((s) => ({ ...s, durationMs: ms }));

test("runner: fixed load sends at the target, every event acknowledged and delivered to both subscribers", async () => {
  const { base, written, stages, samples } = scripted({});
  const out = await runBenchmark({ ...base, stages: short() });
  assert.equal(out.state, "COMPLETED");
  const [s] = out.stages;
  assert.ok(s.attempted >= 70 && s.attempted <= 81, `attempted ${s.attempted}`); // 200/s × 0.4 s
  assert.equal(s.acknowledged, s.attempted);
  assert.equal(s.observedPairs, s.expectedPairs);
  assert.equal(new Set(written.map((w) => w.eventNo)).size, written.length); // unique ids
  assert.ok(written.every((w) => w.runId === 7 && w.roverIndex < 20));
  assert.equal(stages.length, 1);
  assert.ok(samples.length >= 3);
});
test("runner: rejected writes are counted as rejected with their reason", async () => {
  const { base } = scripted({ reject: (ev) => (ev.eventNo % 4 === 0 ? "Simulated value out of range" : null) });
  const out = await runBenchmark({ ...base, stages: short() });
  const [s] = out.stages;
  assert.ok(s.rejected > 0);
  assert.equal(s.acknowledged + s.rejected, s.attempted);
  assert.equal(s.rejectionReasons["rejected: Simulated value out of range"], s.rejected);
  assert.equal(s.expectedPairs, s.acknowledged * 2); // rejected events are not expected deliveries
});
test("runner: transport errors are not counted as rejections or acknowledgements", async () => {
  const { base } = scripted({ transport: (ev) => ev.eventNo % 5 === 0 });
  const [s] = (await runBenchmark({ ...base, stages: short() })).stages;
  assert.ok(s.transportErrors > 0);
  assert.equal(s.rejected, 0);
  assert.equal(s.acknowledged + s.transportErrors, s.attempted);
});
test("runner: a hung database fills the bounded window, then skips (backpressure) and reports unresolved", async () => {
  const { base } = scripted({ hang: true });
  const out = await runBenchmark({ ...base, stages: short(), maxInFlight: 25 });
  const [s] = out.stages;
  assert.equal(s.attempted, 25);
  assert.equal(s.unresolved, 25);
  assert.equal(s.acknowledged, 0);
  assert.ok(s.notSentBackpressure > 40);
  assert.equal(s.achievedRate, null);
  assert.equal(s.delivery.p95, null);
});
test("runner: missing deliveries lower delivery success; they are never filled in", async () => {
  const { base } = scripted({ deliverTo: (ev, s) => s === 0 || ev.eventNo % 2 === 0 });
  const [s] = (await runBenchmark({ ...base, stages: short() })).stages;
  assert.ok(s.observedPairs < s.expectedPairs);
  assert.ok(Math.abs(s.observedPairs / s.expectedPairs - 0.75) < 0.05);
});
test("runner: stop requested through the database ends the run as STOPPED with the partial stage", async () => {
  const { base } = scripted({});
  let stop = false;
  setTimeout(() => (stop = true), 150);
  const t0 = performance.now();
  const out = await runBenchmark({ ...base, stages: short(req, 5000), stopRequested: () => stop });
  assert.equal(out.state, "STOPPED");
  assert.ok(performance.now() - t0 < 2000);
  assert.equal(out.stages.length, 1);
  assert.equal(out.stages[0].complete, false);
  assert.ok(out.stages[0].attempted > 0);
});
test("runner: abort signal (Ctrl+C) cancels cleanly and skips remaining ramp stages", async () => {
  const { base } = scripted({});
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 150);
  const out = await runBenchmark({ ...base, stages: short({ ...req, mode: "RAMP", roverCount: 500 }, 1000), signal: ac.signal });
  assert.equal(out.state, "STOPPED");
  assert.equal(out.stages.length, 1);
});
test("runner: ramp measures stages in order with separate results", async () => {
  const { base } = scripted({ subscribers: 3 });
  const out = await runBenchmark({ ...base, subscribers: 3, stages: short({ ...req, mode: "RAMP", roverCount: 100, eventsPerRoverPerSecond: 1 }, 300) });
  assert.equal(out.state, "COMPLETED");
  assert.deepEqual(out.stages.map((s) => s.roverCount), [1, 100]);
  for (const s of out.stages) assert.equal(s.expectedPairs, s.acknowledged * 3);
  assert.ok(out.stages[0].attempted < out.stages[1].attempted);
});
test("runner: refuses to send anything unless every subscriber connected", async () => {
  const { base, written } = scripted({ connectOnly: 0b01 });
  const out = await runBenchmark({ ...base, stages: short() });
  assert.equal(out.state, "FAILED");
  assert.equal(written.length, 0);
});
test("runner: run ceiling stops the run", async () => {
  const { base } = scripted({});
  const out = await runBenchmark({ ...base, stages: short(req, 5000), maxRunMs: 200 });
  assert.equal(out.state, "STOPPED");
  assert.match(out.message, /ceiling/);
});
test("runner: a stage sends exactly rate × duration events (no extra at the boundary, none missing)", async () => {
  for (const [eps, ms] of [[2, 500], [7, 300]] as const) {
    const { base } = scripted({});
    const out = await runBenchmark({ ...base, stages: [{ index: 0, rovers: 10, eventsPerRoverPerSecond: eps, targetRate: 10 * eps, durationMs: ms }] });
    assert.equal(out.stages[0].attempted, (10 * eps * ms) / 1000 - ((10 * eps * ms) % 1000) / 1000);
  }
});
