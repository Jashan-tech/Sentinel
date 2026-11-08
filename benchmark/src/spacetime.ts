// Live SpacetimeDB transport for the benchmark. Real WebSocket connections, real reducer calls,
// real subscriptions. Nothing in this file fabricates an acknowledgement or a delivery.
import { performance } from "node:perf_hooks";
import { DbConnection } from "../../dashboard/src/module_bindings";
import type { StageResult } from "./collector";
import { WriteError, type Reporter, type SubscriberSet, type Writer } from "./runner";

export interface ConnOpts {
  uri: string;
  database: string;
  token?: string;
  light?: boolean;
  onDisconnect?: (err?: Error) => void;
  timeoutMs?: number;
}

export function connect(o: ConnOpts): Promise<DbConnection> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Could not connect to ${o.uri}/${o.database} within ${(o.timeoutMs ?? 10000) / 1000} s`)), o.timeoutMs ?? 10000);
    let b = DbConnection.builder()
      .withUri(o.uri)
      .withDatabaseName(o.database)
      .withCompression("none")
      .withLightMode(Boolean(o.light))
      .onConnect((c) => {
        clearTimeout(timer);
        resolve(c);
      })
      .onConnectError((_c, e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      })
      .onDisconnect((_c, e) => o.onDisconnect?.(e ?? undefined));
    if (o.token) b = b.withToken(o.token);
    b.build();
  });
}

/** Map a reducer failure to rejected (the module refused it) vs transport (anything else). */
export function classify(e: unknown): WriteError {
  const err = e as Error;
  const name = err?.name ?? "";
  return new WriteError(name === "SenderError" ? "rejected" : "transport", err?.message || name || String(e));
}

export function makeWriter(conn: DbConnection): Writer {
  return {
    write: (ev) => conn.reducers.benchWrite(ev).catch((e) => Promise.reject(classify(e))),
  };
}

/** Anonymous subscriber connections, each subscribed only to this run's events. */
export async function openSubscribers(
  o: { uri: string; database: string; runId: number; count: number },
  onObserve: (subscriber: number, eventNo: number, atMs: number) => void,
): Promise<SubscriberSet> {
  let mask = 0;
  const conns: DbConnection[] = [];
  await Promise.all(
    Array.from({ length: o.count }, async (_, s) => {
      const conn = await connect({ uri: o.uri, database: o.database, onDisconnect: () => (mask &= ~(1 << s)) });
      conns.push(conn);
      conn.db.benchmarkEvent.onInsert((_ctx, row) => {
        // Timestamp first, then filter: the observation time is when the row reached this subscriber.
        const at = performance.now();
        if (row.runId === o.runId) onObserve(s, row.eventNo, at);
      });
      await new Promise<void>((resolve, reject) => {
        conn
          .subscriptionBuilder()
          .onApplied(() => {
            mask |= 1 << s;
            resolve();
          })
          .onError((ctx) => reject(ctx.event ?? new Error("Benchmark subscription rejected")))
          .subscribe([`SELECT * FROM benchmark_event WHERE run_id = ${o.runId}`]);
      });
    }),
  );
  return {
    activeMask: () => mask,
    close: async () => {
      mask = 0;
      for (const c of conns) c.disconnect();
    },
  };
}

const opt = (v: number | null) => (v === null ? undefined : v);

export function makeReporter(control: DbConnection, runId: number): Reporter {
  return {
    sample: (s) =>
      control.reducers.reportBenchmarkSample({
        runId,
        stageIndex: s.stageIndex,
        elapsedMs: s.elapsedMs,
        windowMs: s.windowMs,
        activeRovers: s.activeRovers,
        activeSubscribers: s.activeSubscribers,
        targetRate: s.targetRate,
        windowAcknowledged: s.windowAcknowledged,
        achievedRate: opt(s.achievedRate),
        deliveryP95: opt(s.deliveryP95),
        deliverySamples: s.deliverySamples,
        ackP95: opt(s.ackP95),
        totalAttempted: BigInt(s.totalAttempted),
        totalAcknowledged: BigInt(s.totalAcknowledged),
        totalRejected: BigInt(s.totalRejected),
        totalTransportErrors: BigInt(s.totalTransportErrors),
        totalObservedPairs: BigInt(s.totalObservedPairs),
        inFlight: s.inFlight,
      }),
    stage: (r: StageResult) =>
      control.reducers.reportBenchmarkStage({
        runId,
        stageIndex: r.stageIndex,
        roverCount: r.roverCount,
        targetRate: r.targetRate,
        startedElapsedMs: r.startedElapsedMs,
        endedElapsedMs: r.endedElapsedMs,
        sendWindowMs: r.sendWindowMs,
        attempted: BigInt(r.attempted),
        acknowledged: BigInt(r.acknowledged),
        rejected: BigInt(r.rejected),
        transportErrors: BigInt(r.transportErrors),
        unresolved: BigInt(r.unresolved),
        notSentBackpressure: BigInt(r.notSentBackpressure),
        observedPairs: BigInt(r.observedPairs),
        expectedPairs: BigInt(r.expectedPairs),
        duplicateObservations: BigInt(r.duplicateObservations),
        achievedRate: opt(r.achievedRate),
        ackP50: opt(r.ack.p50),
        ackP95: opt(r.ack.p95),
        ackP99: opt(r.ack.p99),
        ackSamples: r.ack.samples,
        deliveryP50: opt(r.delivery.p50),
        deliveryP95: opt(r.delivery.p95),
        deliveryP99: opt(r.delivery.p99),
        deliverySamples: r.delivery.samples,
        eventLoopP99Ms: opt(r.eventLoopP99Ms),
        serverCommitted: r.serverCommitted === null ? undefined : BigInt(r.serverCommitted),
        serverFailed: r.serverFailed === null ? undefined : BigInt(r.serverFailed),
        serverSource: r.serverCommitted === null ? "unavailable" : "SpacetimeDB /v1/metrics spacetime_num_txns_total{reducer=bench_write}",
      }),
  };
}

/**
 * Independent server-side counter: SpacetimeDB's own Prometheus metrics for bench_write
 * transactions on this database. Returns null (not measured) if the endpoint is unavailable.
 */
export async function serverTxnCounter(httpBase: string, database: string) {
  let identity: string | null = null;
  try {
    const res = await fetch(`${httpBase}/v1/database/${database}`);
    if (res.ok) identity = String((await res.json()).database_identity?.__identity__ ?? "").replace(/^0x/, "") || null;
  } catch {
    identity = null;
  }
  return async (): Promise<{ committed: number; failed: number } | null> => {
    if (!identity) return null;
    const res = await fetch(`${httpBase}/v1/metrics`);
    if (!res.ok) return null;
    return parseTxnMetrics(await res.text(), identity);
  };
}

/** Sum spacetime_num_txns_total for reducer bench_write (txn_type Reducer) on one database. */
export function parseTxnMetrics(text: string, identity: string): { committed: number; failed: number } | null {
  let committed = 0;
  let failed = 0;
  let seen = false;
  for (const line of text.split("\n")) {
    if (!line.startsWith("spacetime_num_txns_total{")) continue;
    const labels = line.slice(line.indexOf("{") + 1, line.lastIndexOf("}"));
    if (!labels.includes(`db="${identity}"`) || !labels.includes('reducer="bench_write"') || !labels.includes('txn_type="Reducer"')) continue;
    const value = Number(line.slice(line.lastIndexOf("}") + 1).trim());
    if (!Number.isFinite(value)) continue;
    seen = true;
    if (labels.includes('committed="true"')) committed += value;
    else if (labels.includes('committed="false"')) failed += value;
  }
  return seen ? { committed, failed } : { committed: 0, failed: 0 };
}
