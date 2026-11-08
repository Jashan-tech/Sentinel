import { useEffect, useMemo, useRef, useState } from "react";
import { useSpacetimeDB, useTable } from "spacetimedb/react";
import { DbConnection, tables } from "./module_bindings";
import Icon from "./Icon";
import {
  ACTIVE,
  chartModel,
  headline,
  latestRun,
  niceTicks,
  runPhase,
  runState,
  samplesOf,
  stageRows,
  stagesOf,
  type ChartModel,
  type ChartPoint,
} from "./benchmarkView";

const ROVERS = [1, 10, 100, 500, 1000, 2500, 5000];
const RATES = [1, 2, 5, 10];
const FIXED_SECONDS = [10, 30, 60, 120];
const STAGE_SECONDS = [5, 10, 20, 30];
const RAMP = [1, 100, 500, 1000, 2500, 5000];

export default function FleetSimulation() {
  const state = useSpacetimeDB();
  const [runs, runsReady] = useTable(tables.benchmarkRun);
  const [runners] = useTable(tables.benchmarkRunner);
  const [allStages] = useTable(tables.benchmarkStage);
  const [allSamples] = useTable(tables.benchmarkSample);
  const [serverRows] = useTable(tables.benchmarkStageServer);
  const [mode, setMode] = useState<"RAMP" | "FIXED">("RAMP");
  const [rovers, setRovers] = useState(1000);
  const [rate, setRate] = useState(1);
  const [fixedSeconds, setFixedSeconds] = useState(30);
  const [stageSeconds, setStageSeconds] = useState(10);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const run = latestRun(runs);
  const stages = run ? stagesOf(allStages, run.runId) : [];
  const samples = run ? samplesOf(allSamples, run.runId) : [];
  const active = Boolean(run && ACTIVE.includes(run.state));
  const st = runState(run);
  const metrics = headline(run, stages, samples);
  const chart = useMemo(() => chartModel(run, samples, allStages, runs), [run, samples, allStages, runs]);
  const runnerOnline = runners.length > 0;
  const plannedStages = mode === "RAMP" ? [...RAMP.filter((r) => r < rovers), rovers] : [rovers];
  const duration = mode === "RAMP" ? stageSeconds : fixedSeconds;
  const lastSample = samples.at(-1);
  const environment = (() => {
    try {
      return run ? (JSON.parse(run.environmentJson) as Record<string, string | number>) : {};
    } catch {
      return {};
    }
  })();

  async function call(action: (db: DbConnection) => Promise<void>) {
    const db = state.getConnection() as DbConnection | null;
    if (!db) return setError("Not connected to SpacetimeDB.");
    setBusy(true);
    setError("");
    try {
      await action(db);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const start = () =>
    call((db) =>
      db.reducers.requestBenchmarkRun({ mode, roverCount: rovers, eventsPerRoverPerSecond: rate, durationSeconds: duration, subscriberCount: 2 }),
    );
  const stop = () => run && call((db) => db.reducers.stopBenchmarkRun({ runId: run.runId }));

  const shown = active && run ? run : null;
  const targetRovers = shown ? (lastSample?.activeRovers ?? (shown.mode === "RAMP" ? 1 : shown.roverCount)) : (mode === "RAMP" ? 1 : rovers);
  const targetEps = shown ? shown.eventsPerRoverPerSecond : rate;

  return (
    <section className="fleet-page" aria-labelledby="fleet-title">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Scale, with evidence</span>
          <h1 id="fleet-title">Fleet Simulation</h1>
          <p>SpacetimeDB benchmark: synthetic rovers, real writes, measured delivery.</p>
        </div>
        <span className={`pill bench-state state-${st.toLowerCase()}`} data-testid="bench-state" data-state={st}>
          {st}
        </span>
      </div>

      <section className="panel fleet-config">
        <div className="panel-heading">
          <div className="title-with-icon">
            <Icon name="fleet" />
            <h2>Benchmark</h2>
          </div>
          <span className="source-tag">SIMULATED telemetry · live database</span>
        </div>
        <div className="bench-mode" role="radiogroup" aria-label="Benchmark mode">
          {(["RAMP", "FIXED"] as const).map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={mode === m}
              className={mode === m ? "selected" : ""}
              disabled={active}
              onClick={() => setMode(m)}
            >
              {m === "RAMP" ? "Ramp Test" : "Fixed Load"}
            </button>
          ))}
        </div>
        <div className="fleet-controls bench-controls">
          <label>
            {mode === "RAMP" ? "Maximum rovers" : "Virtual rovers"}
            <select aria-label="Rover count" value={rovers} disabled={active} onChange={(e) => setRovers(Number(e.target.value))}>
              {ROVERS.filter((r) => mode === "FIXED" || r >= 10).map((r) => (
                <option key={r} value={r}>
                  {r.toLocaleString()}
                </option>
              ))}
            </select>
          </label>
          <label>
            Events per rover per second
            <select aria-label="Events per rover per second" value={rate} disabled={active} onChange={(e) => setRate(Number(e.target.value))}>
              {RATES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label>
            {mode === "RAMP" ? "Seconds per stage" : "Duration (seconds)"}
            <select
              aria-label="Duration"
              value={duration}
              disabled={active}
              onChange={(e) => (mode === "RAMP" ? setStageSeconds : setFixedSeconds)(Number(e.target.value))}
            >
              {(mode === "RAMP" ? STAGE_SECONDS : FIXED_SECONDS).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="target-rate bench-target">
          <div>
            <span>Configured target rate</span>
            <strong data-testid="target-rate">
              {(targetRovers * targetEps).toLocaleString()} <small>events/sec</small>
            </strong>
            <p>
              {targetRovers.toLocaleString()} rovers × {targetEps}/s · a configuration target, not a measurement
              {!shown && mode === "RAMP" && <> · stages {plannedStages.map((s) => s.toLocaleString()).join(" → ")}</>}
            </p>
          </div>
          <div>
            <span>Actual achieved rate</span>
            <strong data-testid="achieved-rate" className={lastSample?.achievedRate === undefined || !shown ? "unmeasured" : ""}>
              {shown && lastSample?.achievedRate !== undefined ? (
                <>
                  {Math.round(lastSample.achievedRate).toLocaleString()} <small>events/sec</small>
                </>
              ) : (
                "Not measured"
              )}
            </strong>
            <p>{shown ? "Acknowledged writes, latest ~1 s window" : "Measured only while a run is active"}</p>
          </div>
        </div>
        <div className="action-row">
          <button className="primary-button" onClick={start} disabled={busy || active || !runnerOnline || !state.isActive || !runsReady}>
            Start {mode === "RAMP" ? "Ramp Test" : "Fixed Load"} <Icon name="arrow" size={16} />
          </button>
          <button onClick={stop} disabled={busy || !active}>
            Stop
          </button>
        </div>
        <ul className="bench-status" aria-label="Measurement availability">
          <li data-testid="runner-status" className={runnerOnline ? "ok" : "warn"}>
            {runnerOnline ? (
              <>Load generator connected ({runners.length})</>
            ) : (
              <>
                No load generator connected. Start it with <code>npm run bench:runner</code>
              </>
            )}
          </li>
          {run && (
            <li data-testid="run-phase">
              Run #{run.runId} · {run.mode === "RAMP" ? "Ramp Test" : "Fixed Load"} · {runPhase(run)}
            </li>
          )}
          {error && (
            <li className="error" role="alert">
              {error}
            </li>
          )}
        </ul>
      </section>

      <div className="bench-metrics" aria-label="Measured benchmark metrics" data-testid="bench-metrics">
        {metrics.map((m) => (
          <div className="panel benchmark" key={m.label} data-metric={m.label} data-measured={m.measured}>
            <span>{m.label}</span>
            <strong className={m.measured ? "" : "unmeasured"}>
              {m.value} {m.unit && <small>{m.unit}</small>}
            </strong>
            <small>{m.source}</small>
          </div>
        ))}
      </div>

      <section className="panel bench-chart-panel">
        <div className="panel-heading">
          <h2>Single Rover vs Fleet — P95 Latency</h2>
          <span className="source-tag">write sent → subscriber received · ms</span>
        </div>
        <LatencyChart model={chart} />
      </section>

      {run && (
        <details className="panel bench-details" data-testid="bench-details">
          <summary>Detailed benchmark results · run #{run.runId}</summary>
          {(stages.length > 0 || lastSample) && (
            <ul className="bench-counters">
              {lastSample && (
                <>
                  <li>Attempted writes <b>{Number(lastSample.totalAttempted).toLocaleString()}</b></li>
                  <li>Acknowledged <b>{Number(lastSample.totalAcknowledged).toLocaleString()}</b></li>
                  <li>Subscriber-observed pairs <b>{Number(lastSample.totalObservedPairs).toLocaleString()}</b></li>
                  <li>Rejected <b>{Number(lastSample.totalRejected).toLocaleString()}</b></li>
                  <li>Transport errors <b>{Number(lastSample.totalTransportErrors).toLocaleString()}</b></li>
                  <li>In flight at last window <b>{lastSample.inFlight.toLocaleString()}</b></li>
                </>
              )}
            </ul>
          )}
          {stages.length ? (
            <div className="table-scroll">
              <table className="bench-table">
                <thead>
                  <tr>
                    <th>Stage</th><th>Rovers</th><th>Target/s</th><th>Achieved/s</th><th>Attempted</th><th>Acked</th><th>Server committed</th>
                    <th>Observed / expected</th><th>Delivered</th><th>Rejected</th><th>Transport</th><th>Unresolved</th>
                    <th>Skipped (backpressure)</th><th>P50 ms</th><th>P95 ms</th><th>P99 ms</th><th>Ack P95 ms</th>
                    <th>Latency samples</th><th>Generator loop P99 ms</th>
                  </tr>
                </thead>
                <tbody>
                  {stageRows(stages, serverRows).map((r) => (
                    <tr key={r.key}>
                      <td>{r.stage}</td><td>{r.rovers}</td><td>{r.target}</td><td>{r.achieved}</td><td>{r.attempted}</td>
                      <td>{r.acknowledged}</td><td>{r.serverCommitted}</td><td>{r.observed}</td><td>{r.delivered}</td><td>{r.rejected}</td><td>{r.transport}</td>
                      <td>{r.unresolved}</td><td>{r.skipped}</td><td>{r.p50}</td><td>{r.p95}</td><td>{r.p99}</td><td>{r.ackP95}</td>
                      <td>{r.samples}</td><td>{r.loopP99}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="quiet-note">No stage has finished yet. Stage results appear after each stage drains.</p>
          )}
          {run.message && <p className="bench-message">Runner: {run.message}</p>}
          {Object.keys(environment).length > 0 && (
            <p className="bench-env">
              Environment: {Object.entries(environment).map(([k, v]) => `${k} ${v}`).join(" · ")}
            </p>
          )}
          <p className="bench-method">
            Method: an external Node.js generator issues one <code>bench_write</code> reducer call per SIMULATED event over
            {" "}{String(environment.writerConnections ?? "several")} writer connections. <b>Acknowledged</b> = the reducer call
            returned Ok. <b>Server committed</b> = the change in SpacetimeDB's own <code>/v1/metrics</code> transaction
            counter for <code>bench_write</code> over the stage, an independent server-side count. <b>Observed</b> = a separate subscriber connection received the row through its
            subscription. Latency = subscriber receipt − send time, both on the generator's monotonic clock. Percentiles are
            nearest-rank over measured samples (P95 needs ≥ 20, P99 ≥ 100). Delivery success counts only drained stages.
          </p>
        </details>
      )}
      <p className="quiet-note">
        Synthetic rovers and SIMULATED readings only. No physical rover is controlled. Benchmark events go to an isolated
        event table and never touch rack telemetry or investigations.
      </p>
    </section>
  );
}

const PAD = { l: 44, r: 12, t: 22, b: 28 };

/** Track the container's pixel width so the SVG is drawn 1:1 and text stays 10-11 px at any size. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(720);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

function LatencyChart({ model }: { model: ChartModel }) {
  const [hover, setHover] = useState<ChartPoint | null>(null);
  const [ref, W] = useWidth<HTMLDivElement>();
  const H = W < 520 ? 220 : 280;
  const all = [...model.baseline.flat(), ...model.fleet.flat()];
  if (!all.length && !model.baselineRef)
    return (
      <div ref={ref} data-testid="latency-chart" data-points={0}>
        <p className="chart-empty" data-testid="chart-empty">
          {model.gaps > 0 ? "Insufficient samples for a P95 in any window yet." : "No latency samples measured. Start a benchmark to measure."}
        </p>
      </div>
    );
  const yTicks = niceTicks(model.yMax * 1.1 || 1);
  const yMax = yTicks.at(-1)!;
  const xMax = Math.max(model.xMax, 1);
  const xTicks = niceTicks(xMax, W < 520 ? 3 : 6).filter((t) => t <= xMax);
  const sx = (x: number) => PAD.l + (x / xMax) * (W - PAD.l - PAD.r);
  const sy = (y: number) => H - PAD.b - (y / yMax) * (H - PAD.t - PAD.b);
  const path = (seg: ChartPoint[]) => seg.map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join("");
  const nearest = (clientX: number, rect: DOMRect) => {
    const x = ((clientX - rect.left) / rect.width) * W;
    let best: ChartPoint | null = null;
    for (const p of all) if (!best || Math.abs(sx(p.x) - x) < Math.abs(sx(best.x) - x)) best = p;
    setHover(best);
  };
  const isBase = (p: ChartPoint) => model.baseline.some((s) => s.includes(p));
  return (
    <div className="bench-chart" data-testid="latency-chart" data-points={all.length} ref={ref}>
      <div className="chart-legend">
        <span><i className="swatch fleet" />Fleet (measured, per ~1 s window)</span>
        {model.baseline.length > 0 && <span><i className="swatch baseline" />Single rover (measured)</span>}
        {model.baselineRef && <span><i className="swatch baseline dashed" />{model.baselineRef.label}: {model.baselineRef.p95.toFixed(1)} ms</span>}
        {model.baselineRef && !model.baseline.length && model.baselineRef.label.includes("this run") && (
          <span className="muted">Single-rover ~1 s windows had too few samples for a P95; the dashed line uses all samples in that stage</span>
        )}
        {!model.baselineRef && !model.baseline.length && <span className="muted">No single-rover baseline measured yet: run a Ramp Test</span>}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        role="img"
        aria-label="P95 delivery latency over benchmark time"
        onMouseMove={(e) => nearest(e.clientX, e.currentTarget.getBoundingClientRect())}
        onMouseLeave={() => setHover(null)}
      >
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={sy(t)} y2={sy(t)} className="grid" />
            <text x={PAD.l - 8} y={sy(t) + 4} className="tick" textAnchor="end">{t}</text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text key={t} x={sx(t)} y={H - 12} className="tick" textAnchor="middle">{t}s</text>
        ))}
        {model.stageMarks.map((m) => (
          <g key={m.rovers}>
            <line x1={sx(Math.max(0, m.x))} x2={sx(Math.max(0, m.x))} y1={PAD.t} y2={H - PAD.b} className="stage-mark" />
            <text x={sx(Math.max(0, m.x)) + 4} y={PAD.t - 8} className="tick">{m.rovers.toLocaleString()}{W < 520 ? "" : " rovers"}</text>
          </g>
        ))}
        {model.baselineRef && (
          <line x1={PAD.l} x2={W - PAD.r} y1={sy(model.baselineRef.p95)} y2={sy(model.baselineRef.p95)} className="ref-line" />
        )}
        {model.baseline.map((seg, i) => <path key={`b${i}`} d={path(seg)} className="series baseline" />)}
        {model.fleet.map((seg, i) => <path key={`f${i}`} d={path(seg)} className="series fleet" />)}
        {all.map((p) => (
          <circle key={`${p.x}-${p.stage}`} cx={sx(p.x)} cy={sy(p.y)} r={hover === p ? 5 : 3} className={`dot ${isBase(p) ? "baseline" : "fleet"}`} />
        ))}
        {hover && <line x1={sx(hover.x)} x2={sx(hover.x)} y1={PAD.t} y2={H - PAD.b} className="crosshair" />}
      </svg>
      <p className="chart-tooltip" aria-live="polite">
        {hover
          ? `${hover.x.toFixed(1)} s · ${hover.rovers.toLocaleString()} rovers · P95 ${hover.y.toFixed(1)} ms from ${hover.samples.toLocaleString()} samples`
          : `${all.length} measured windows${model.gaps ? ` · ${model.gaps} window(s) with insufficient samples left blank` : ""}. Hover for values.`}
      </p>
    </div>
  );
}
