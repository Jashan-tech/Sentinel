// Restore a calm demo after tests: for every metric with an ACTIVE alert, submit one normal SIMULATED
// reading so the alert resolves through the ordinary ingestion path. Racks/metrics without an alert
// (and racks with no readings at all) are left untouched; missing data stays missing.
//   npm run demo:reset            (database "sentinel" on ws://127.0.0.1:3000)
import { fileURLToPath } from "node:url";
import { Timestamp } from "spacetimedb";
import { DbConnection } from "../dashboard/src/module_bindings";

const BASELINE: Record<string, { value: number; unit: string }> = {
  AMBIENT_TEMPERATURE_C: { value: 24, unit: "°C" },
  RELATIVE_HUMIDITY_PERCENT: { value: 45, unit: "%RH" },
};

export async function restoreBaseline(opts: { uri?: string; database?: string; log?: (m: string) => void } = {}) {
  const uri = opts.uri ?? "ws://127.0.0.1:3000";
  const database = opts.database ?? "sentinel";
  const log = opts.log ?? console.log;
  const conn = await new Promise<DbConnection>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("SpacetimeDB connection timeout")), 10_000);
    DbConnection.builder()
      .withUri(uri)
      .withDatabaseName(database)
      .onConnect((c) => {
        c.subscriptionBuilder()
          .onApplied(() => {
            clearTimeout(timer);
            resolve(c);
          })
          .onError((ctx) => reject(ctx.event ?? new Error("subscription rejected")))
          .subscribe(["SELECT * FROM rack_alert"]);
      })
      .onConnectError((_c, e) => {
        clearTimeout(timer);
        reject(e);
      })
      .build();
  });
  let restored = 0;
  try {
    for (const alert of [...conn.db.rackAlert.iter()].filter((a) => a.active)) {
      const base = BASELINE[alert.metricType];
      if (!base) continue;
      await conn.reducers.ingestSimulatedObservation({
        rackId: alert.rackId,
        metricType: alert.metricType,
        numericValue: base.value,
        unit: base.unit,
        sourceType: "SIMULATOR",
        sourceIdentifier: "demo-baseline",
        observedAt: Timestamp.now(),
      });
      restored++;
      log(`restored ${alert.rackId} ${alert.metricType} to ${base.value} ${base.unit} (SIMULATED, demo-baseline)`);
    }
  } finally {
    conn.disconnect();
  }
  if (!restored) log("no active alerts; nothing to restore");
  return restored;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await restoreBaseline({ database: process.argv[2] ?? "sentinel" });
  setTimeout(() => process.exit(0), 200).unref();
}
