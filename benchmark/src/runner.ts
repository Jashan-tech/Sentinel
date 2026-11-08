// Benchmark orchestration: stages, open-loop rate control, bounded in-flight window,
// drain, measurement windows, stop/cancel and clean shutdown.
// Transport-agnostic: the live runner plugs in real SpacetimeDB connections (spacetime.ts);
// unit tests plug in a scripted transport. Scripted results are never reported as live.
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { Collector, type StageResult, type WindowSample } from "./collector";
import { RateController, RoverCursor } from "./rate";
import { simulatedValue, type StagePlan } from "./plan";

export interface BenchEvent {
  runId: number;
  eventNo: number;
  roverIndex: number;
  roverSeq: number;
  simulatedValue: number;
}

/** A failed write. `rejected` = the database refused it; `transport` = anything else. */
export class WriteError extends Error {
  constructor(
    readonly kind: "rejected" | "transport",
    message: string,
  ) {
    super(message);
  }
}

export interface Writer {
  /** Resolves only when the database acknowledges the committed write. */
  write(ev: BenchEvent): Promise<void>;
}

export interface SubscriberSet {
  /** Bitmask of subscribers whose subscription is applied and whose connection is live. */
  activeMask(): number;
  close(): Promise<void>;
}

export interface Reporter {
  sample(s: WindowSample & { activeRovers: number; activeSubscribers: number; targetRate: number }): Promise<void>;
  stage(r: StageResult): Promise<void>;
}

export interface RunOptions {
  runId: number;
  stages: StagePlan[];
  subscribers: number;
  writers: Writer[];
  /** Opens the subscriber connections; must call onObserve(subscriber, eventNo, monotonicMs) per row. */
  openSubscribers(onObserve: (subscriber: number, eventNo: number, atMs: number) => void): Promise<SubscriberSet>;
  reporter: Reporter;
  /**
   * Optional independent server-side counter (SpacetimeDB /v1/metrics). Read before a stage's
   * first send and after its drain; the difference is stored next to the generator's counts.
   */
  serverCounts?: () => Promise<{ committed: number; failed: number } | null>;
  /** Polled every tick: true when a stop was requested through the database. */
  stopRequested(): boolean;
  signal?: AbortSignal;
  maxInFlight?: number;
  windowMs?: number;
  drainMs?: number;
  maxRunMs?: number;
  maxEvents?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface RunOutcome {
  state: "COMPLETED" | "STOPPED" | "FAILED";
  message: string;
  stages: StageResult[];
  samples: number;
  unexpectedObservations: number;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 1));
const bits = (m: number) => m.toString(2).replace(/0/g, "").length;

export async function runBenchmark(o: RunOptions): Promise<RunOutcome> {
  const now = o.now ?? (() => performance.now());
  const maxInFlight = o.maxInFlight ?? 2000;
  const windowMs = o.windowMs ?? 1000;
  const drainMs = o.drainMs ?? 5000;
  const maxRunMs = o.maxRunMs ?? 300_000;
  const log = o.log ?? (() => {});
  if (!o.writers.length) throw new Error("at least one writer is required");

  const runStart = now();
  const c = new Collector(o.subscribers, runStart, o.maxEvents);
  const subs = await o.openSubscribers((s, no, at) => c.observe(s, no, at));
  const fullMask = (1 << o.subscribers) - 1;
  if (subs.activeMask() !== fullMask) {
    await subs.close();
    return { state: "FAILED", message: "Not every benchmark subscriber connected; nothing was sent", stages: [], samples: 0, unexpectedObservations: 0 };
  }
  const reports: Promise<unknown>[] = [];
  let reportErrors = 0;
  const report = (p: Promise<void>) => reports.push(p.catch((e) => { reportErrors++; log(`report failed: ${(e as Error).message}`); }));

  const results: StageResult[] = [];
  let samples = 0;
  let stopReason: { state: RunOutcome["state"]; message: string } | null = null;
  const checkStop = () => {
    if (stopReason) return true;
    if (o.signal?.aborted) stopReason = { state: "STOPPED", message: "Cancelled by the operator (signal)" };
    else if (o.stopRequested()) stopReason = { state: "STOPPED", message: "Stopped from the dashboard" };
    else if (now() - runStart > maxRunMs) stopReason = { state: "STOPPED", message: `Hit the ${maxRunMs / 1000} s run ceiling` };
    else if (subs.activeMask() === 0) stopReason = { state: "FAILED", message: "All benchmark subscribers disconnected" };
    return Boolean(stopReason);
  };

  let writerIdx = 0;
  for (const stage of o.stages) {
    if (checkStop()) break;
    const serverBefore = (await o.serverCounts?.().catch(() => null)) ?? null;
    const loop = monitorEventLoopDelay({ resolution: 1 });
    loop.enable();
    const stageStart = now();
    c.beginStage(stage.index, stage.rovers, stage.targetRate, stageStart);
    const maskAtStart = subs.activeMask();
    const rate = new RateController(stage.targetRate, stageStart);
    const rovers = new RoverCursor(stage.rovers);
    let windowEnd = stageStart + windowMs;
    let capped = false;
    log(`stage ${stage.index}: ${stage.rovers} rovers × ${stage.eventsPerRoverPerSecond}/s = target ${stage.targetRate}/s for ${stage.durationMs} ms`);

    const emitWindow = (t: number) => {
      const w = c.window(t, stage.index);
      samples++;
      report(o.reporter.sample({ ...w, activeRovers: stage.rovers, activeSubscribers: bits(subs.activeMask()), targetRate: stage.targetRate }));
    };

    // The schedule never runs past the stage end: event k is due at k / rate, k < rate × duration.
    const stageEnd = stageStart + stage.durationMs;
    const lastDue = stageEnd - 1e-6;
    const issue = (t: number) => {
      const n = rate.take(Math.min(t, lastDue), maxInFlight - c.inFlight);
      for (let k = 0; k < n; k++) {
        const sentAt = now();
        const no = c.send(sentAt);
        if (no === null) {
          capped = true;
          return;
        }
        const { roverIndex, roverSeq } = rovers.take();
        const w = o.writers[writerIdx++ % o.writers.length];
        w.write({ runId: o.runId, eventNo: no, roverIndex, roverSeq, simulatedValue: simulatedValue(roverIndex, roverSeq) }).then(
          () => c.ack(no, now()),
          (e: unknown) => c.fail(no, e instanceof WriteError ? e.kind : "transport", (e as Error)?.message ?? String(e)),
        );
      }
    };
    while (now() < stageEnd && !checkStop() && !capped) {
      issue(now());
      if (now() >= windowEnd) {
        emitWindow(now());
        windowEnd += windowMs;
      }
      await tick();
    }
    // Events whose due time fell inside the stage but after the last tick (timer granularity).
    if (!stopReason && !capped) issue(lastDue);
    if (capped && !stopReason) stopReason = { state: "STOPPED", message: `Reached the ${c.eventCount.toLocaleString()} event safety cap` };

    // Drain: no new sends; wait for outstanding acks and subscriber deliveries (bounded).
    c.closeSends(now());
    const drainStart = now();
    const drainLimit = stopReason ? Math.min(drainMs, 3000) : drainMs;
    while (!c.drained(subs.activeMask() & maskAtStart) && now() - drainStart < drainLimit) {
      if (now() >= windowEnd) {
        emitWindow(now());
        windowEnd += windowMs;
      }
      await tick();
    }
    const end = now();
    if (end - (windowEnd - windowMs) > 0) emitWindow(end); // final partial window of the stage
    loop.disable();
    const p99 = loop.count > 0 ? Math.round((loop.percentile(99) / 1e6) * 1000) / 1000 : null;
    const live = subs.activeMask() & maskAtStart;
    const r = c.endStage(end, {
      notSentBackpressure: rate.notSentBackpressure,
      measuredSubscribers: bits(live),
      eventLoopP99Ms: p99,
      complete: !stopReason,
    });
    if (serverBefore) {
      await new Promise((res) => setTimeout(res, 250)); // let the server publish its counters
      const after = await o.serverCounts!().catch(() => null);
      if (after) {
        r.serverCommitted = after.committed - serverBefore.committed;
        r.serverFailed = after.failed - serverBefore.failed;
      }
    }
    results.push(r);
    report(o.reporter.stage(r));
    log(
      `stage ${stage.index} done: attempted ${r.attempted}, acked ${r.acknowledged}, rejected ${r.rejected}, ` +
        `transport ${r.transportErrors}, unresolved ${r.unresolved}, achieved ${r.achievedRate ?? "n/a"}/s, ` +
        `delivery p95 ${r.delivery.p95 ?? "insufficient"} ms`,
    );
  }

  await Promise.all(reports);
  await subs.close();
  const outcome = stopReason ?? { state: "COMPLETED" as const, message: "All stages measured" };
  const notes = [outcome.message];
  if (reportErrors) notes.push(`${reportErrors} measurement report(s) failed to save`);
  if (c.unexpectedObservations) notes.push(`${c.unexpectedObservations} unexpected subscriber row(s)`);
  return { state: outcome.state, message: notes.join("; "), stages: results, samples, unexpectedObservations: c.unexpectedObservations };
}
