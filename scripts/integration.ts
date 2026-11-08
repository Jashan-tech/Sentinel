import assert from "node:assert/strict";
import { spacetimeCli } from "./spacetime.mjs";
import { execFileSync } from "node:child_process";
import { Timestamp } from "spacetimedb";
import { DbConnection } from "../dashboard/src/module_bindings";
const database = process.env.TEST_DATABASE || "sentinel-verification";
const uri = process.env.SPACETIME_URI || "ws://127.0.0.1:3000";
if (database === "sentinel")
  throw new Error("Use an isolated verification database, not the main demo");
const clients: DbConnection[] = [];
async function connect() {
  return await new Promise<DbConnection>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Connection timeout")),
      10000,
    );
    const db = DbConnection.builder()
      .withUri(uri)
      .withDatabaseName(database)
      .onConnect((c) => {
        c.subscriptionBuilder()
          .onApplied(() => {
            clearTimeout(timer);
            resolve(c);
          })
          .onError((ctx) => {
            clearTimeout(timer);
            reject(ctx.event ?? new Error("Subscription rejected"));
          })
          .subscribe([
            "SELECT * FROM rack",
            "SELECT * FROM rack_profile",
            "SELECT * FROM current_telemetry WHERE rack_id = 'rack-1'",
            "SELECT * FROM recent_observation WHERE rack_id = 'rack-1'",
            "SELECT * FROM rack_alert WHERE rack_id = 'rack-1'",
            "SELECT * FROM current_telemetry WHERE rack_id = 'rack-3'",
          ]);
      })
      .onConnectError((_c, e) => {
        clearTimeout(timer);
        reject(e);
      })
      .build();
    clients.push(db);
  });
}
function until(db: DbConnection, condition: () => boolean) {
  return new Promise<void>((resolve, reject) => {
    const check = () => {
      if (condition()) {
        cleanup();
        resolve();
      }
    };
    const tables = [
      db.db.rack,
      db.db.currentTelemetry,
      db.db.recentObservation,
      db.db.rackAlert,
    ];
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Subscribed state did not converge"));
    }, 10000);
    const cleanup = () => {
      clearTimeout(timer);
      for (const t of tables) {
        t.removeOnInsert(check);
        t.removeOnUpdate(check);
        t.removeOnDelete(check);
      }
    };
    for (const t of tables) {
      t.onInsert(check);
      t.onUpdate(check);
      t.onDelete(check);
    }
    check();
  });
}
let checks = 0;
function check(label: string, fn: () => void) {
  fn();
  checks++;
  console.log(`PASS ${label}`);
}
try {
  const a = await connect(),
    b = await connect();
  check("independent authenticated identities", () =>
    assert.notEqual(a.identity?.toHexString(), b.identity?.toHexString()),
  );
  check("three profiles and racks", () => {
    assert.equal(a.db.rack.count(), 3n);
    assert.equal(a.db.rackProfile.count(), 3n);
  });
  check("missing measurements stay missing on untouched rack", () =>
    assert.equal(
      [...a.db.currentTelemetry.iter()].filter((c) => c.rackId === "rack-3")
        .length,
      0,
    ),
  );
  await a.reducers.changeRackProfile({
    rackId: "rack-1",
    profileId: "standard",
  });
  const baseline = a.db.recentObservation.count();
  const start = BigInt(Date.now()) * 1000n;
  let tick = 0n;
  const args = (
    value: number,
    extra: Partial<
      Parameters<typeof a.reducers.ingestSimulatedObservation>[0]
    > = {},
  ) => ({
    rackId: "rack-1",
    metricType: "AMBIENT_TEMPERATURE_C",
    numericValue: value,
    unit: "°C",
    sourceType: "SIMULATOR",
    sourceIdentifier: "integration-test",
    observedAt: new Timestamp(start + ++tick),
    ...extra,
  });
  const read = () =>
    b.db.currentTelemetry.currentKey.find("rack-1:AMBIENT_TEMPERATURE_C");
  const alert = () =>
    b.db.rackAlert.alertId.find("rack-1:AMBIENT_TEMPERATURE_C");
  await a.reducers.ingestSimulatedObservation(args(25));
  await until(b, () => read()?.numericValue === 25);
  const first = read()!;
  check(
    "valid ingestion synchronizes across two clients and preserves provenance",
    () => {
      assert.equal(first.sourceType, "SIMULATOR");
      assert.equal(first.sourceIdentifier, "integration-test");
      assert.equal(first.submittedBy.toHexString(), a.identity!.toHexString());
      assert(first.ingestedAt.microsSinceUnixEpoch >= start);
    },
  );
  await a.reducers.ingestSimulatedObservation(
    args(72, {
      metricType: "RELATIVE_HUMIDITY_PERCENT",
      unit: "%RH",
      observedAt: new Timestamp(start - 5_000_000n),
    }),
  );
  await until(
    b,
    () =>
      b.db.rackAlert.alertId.find("rack-1:RELATIVE_HUMIDITY_PERCENT")
        ?.active === true &&
      b.db.currentTelemetry.currentKey.find("rack-1:RELATIVE_HUMIDITY_PERCENT")
        ?.observedAt.microsSinceUnixEpoch ===
        start - 5_000_000n,
  );
  check("independent timestamps and humidity warning", () => {
    assert.equal(
      b.db.currentTelemetry.currentKey.find("rack-1:RELATIVE_HUMIDITY_PERCENT")
        ?.observedAt.microsSinceUnixEpoch,
      start - 5_000_000n,
    );
  });
  await a.reducers.ingestSimulatedObservation(args(32));
  await until(
    b,
    () => alert()?.severity === "WARNING" && alert()?.active === true,
  );
  check("temperature warning at threshold", () =>
    assert.equal(alert()?.severity, "WARNING"),
  );
  await a.reducers.ingestSimulatedObservation(args(40));
  await until(b, () => alert()?.severity === "CRITICAL");
  const newer = read()!;
  check("temperature critical escalates without duplicate alerts", () =>
    assert.equal(
      [...b.db.rackAlert.iter()].filter(
        (r) => r.metricType === "AMBIENT_TEMPERATURE_C" && r.active,
      ).length,
      1,
    ),
  );
  const delayed = args(10, { observedAt: new Timestamp(start - 60_000_000n) });
  await a.reducers.ingestSimulatedObservation(delayed);
  await until(b, () =>
    [...b.db.recentObservation.iter()].some(
      (o) =>
        o.numericValue === 10 &&
        o.observedAt.microsSinceUnixEpoch ===
          delayed.observedAt.microsSinceUnixEpoch,
    ),
  );
  check(
    "delayed observations preserved without replacing current or resolving alerts",
    () => {
      assert.equal(read()?.observationId, newer.observationId);
      assert.equal(alert()?.active, true);
    },
  );
  await a.reducers.ingestSimulatedObservation(
    args(41, { observedAt: newer.observedAt }),
  );
  check("timestamp ties retain existing current value", () =>
    assert.equal(
      a.db.currentTelemetry.currentKey.find("rack-1:AMBIENT_TEMPERATURE_C")
        ?.numericValue,
      40,
    ),
  );
  await a.reducers.changeRackProfile({
    rackId: "rack-1",
    profileId: "industrial",
  });
  await until(
    b,
    () =>
      b.db.rack.rackId.find("rack-1")?.profileId === "industrial" &&
      alert()?.severity === "WARNING",
  );
  check("profile changes synchronize and reevaluate existing values", () =>
    assert.equal(alert()?.severity, "WARNING"),
  );
  await a.reducers.initializeDemo({});
  check("idempotent seed preserves selected settings and readings", () => {
    assert.equal(a.db.rack.rackId.find("rack-1")?.profileId, "industrial");
    assert.equal(a.db.rack.count(), 3n);
    assert.equal(a.db.rackProfile.count(), 3n);
    assert.equal(
      a.db.currentTelemetry.currentKey.find("rack-1:AMBIENT_TEMPERATURE_C")
        ?.numericValue,
      40,
    );
  });
  await a.reducers.ingestSimulatedObservation(args(20));
  await until(b, () => alert()?.active === false);
  await a.reducers.ingestSimulatedObservation(
    args(40, { metricType: "RELATIVE_HUMIDITY_PERCENT", unit: "%RH" }),
  );
  await until(
    b,
    () =>
      b.db.rackAlert.alertId.find("rack-1:RELATIVE_HUMIDITY_PERCENT")
        ?.active === false,
  );
  check("temperature and humidity alerts resolve with server timestamp", () =>
    assert(alert()?.resolvedAt),
  );
  const invalid = [
    { metricType: "FAN_RPM" },
    { unit: "dB" },
    { numericValue: NaN },
    { numericValue: Infinity },
    { numericValue: 101 },
    { rackId: "unknown" },
    { sourceType: "ROVER" },
    { sourceType: "REDFISH" },
    { metricType: "RELATIVE_HUMIDITY_PERCENT", unit: "%RH", numericValue: 101 },
    { metricType: "SOUND_RAW", unit: "raw", numericValue: -1 },
    { metricType: "ULTRASONIC_DISTANCE_CM", unit: "cm", numericValue: -1 },
    { observedAt: new Timestamp(0n) },
    { observedAt: new Timestamp(start + 120_000_000n) },
  ];
  const before = [...a.db.recentObservation.iter()]
    .map((x) => x.observationId.toString())
    .sort();
  for (const change of invalid)
    await assert.rejects(
      a.reducers.ingestSimulatedObservation(args(10, change)),
    );
  await assert.rejects(
    a.reducers.changeRackProfile({ rackId: "rack-1", profileId: "missing" }),
  );
  check(
    "invalid inputs and source impersonation rejected atomically by actual backend",
    () =>
      assert.deepEqual(
        [...a.db.recentObservation.iter()]
          .map((x) => x.observationId.toString())
          .sort(),
        before,
      ),
  );
  // Cross the exact history window boundary to verify retention, not throughput.
  for (let i = 0; i < 51; i++)
    await a.reducers.ingestSimulatedObservation(
      args(i, { metricType: "SOUND_RAW", unit: "raw" }),
    );
  await until(
    b,
    () =>
      b.db.currentTelemetry.currentKey.find("rack-1:SOUND_RAW")
        ?.numericValue === 50,
  );
  check("recent history bounded to 50 and stays synchronized", () => {
    assert.equal(a.db.recentObservation.count(), 50n);
    assert.equal(b.db.recentObservation.count(), 50n);
  });
  const cli = spacetimeCli();
  const output = execFileSync(
    cli,
    [
      "sql",
      "--server",
      "http://127.0.0.1:3000",
      "--format",
      "json",
      database,
      `SELECT * FROM telemetry_observation WHERE observation_id = ${first.observationId}`,
    ],
    { encoding: "utf8" },
  );
  check(
    "immutable archive survives window eviction and profile changes",
    () => {
      const archived = JSON.parse(output)[0].rows;
      assert.equal(archived.length, 1);
      const row = archived[0];
      assert.equal(row[1], "rack-1");
      assert.equal(row[2], "AMBIENT_TEMPERATURE_C");
      assert.equal(row[3], first.numericValue);
      assert.equal(row[4], first.unit);
      assert.equal(row[5], first.sourceType);
      assert.equal(row[6], first.sourceIdentifier);
      assert.equal(row[7][0], "0x" + first.submittedBy.toHexString());
      assert.equal(BigInt(row[8][0]), first.observedAt.microsSinceUnixEpoch);
      assert.equal(BigInt(row[9][0]), first.ingestedAt.microsSinceUnixEpoch);
      assert.equal(
        b.db.recentObservation.observationId.find(first.observationId),
        null,
      );
    },
  );
  const count = execFileSync(
    cli,
    [
      "sql",
      "--server",
      "http://127.0.0.1:3000",
      database,
      "SELECT COUNT(*) AS total FROM telemetry_observation",
    ],
    { encoding: "utf8" },
  );
  console.log("Archive row count:", count.trim());
  await a.reducers.changeRackProfile({
    rackId: "rack-1",
    profileId: "standard",
  });
  console.log(
    `${checks} integration checks passed; starting recent count ${baseline}. Database: ${database}`,
  );
} finally {
  for (const db of clients) db.disconnect();
}
