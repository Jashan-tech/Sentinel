import { test } from "node:test";
import assert from "node:assert/strict";
import { createSnapshotDataSource, createTools, MAX_HISTORY_LIMIT, thresholdSeverity } from "../src/tools.js";
import { InvestigationRequest } from "../src/schemas.js";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { fixture, rawFixture } from "./helpers.js";

const opts = { staleAfterMinutes: 15 };
const toolMap = (req: InvestigationRequest): Record<string, StructuredToolInterface> =>
  Object.fromEntries(createTools(createSnapshotDataSource(req, opts)).map((t) => [t.name, t]));
const call = async (req: InvestigationRequest, name: string, args: object) =>
  JSON.parse(String(await toolMap(req)[name].invoke(args as any)));

test("equipment tools exclude collision-only readings, trends and missing-data indicators", async () => {
  const req = fixture("a-normal");
  const r = { ...req.current_telemetry[0], metric_type: "ULTRASONIC_DISTANCE_CM" as const, numeric_value: 3, unit: "cm" };
  const ds = createSnapshotDataSource({ ...req, current_telemetry: [r], recent_telemetry: [r] }, opts);
  const current = ds.getCurrentTelemetry(req.rack_id) as { readings: unknown[]; missing_metrics: string[] };
  assert.deepEqual(current.readings, []);
  assert(!current.missing_metrics.includes("ULTRASONIC_DISTANCE_CM"));
  assert(!ds.getTelemetryTrends(req.rack_id).some(t => t.metric_type === "ULTRASONIC_DISTANCE_CM"));
  assert(!ds.getEarlyWarnings(req.rack_id).some(i => i.metric === "ULTRASONIC_DISTANCE_CM"));
  for (const t of (createTools(ds) as StructuredToolInterface[]).filter(t => t.name !== "get_rack_profile"))
    await assert.rejects(() => t.invoke({ rack_id: req.rack_id, metric_type: "ULTRASONIC_DISTANCE_CM" }));
});

test("request validation: valid fixtures parse, unsupported metrics and bad bodies are rejected", () => {
  for (const f of ["a-normal", "b-elevated", "c-critical", "d-stale"]) assert.ok(fixture(f));
  const bad = rawFixture("c-critical");
  bad.current_telemetry[0].metric_type = "FAN_RPM";
  assert.equal(InvestigationRequest.safeParse(bad).success, false);
  const noProv = rawFixture("c-critical");
  delete noProv.current_telemetry[0].simulated;
  assert.equal(InvestigationRequest.safeParse(noProv).success, false);
  const badProfile = rawFixture("c-critical");
  badProfile.profile.temperature_warning_c = 40;
  assert.equal(InvestigationRequest.safeParse(badProfile).success, false);
});

test("invalid rack ids: bad format rejected by schema; unknown rack rejected by tools", async () => {
  const bad = rawFixture("a-normal");
  bad.rack_id = "rack 01; DROP";
  assert.equal(InvestigationRequest.safeParse(bad).success, false);
  const r = await call(fixture("a-normal"), "get_rack_profile", { rack_id: "rack-other" });
  assert.match(r.error, /Unknown rack_id/);
});

test("missing telemetry stays missing", async () => {
  const req = InvestigationRequest.parse({ ...rawFixture("a-normal"), current_telemetry: [], recent_telemetry: [] });
  const cur = await call(req, "get_current_telemetry", { rack_id: req.rack_id });
  assert.deepEqual(cur.readings, []);
  assert.equal(cur.missing_metrics.length, 3); // Collision distance is outside equipment reasoning.
  const hist = await call(req, "get_telemetry_history", { rack_id: req.rack_id, metric_type: "SOUND_RAW" });
  assert.equal(hist.available, false);
});

test("tool argument validation rejects bad args", async () => {
  const tools = toolMap(fixture("a-normal"));
  await assert.rejects(() => tools.get_telemetry_history.invoke({ rack_id: "rack-net-01", metric_type: "CPU_LOAD" } as any));
  await assert.rejects(() => tools.get_telemetry_history.invoke({ rack_id: "rack-net-01", metric_type: "SOUND_RAW", limit: 9999 } as any));
  await assert.rejects(() => tools.get_rack_profile.invoke({} as any));
});

test("current telemetry retrieval preserves provenance and flags stale readings", async () => {
  const c = await call(fixture("c-critical"), "get_current_telemetry", { rack_id: "rack-cmp-03", metric_type: "AMBIENT_TEMPERATURE_C" });
  assert.equal(c.readings.length, 1);
  const r = c.readings[0];
  assert.equal(r.numeric_value, 35.4);
  assert.equal(r.unit, "C");
  assert.equal(r.source_type, "SIMULATOR");
  assert.equal(r.simulated, true);
  assert.ok(r.observed_at && r.ingested_at && r.source_identifier);
  assert.equal(r.stale, false);
  const d = await call(fixture("d-stale"), "get_current_telemetry", { rack_id: "rack-sto-04" });
  assert.equal(d.readings[0].stale, true);
  assert.deepEqual(d.missing_metrics, ["RELATIVE_HUMIDITY_PERCENT", "SOUND_RAW"]);
});

test("history is filtered by metric, ordered oldest->newest, and limited", async () => {
  const req = fixture("c-critical");
  const h = await call(req, "get_telemetry_history", { rack_id: req.rack_id, metric_type: "AMBIENT_TEMPERATURE_C", limit: 3 });
  assert.equal(h.returned, 3);
  assert.ok(h.observations.every((o: any) => o.metric_type === "AMBIENT_TEMPERATURE_C"));
  assert.deepEqual(h.observations.map((o: any) => o.numeric_value), [34.3, 35.0, 35.4]);
  const times = h.observations.map((o: any) => o.observed_at);
  assert.deepEqual(times, [...times].sort());
  const big = { ...req, recent_telemetry: Array.from({ length: 80 }, (_, i) => ({ ...req.recent_telemetry[0], numeric_value: i })) };
  const hb = await call(big, "get_telemetry_history", { rack_id: req.rack_id, metric_type: "AMBIENT_TEMPERATURE_C", limit: 50 });
  assert.equal(hb.total_available, 80);
  assert.ok(hb.returned <= MAX_HISTORY_LIMIT && hb.returned > 0);
  assert.equal(hb.observations.at(-1).numeric_value, 79); // newest kept when size-capped
});

test("rack profile retrieval", async () => {
  const p = await call(fixture("b-elevated"), "get_rack_profile", { rack_id: "rack-cmp-02" });
  assert.equal(p.equipment_type, "Compute");
  assert.equal(p.profile.temperature_warning_c, 27);
  assert.equal(p.profile.temperature_critical_c, 33);
  assert.match(p.note, /fictional/);
});

test("request isolation: data sources are independent copies", async () => {
  const a = fixture("a-normal");
  const c = fixture("c-critical");
  const toolsA = toolMap(a);
  const toolsC = toolMap(c);
  a.current_telemetry[0].numeric_value = 999; // mutate caller object after creation
  const [ra, rc] = await Promise.all([
    toolsA.get_current_telemetry.invoke({ rack_id: "rack-net-01", metric_type: "AMBIENT_TEMPERATURE_C" }),
    toolsC.get_current_telemetry.invoke({ rack_id: "rack-cmp-03", metric_type: "AMBIENT_TEMPERATURE_C" }),
  ]);
  assert.equal(JSON.parse(String(ra)).readings[0].numeric_value, 24.1);
  assert.equal(JSON.parse(String(rc)).readings[0].numeric_value, 35.4);
  assert.match(JSON.parse(String(await toolsA.get_rack_profile.invoke({ rack_id: "rack-cmp-03" }))).error, /Unknown rack_id/);
});

test("threshold severity policy: profile-dependent, stale data is UNKNOWN", () => {
  assert.equal(thresholdSeverity(fixture("a-normal"), 15), "NORMAL");
  assert.equal(thresholdSeverity(fixture("b-elevated"), 15), "WARNING");
  assert.equal(thresholdSeverity(fixture("c-critical"), 15), "CRITICAL");
  assert.equal(thresholdSeverity(fixture("d-stale"), 15), "UNKNOWN");
  const b2 = { ...fixture("b-elevated"), profile: { name: "Net", temperature_warning_c: 32, temperature_critical_c: 38 } };
  assert.equal(thresholdSeverity(b2, 15), "NORMAL");
});
