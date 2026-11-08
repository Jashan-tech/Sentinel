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
const server = "http://127.0.0.1:3000";
async function sql(query: string): Promise<Record<string, any>[]> {
  const res = await fetch(`${server}/v1/database/${database}/sql`, { method: "POST", body: query });
  if (!res.ok) throw new Error(`SQL ${res.status}: ${await res.text()}`);
  const [{ schema, rows }] = (await res.json()) as any[];
  const names = schema.elements.map((e: any) => e.name.some);
  return rows.map((r: unknown[]) => Object.fromEntries(names.map((n: string, i: number) => [n, r[i]])));
}
/** Call a reducer as the CLI (database publisher / admin) identity. */
function asAdmin(reducer: string, ...args: unknown[]) {
  return execFileSync(spacetimeCli(), ["call", database, reducer, ...args.map((x) => JSON.stringify(x)), "--server", server], { encoding: "utf8", stdio: "pipe" });
}
async function rejects(p: Promise<unknown>, re: RegExp) {
  await assert.rejects(p, (e: Error) => (re.test(String(e?.message ?? e)) ? true : assert.fail(`expected ${re}, got ${e?.message ?? e}`)));
}
const agentReport = (rackId: string, extra: object = {}) => ({
  rack_id: rackId, investigation_status: "COMPLETED", severity: "NORMAL", summary: "INTEGRATION TEST: scripted report.",
  hypotheses: [], recommended_next_inspection: [], tool_calls: [], agents_invoked: [], specialist_findings: [],
  verified_findings: [], missing_information: [], limits_reached: [], unsupported_claims: [], evidence: {},
  verification_outcome: "NOT_REQUIRED", incomplete_reasons: [], ...extra,
});
const completion = (id: string, r: Record<string, unknown>) => ({
  investigationId: id, status: String(r.investigation_status), severity: String(r.severity), reportJson: JSON.stringify(r), eventsJson: "[]",
});
const row = async (id: string) => (await sql(`SELECT * FROM investigation WHERE investigation_id = '${id}'`))[0];
const kind = async (id: string) => (await sql(`SELECT * FROM investigation_completion WHERE investigation_id = '${id}'`))[0]?.kind;

/** Issues 5, 7 and 10 against the real backend. `agent` is authorized by the admin; `browser` is not. */
async function investigationTrustChecks(agent: DbConnection, browser: DbConnection) {
  asAdmin("claim_admin");
  asAdmin("authorize_agent", agent.identity!.toHexString(), "integration-agent");
  const id = () => crypto.randomUUID();
  const start = (who: DbConnection, investigationId: string) =>
    who.reducers.startInvestigation({ investigationId, rackId: "rack-2", snapshotJson: '{"rack_id":"rack-2"}' });
  try {
    const inv1 = id();
    await start(browser, inv1);
    await rejects(browser.reducers.completeInvestigation(completion(inv1, agentReport("rack-2"))), /authorized agent/);
    check("forged completion from a browser identity is rejected", () => {});
    await rejects(agent.reducers.completeInvestigation(completion(inv1, agentReport("rack-1"))), /does not match investigated rack/);
    check("report for a different rack is rejected", () => {});
    await rejects(
      agent.reducers.completeInvestigation(completion(inv1, agentReport("rack-2", { verification_outcome: "NOT_GROUNDED" }))),
      /requires VERIFIED/,
    );
    check("COMPLETED report with unsuccessful verification is rejected", () => {});
    const good = completion(inv1, agentReport("rack-2"));
    await agent.reducers.completeInvestigation(good);
    const r1 = await row(inv1);
    const k1 = await kind(inv1);
    check("authorized agent records the report; provenance is AGENT", () => {
      assert.equal(r1.status, "COMPLETED");
      assert.equal(k1, "AGENT");
    });
    await agent.reducers.completeInvestigation(good); // identical retry
    await rejects(agent.reducers.completeInvestigation({ ...good, reportJson: JSON.stringify(agentReport("rack-2", { summary: "changed" })) }), /already COMPLETED/);
    await browser.reducers.abandonInvestigation({ investigationId: inv1, reason: "late" }); // no-op
    check("terminal transitions are idempotent; a different second completion is rejected", () => {});
    assert.equal((await row(inv1)).report_json, good.reportJson, "stored report unchanged");

    const inv2 = id();
    await start(browser, inv2);
    await rejects(agent.reducers.abandonInvestigation({ investigationId: inv2, reason: "x" }), /started an investigation/);
    await browser.reducers.abandonInvestigation({ investigationId: inv2, reason: "Agent service is unreachable" });
    await browser.reducers.abandonInvestigation({ investigationId: inv2, reason: "again" });
    const r2 = await row(inv2);
    assert.equal(r2.status, "FAILED");
    assert.equal(r2.severity, "UNKNOWN");
    assert.equal(JSON.parse(r2.report_json).diagnosis, null);
    assert.equal(await kind(inv2), "CLIENT_ABANDONED");
    await rejects(agent.reducers.completeInvestigation(completion(inv2, agentReport("rack-2"))), /already FAILED/);
    check("only the starter can abandon; abandoned runs are FAILED/UNKNOWN with no diagnosis; late agent results are refused", () => {});
    await rejects(start(browser, inv2), /already exists/);
    check("duplicate investigation ids are rejected", () => {});

    // Durable recovery (issue 7): RUNNING rows past the timeout are expired by the database.
    asAdmin("set_running_timeout", 1);
    const inv3 = id();
    await start(browser, inv3);
    await new Promise((r) => setTimeout(r, 2200));
    const inv4 = id();
    await start(browser, inv4); // also sweeps this rack
    const r3 = await row(inv3);
    assert.equal(r3.status, "FAILED");
    assert.match(JSON.parse(r3.report_json).error, /No completion was recorded/);
    assert.equal(await kind(inv3), "DATABASE_EXPIRED");
    const schedule = execFileSync(spacetimeCli(), ["sql", "--server", server, database, "SELECT * FROM investigation_expiry"], { encoding: "utf8" });
    assert.match(schedule, /Interval|interval|\d/);
    check("stale RUNNING investigations are expired by the database; the periodic sweep is scheduled", () => {});
    asAdmin("set_running_timeout", 300);
    await browser.reducers.abandonInvestigation({ investigationId: inv4, reason: "cleanup" });

    // Retention (issue 10): bounded per-rack history; RUNNING rows are never deleted.
    const running = id();
    await start(browser, running);
    for (let i = 0; i < 22; i++) {
      const x = id();
      await start(browser, x);
      await browser.reducers.abandonInvestigation({ investigationId: x, reason: "retention test" });
    }
    const rack2 = await sql("SELECT * FROM investigation WHERE rack_id = 'rack-2'");
    const runningRows = rack2.filter((r) => r.status === "RUNNING").length;
    assert.ok(rack2.length <= 20 + runningRows && rack2.length - runningRows <= 20, `rack-2 keeps ${rack2.length} investigations (${runningRows} running)`);
    assert.ok(rack2.some((r) => r.investigation_id === running && r.status === "RUNNING"), "RUNNING row retained");
    const orphanImages = await sql("SELECT * FROM investigation_completion WHERE rack_id = 'rack-2'");
    assert.ok(orphanImages.every((c) => rack2.some((r) => r.investigation_id === c.investigation_id)), "no orphaned completion rows");
    await browser.reducers.abandonInvestigation({ investigationId: running, reason: "cleanup" });
    check("per-rack investigation history is bounded (20) and RUNNING rows are kept", () => {});

    await rejects(browser.reducers.authorizeAgent({ agentIdentity: browser.identity!.toHexString(), label: "me" }), /admin/);
    await rejects(browser.reducers.claimAdmin({}), /already has an admin/);
    check("non-admin identities cannot authorize agents or claim admin", () => {});
  } finally {
    asAdmin("revoke_agent", agent.identity!.toHexString());
  }
}
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
  check("fair eviction: a fast SOUND_RAW burst does not erase other metrics' recent history (issue 9)", () => {
    const metrics = new Set([...a.db.recentObservation.iter()].map((r) => r.metricType));
    assert.ok(metrics.has("SOUND_RAW"));
    assert.ok(metrics.size > 1, `only ${[...metrics].join(",")} left in recent history`);
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
      // With fair eviction (issue 9) the first temperature reading may stay in the window; the rows
      // that were evicted are the oldest SOUND_RAW burst rows. They must all remain in the archive.
    },
  );
  {
    const archivedSound = JSON.parse(
      execFileSync(cli, ["sql", "--server", "http://127.0.0.1:3000", "--format", "json", database,
        "SELECT observation_id FROM telemetry_observation WHERE rack_id = 'rack-1' AND metric_type = 'SOUND_RAW'"], { encoding: "utf8" }),
    )[0].rows.map((r: unknown[]) => String(r[0]));
    const recentSound = new Set([...b.db.recentObservation.iter()].filter((r) => r.metricType === "SOUND_RAW").map((r) => r.observationId.toString()));
    const evicted = archivedSound.filter((x: string) => !recentSound.has(x));
    check("rows evicted from the recent window remain in the immutable archive", () => {
      assert.ok(evicted.length >= 1, "the 51-reading burst must have evicted something");
      assert.ok(archivedSound.length >= 51);
    });
  }
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
  await investigationTrustChecks(a, b);
  console.log(
    `${checks} integration checks passed; starting recent count ${baseline}. Database: ${database}`,
  );
} finally {
  for (const db of clients) db.disconnect();
}
