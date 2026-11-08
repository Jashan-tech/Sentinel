// SENTINEL fleet benchmark — external load generator (Node.js, outside the browser).
//
//   npm run bench:runner                         serve dashboard Start/Stop requests
//   npm run bench -- --mode fixed --rovers 100 --eps 1 --duration 10
//   npm run bench -- --mode ramp --rovers 1000 --eps 1 --duration 10   (duration = seconds per stage)
//
// Credentials: benchmark/.env (written by `npm run bench:register`, git-ignored). The token is never printed.
import { existsSync, readFileSync } from "node:fs";
import { cpus, platform, release } from "node:os";
import { fileURLToPath } from "node:url";
import type { DbConnection } from "../../dashboard/src/module_bindings";
import { deliverySuccess, type StageResult } from "./collector";
import { planStages } from "./plan";
import { runBenchmark, type RunOutcome } from "./runner";
import { connect, makeReporter, makeWriter, openSubscribers, serverTxnCounter } from "./spacetime";

export interface BenchConfig {
  uri: string;
  database: string;
  token: string;
  writers: number;
  maxInFlight: number;
  drainMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BenchConfig {
  const file = fileURLToPath(new URL("../.env", import.meta.url));
  const fromFile: Record<string, string> = {};
  if (existsSync(file))
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) fromFile[m[1]] = m[2];
    }
  const get = (k: string, d = "") => env[k] ?? fromFile[k] ?? d;
  const token = get("BENCH_SPACETIME_TOKEN");
  if (!token) throw new Error("No benchmark runner token. Run once: npm run bench:register");
  const int = (k: string, d: number, lo: number, hi: number) => {
    const v = Number(get(k, String(d)));
    if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${k} must be an integer ${lo}-${hi}`);
    return v;
  };
  return {
    uri: get("BENCH_SPACETIME_URL", "ws://127.0.0.1:3000"),
    database: get("BENCH_SPACETIME_DATABASE", "sentinel"),
    token,
    writers: int("BENCH_WRITERS", 4, 1, 16),
    maxInFlight: int("BENCH_MAX_IN_FLIGHT", 2000, 10, 20000),
    drainMs: int("BENCH_DRAIN_MS", 5000, 500, 30000),
  };
}

type RunRow = NonNullable<ReturnType<DbConnection["db"]["benchmarkRun"]["runId"]["find"]>>;

/** Claim a REQUESTED run and execute it with real connections. Always finishes the run row. */
export async function executeRun(
  control: DbConnection,
  run: RunRow,
  cfg: BenchConfig,
  opts: { signal?: AbortSignal; log?: (m: string) => void } = {},
): Promise<RunOutcome> {
  const log = opts.log ?? console.log;
  const stages = planStages({ ...run });
  const environment = {
    workload: "append-only SIMULATED event stream (event table benchmark_event)",
    node: process.version,
    platform: `${platform()} ${release()}`,
    cpus: cpus().length,
    writerConnections: cfg.writers,
    subscriberConnections: run.subscriberCount,
    maxInFlight: cfg.maxInFlight,
    clock: "performance.now() in the generator process (writers and subscribers share it)",
  };
  await control.reducers.claimBenchmarkRun({ runId: run.runId, environmentJson: JSON.stringify(environment) });
  log(`run ${run.runId} claimed: ${run.mode}, ${stages.map((s) => s.rovers).join(" → ")} rovers, ${run.eventsPerRoverPerSecond}/rover/s`);
  const writers: DbConnection[] = [];
  let outcome: RunOutcome;
  try {
    for (let i = 0; i < cfg.writers; i++) writers.push(await connect({ uri: cfg.uri, database: cfg.database, token: cfg.token, light: true }));
    outcome = await runBenchmark({
      runId: run.runId,
      stages,
      subscribers: run.subscriberCount,
      writers: writers.map(makeWriter),
      openSubscribers: (onObserve) =>
        openSubscribers({ uri: cfg.uri, database: cfg.database, runId: run.runId, count: run.subscriberCount }, onObserve),
      reporter: makeReporter(control, run.runId),
      serverCounts: await serverTxnCounter(cfg.uri.replace(/^ws/, "http"), cfg.database),
      stopRequested: () => control.db.benchmarkRun.runId.find(run.runId)?.state === "STOP_REQUESTED",
      signal: opts.signal,
      maxInFlight: cfg.maxInFlight,
      drainMs: cfg.drainMs,
      log,
    });
  } catch (e) {
    outcome = { state: "FAILED", message: `Runner error: ${(e as Error).message}`, stages: [], samples: 0, unexpectedObservations: 0 };
  } finally {
    for (const w of writers) w.disconnect();
  }
  try {
    await control.reducers.finishBenchmarkRun({ runId: run.runId, state: outcome.state, message: outcome.message });
  } catch (e) {
    log(`could not record the run's final state: ${(e as Error).message}`);
  }
  log(`run ${run.runId} ${outcome.state}: ${outcome.message}`);
  return outcome;
}

export async function connectControl(cfg: BenchConfig, label: string): Promise<DbConnection> {
  const control = await connect({ uri: cfg.uri, database: cfg.database, token: cfg.token });
  await new Promise<void>((resolve, reject) =>
    control
      .subscriptionBuilder()
      .onApplied(() => resolve())
      .onError((ctx) => reject(ctx.event ?? new Error("Control subscription rejected")))
      .subscribe(["SELECT * FROM benchmark_run", "SELECT * FROM benchmark_runner", "SELECT * FROM benchmark_stage"]),
  );
  await control.reducers.registerBenchmarkRunner({ label });
  return control;
}

/** Long-running service: executes runs requested from the dashboard, one at a time. */
async function serve(cfg: BenchConfig) {
  const control = await connectControl(cfg, "fleet-benchmark-runner");
  console.log(`benchmark runner connected to ${cfg.uri}/${cfg.database}; waiting for runs requested from the dashboard`);
  const abort = new AbortController();
  let busy = false;
  const pick = async () => {
    if (busy) return;
    const next = [...control.db.benchmarkRun.iter()].filter((r) => r.state === "REQUESTED").sort((a, b) => a.runId - b.runId)[0];
    if (!next) return;
    busy = true;
    try {
      await executeRun(control, next, cfg, { signal: abort.signal });
    } catch (e) {
      console.error(`run ${next.runId} could not start: ${(e as Error).message}`);
    } finally {
      busy = false;
      if (!abort.signal.aborted) void pick();
    }
  };
  control.db.benchmarkRun.onInsert(() => void pick());
  control.db.benchmarkRun.onUpdate(() => void pick());
  void pick();
  await new Promise<void>((resolve) => {
    const stop = () => {
      console.log("shutting down: stopping any active run");
      abort.abort();
      const wait = setInterval(() => {
        if (!busy) {
          clearInterval(wait);
          control.disconnect();
          resolve();
        }
      }, 100);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function fmt(v: number | null | undefined, unit = "", digits = 1) {
  return v === null || v === undefined ? "Not measured" : `${v.toFixed(digits)}${unit}`;
}

export function stageTable(stages: StageResult[]): string {
  const rows = stages.map((r) => {
    const ds = deliverySuccess(r);
    return [
      r.stageIndex, r.roverCount, r.targetRate, fmt(r.achievedRate, "/s"), r.attempted, r.acknowledged, r.rejected,
      r.transportErrors, r.unresolved, r.notSentBackpressure, ds === null ? "Not measured" : `${(ds * 100).toFixed(2)}%`,
      r.delivery.p50 ?? "insufficient", r.delivery.p95 ?? "insufficient", r.delivery.p99 ?? "insufficient",
      r.ack.p95 ?? "insufficient", fmt(r.eventLoopP99Ms, " ms"), r.serverCommitted ?? "Not measured",
    ].join("\t");
  });
  return [
    "stage\trovers\ttarget/s\tachieved\tattempted\tacked\trejected\ttransport\tunresolved\tskipped(bp)\tdelivered\tdel p50\tdel p95\tdel p99\tack p95\tloop p99\tserver committed",
    ...rows,
  ].join("\n");
}

/** One-shot run from the command line; prints the measured results. */
async function once(cfg: BenchConfig, args: Record<string, string>) {
  const mode = (args.mode ?? "fixed").toUpperCase();
  const req = {
    mode,
    roverCount: Number(args.rovers ?? (mode === "RAMP" ? 1000 : 100)),
    eventsPerRoverPerSecond: Number(args.eps ?? 1),
    durationSeconds: Number(args.duration ?? 10),
    subscriberCount: Number(args.subscribers ?? 2),
  };
  planStages(req); // validates before touching the database
  const control = await connectControl(cfg, "fleet-benchmark-cli");
  const abort = new AbortController();
  process.once("SIGINT", () => abort.abort());
  try {
    const before = new Set([...control.db.benchmarkRun.iter()].map((r) => r.runId));
    await control.reducers.requestBenchmarkRun(req);
    const run = [...control.db.benchmarkRun.iter()].find((r) => !before.has(r.runId) && r.state === "REQUESTED");
    if (!run) throw new Error("The requested run was not visible (another runner may have claimed it)");
    const out = await executeRun(control, run, cfg, { signal: abort.signal });
    console.log(`\nMeasured results for run ${run.runId} (${mode}, live SpacetimeDB at ${cfg.uri}/${cfg.database}):`);
    console.log(stageTable(out.stages));
    // Cross-check: what the database stored is what was measured.
    await new Promise((r) => setTimeout(r, 300));
    const stored = [...control.db.benchmarkStage.iter()].filter((s) => s.runId === run.runId);
    console.log(`\nStored stage rows in SpacetimeDB: ${stored.length}/${out.stages.length}`);
    if (out.state === "FAILED") process.exitCode = 1;
  } finally {
    control.disconnect();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") ? "true" : (argv[++i] ?? "true");
  try {
    const cfg = loadConfig();
    if (args.serve) await serve(cfg);
    else await once(cfg, args);
  } catch (e) {
    console.error(`benchmark error: ${(e as Error).message}`);
    process.exitCode = 1;
  }
  setTimeout(() => process.exit(), 200).unref();
}
