// LIVE SpacetimeDB integration checks for the fleet benchmark (no mocks).
// Runs against the isolated verification database, never the main demo:
//   npm run db:verify:publish && npm run test:bench-live
import assert from "node:assert/strict";
import { registerAgent } from "./register-agent.mjs";
import type { DbConnection } from "../dashboard/src/module_bindings";
import { connect, classify, openSubscribers } from "../benchmark/src/spacetime";
import { connectControl, executeRun, stageTable, type BenchConfig } from "../benchmark/src/main";
import { deliverySuccess } from "../benchmark/src/collector";

const database = process.env.TEST_DATABASE || "sentinel-verification";
if (database === "sentinel") throw new Error("Use an isolated verification database, not the main demo");
const http = process.env.SPACETIME_HTTP || "http://127.0.0.1:3000";
const uri = http.replace(/^http/, "ws");
let passed = 0;
const ok = (msg: string) => {
  passed++;
  console.log(`  ✓ ${msg}`);
};
const quiet = () => {};
async function rejects(p: Promise<unknown>, re: RegExp, msg: string) {
  await assert.rejects(p, (e: Error) => re.test(e.message), msg);
  ok(msg);
}
async function sql(q: string) {
  const res = await fetch(`${http}/v1/database/${database}/sql`, { method: "POST", body: q });
  if (!res.ok) throw new Error(`SQL ${res.status}: ${await res.text()}`);
  const [{ schema, rows }] = (await res.json()) as any[];
  const names = schema.elements.map((e: any) => e.name.some);
  return rows.map((r: unknown[]) => Object.fromEntries(names.map((n: string, i: number) => [n, r[i]]))) as Record<string, any>[];
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 10000, what = "condition") {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error(`Timed out waiting for ${what}`);
    await sleep(25);
  }
}
async function subscribed(conn: DbConnection, queries: string[]) {
  await new Promise<void>((resolve, reject) =>
    conn.subscriptionBuilder().onApplied(() => resolve()).onError((c) => reject(c.event)).subscribe(queries),
  );
  return conn;
}
const latestRun = (c: DbConnection) => [...c.db.benchmarkRun.iter()].sort((a, b) => b.runId - a.runId)[0];
const stopActive = async (c: DbConnection) => {
  for (const r of c.db.benchmarkRun.iter())
    if (["REQUESTED", "RUNNING", "STOP_REQUESTED"].includes(r.state)) await c.reducers.stopBenchmarkRun({ runId: r.runId }).catch(() => {});
};

const conns: DbConnection[] = [];
try {
  console.log(`Fleet benchmark live checks against ${http}/${database}`);
  const { token } = await registerAgent({ database, server: http, label: "bench-live-test", reducer: "authorize_benchmark_runner" });
  const cfg: BenchConfig = { uri, database, token, writers: 2, maxInFlight: 1000, drainMs: 4000 };
  const browser = await subscribed(await connect({ uri, database }), [
    "SELECT * FROM benchmark_run", "SELECT * FROM benchmark_stage", "SELECT * FROM benchmark_stage_server", "SELECT * FROM benchmark_sample", "SELECT * FROM benchmark_runner",
  ]);
  conns.push(browser);
  await stopActive(browser); // leftovers from an interrupted earlier run
  const rackBefore = JSON.stringify(await sql("SELECT * FROM recent_observation"));
  const invBefore = (await sql("SELECT investigation_id FROM investigation")).length;

  console.log("Configuration and authorization");
  const fixed = { mode: "FIXED", roverCount: 50, eventsPerRoverPerSecond: 2, durationSeconds: 5, subscriberCount: 2 };
  for (const [bad, re] of [
    [{ ...fixed, roverCount: 0 }, /Rover count/],
    [{ ...fixed, roverCount: 5001 }, /Rover count/],
    [{ ...fixed, eventsPerRoverPerSecond: 11 }, /Events per rover/],
    [{ ...fixed, durationSeconds: 121 }, /Duration/],
    [{ ...fixed, mode: "RAMP", durationSeconds: 31 }, /ramp stage/],
    [{ ...fixed, subscriberCount: 5 }, /Subscriber count/],
    [{ ...fixed, mode: "BURST" }, /Mode/],
  ] as const)
    await rejects(browser.reducers.requestBenchmarkRun(bad as typeof fixed), re, `rejects unsafe config: ${re.source}`);
  await rejects(browser.reducers.registerBenchmarkRunner({ label: "intruder" }), /not an authorized benchmark runner/, "anonymous client cannot register as a runner");
  await rejects(browser.reducers.authorizeBenchmarkRunner({ runnerIdentity: "ab".repeat(32), label: "x" }), /admin/, "only the admin can authorize runners");

  const control = await connectControl(cfg, "bench-live-test");
  conns.push(control);
  await until(() => browser.db.benchmarkRunner.count() > 0, 5000, "runner presence");
  ok("runner presence is visible to the dashboard through the benchmark_runner table");

  console.log("Fixed Load (real reducer calls, real subscriptions)");
  await browser.reducers.requestBenchmarkRun(fixed);
  await until(() => latestRun(control)?.state === "REQUESTED", 5000, "run row");
  const runA = latestRun(control);
  await rejects(browser.reducers.requestBenchmarkRun(fixed), /one run at a time/, "run isolation: a second run is refused while one is active");
  await rejects(browser.reducers.claimBenchmarkRun({ runId: runA.runId, environmentJson: "{}" }), /not an authorized benchmark runner/, "a browser cannot claim a run");
  const outA = await executeRun(control, runA, cfg, { log: quiet });
  console.log(stageTable(outA.stages).replace(/^/gm, "    "));
  assert.equal(outA.state, "COMPLETED", outA.message);
  const [sA] = outA.stages;
  assert.ok(sA.attempted > 300, `attempted ${sA.attempted}`);
  assert.equal(sA.acknowledged + sA.rejected + sA.transportErrors + sA.unresolved, sA.attempted);
  assert.equal(sA.rejected, 0);
  assert.equal(sA.expectedPairs, sA.acknowledged * 2);
  ok(`${sA.attempted} attempted / ${sA.acknowledged} acknowledged / ${sA.rejected} rejected / ${sA.unresolved} unresolved — outcomes add up`);
  assert.ok(deliverySuccess(sA)! > 0.99, `delivery ${deliverySuccess(sA)}`);
  ok(`both subscribers observed ${sA.observedPairs}/${sA.expectedPairs} acknowledged (event, subscriber) pairs`);
  assert.ok(sA.delivery.p95 !== null && sA.delivery.p95 > 0 && sA.ack.p95 !== null);
  ok(`delivery P95 ${sA.delivery.p95} ms from ${sA.delivery.samples} measured samples; ack P95 ${sA.ack.p95} ms`);
  await until(() => latestRun(browser)?.state === "COMPLETED", 5000, "COMPLETED row");
  const stored = [...browser.db.benchmarkStage.iter()].filter((s) => s.runId === runA.runId);
  assert.equal(stored.length, 1);
  assert.equal(Number(stored[0].acknowledged), sA.acknowledged);
  assert.equal(Number(stored[0].attempted), sA.attempted);
  assert.equal(stored[0].deliveryP95, sA.delivery.p95);
  assert.equal(Number(stored[0].observedPairs), sA.observedPairs);
  ok("the stage row the dashboard reads equals the generator's measurements exactly");
  assert.equal(sA.serverCommitted, sA.acknowledged, "server-side committed count must equal generator acknowledgements");
  assert.equal(sA.serverFailed, 0);
  ok(`independent check: SpacetimeDB's own /v1/metrics counted ${sA.serverCommitted} committed bench_write transactions = ${sA.acknowledged} acknowledgements`);
  const samplesA = [...browser.db.benchmarkSample.iter()].filter((s) => s.runId === runA.runId);
  assert.ok(samplesA.length >= 4, `samples ${samplesA.length}`);
  assert.equal(Number(samplesA.at(-1)!.totalAcknowledged), sA.acknowledged);
  ok(`${samplesA.length} measurement windows stored; last window total equals acknowledged count`);

  console.log("Rejected writes and event isolation");
  await rejects(
    control.reducers.benchWrite({ runId: runA.runId, eventNo: 999999, roverIndex: 0, roverSeq: 0, simulatedValue: 22 }),
    /writes are closed/,
    "a write to a finished run is rejected by the database",
  );
  const rej = await browser.reducers
    .benchWrite({ runId: runA.runId, eventNo: 1, roverIndex: 0, roverSeq: 0, simulatedValue: 22 })
    .catch((e) => classify(e));
  assert.equal((rej as any)?.kind, "rejected");
  ok("a non-runner write is classified as REJECTED (SenderError), not as a transport error");
  let late = 0;
  const lateSubs = await openSubscribers({ uri, database, runId: runA.runId, count: 1 }, () => late++);
  await sleep(500);
  await lateSubs.close();
  assert.equal(late, 0);
  ok("a late subscriber receives no stored benchmark events (event table: delivered, not retained)");
  assert.equal(JSON.stringify(await sql("SELECT * FROM recent_observation")), rackBefore);
  assert.equal((await sql("SELECT investigation_id FROM investigation")).length, invBefore);
  ok("rack telemetry and investigation history are unchanged by the benchmark");

  console.log("Stop from the dashboard");
  await browser.reducers.requestBenchmarkRun({ ...fixed, durationSeconds: 60 });
  await until(() => latestRun(control)?.state === "REQUESTED", 5000, "run row");
  const runB = latestRun(control);
  const t0 = Date.now();
  const pending = executeRun(control, runB, cfg, { log: quiet });
  await until(() => latestRun(browser)?.state === "RUNNING", 5000, "RUNNING");
  await sleep(2000);
  await browser.reducers.stopBenchmarkRun({ runId: runB.runId });
  const outB = await pending;
  assert.equal(outB.state, "STOPPED");
  assert.ok(Date.now() - t0 < 15000, "stop took too long");
  await until(() => latestRun(browser)?.state === "STOPPED", 5000, "STOPPED row");
  assert.equal(outB.stages.length, 1);
  assert.equal(outB.stages[0].attempted, outB.stages[0].acknowledged + outB.stages[0].rejected + outB.stages[0].transportErrors + outB.stages[0].unresolved);
  ok(`stopped after ${((Date.now() - t0) / 1000).toFixed(1)} s; partial stage kept (${outB.stages[0].acknowledged} acknowledged), state STOPPED`);

  console.log("Runner crash recovery");
  const crashy = await connectControl(cfg, "bench-crash-test");
  await browser.reducers.requestBenchmarkRun(fixed);
  await until(() => latestRun(crashy)?.state === "REQUESTED", 5000, "run row");
  const runC = latestRun(crashy);
  await crashy.reducers.claimBenchmarkRun({ runId: runC.runId, environmentJson: "{}" });
  crashy.disconnect();
  await until(() => browser.db.benchmarkRun.runId.find(runC.runId)?.state === "FAILED", 8000, "FAILED after disconnect");
  ok("a runner that disconnects mid-run leaves the run FAILED, not stuck RUNNING");

  console.log("Ramp Test and multiple subscribers");
  await browser.reducers.requestBenchmarkRun({ mode: "RAMP", roverCount: 200, eventsPerRoverPerSecond: 1, durationSeconds: 5, subscriberCount: 3 });
  await until(() => latestRun(control)?.state === "REQUESTED", 5000, "run row");
  const runD = latestRun(control);
  const outD = await executeRun(control, runD, cfg, { log: quiet });
  console.log(stageTable(outD.stages).replace(/^/gm, "    "));
  assert.equal(outD.state, "COMPLETED", outD.message);
  assert.deepEqual(outD.stages.map((s) => s.roverCount), [1, 100, 200]);
  for (const s of outD.stages) {
    assert.equal(s.expectedPairs, s.acknowledged * 3);
    assert.ok(deliverySuccess(s)! > 0.99, `stage ${s.stageIndex} delivery ${deliverySuccess(s)}`);
    assert.equal(s.serverCommitted, s.acknowledged, `stage ${s.stageIndex} server committed`);
  }
  ok("ramp 1 → 100 → 200 rovers measured stage by stage; all three subscribers observed every acknowledged event");
  assert.equal(outD.stages[0].delivery.p95 === null, outD.stages[0].delivery.samples < 20);
  ok(`single-rover baseline: ${outD.stages[0].delivery.samples} samples → P95 ${outD.stages[0].delivery.p95 ?? "Insufficient samples"}`);
  await until(() => [...browser.db.benchmarkStage.iter()].filter((s) => s.runId === runD.runId).length === 3, 5000, "3 stage rows");
  const serverRows = [...browser.db.benchmarkStageServer.iter()].filter((r) => r.runId === runD.runId);
  assert.equal(serverRows.length, 3);
  assert.ok(serverRows.every((r) => r.committedTxns !== undefined && /v1\/metrics/.test(r.source)));
  ok("three stage rows and three server-evidence rows stored for the ramp run");

  console.log(`\nALL ${passed} FLEET BENCHMARK LIVE CHECKS PASSED`);
} catch (e) {
  console.error("\nFLEET BENCHMARK LIVE CHECK FAILED:", (e as Error).stack ?? e);
  process.exitCode = 1;
} finally {
  for (const c of conns) c.disconnect();
  setTimeout(() => process.exit(), 300).unref();
}
