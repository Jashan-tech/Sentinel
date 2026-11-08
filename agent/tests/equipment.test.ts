import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeTrends, earlyWarnings, TREND_POLICY } from "../src/trends.js";
import {
  createSnapshotDataSource,
  createTools,
  createDocumentationTool,
  MAX_TOOL_RESULT_CHARS,
} from "../src/tools.js";
import { lookupDocumentation } from "../src/documentation.js";
import {
  InvestigationRequest,
  type TelemetryReading,
  type MetricType,
} from "../src/schemas.js";
import { fixture } from "./helpers.js";
const at = Date.parse("2026-11-07T14:00:00Z");
const iso = (seconds: number) => new Date(at + seconds * 1000).toISOString();
const units = {
  AMBIENT_TEMPERATURE_C: "°C",
  RELATIVE_HUMIDITY_PERCENT: "%RH",
  SOUND_RAW: "raw",
  ULTRASONIC_DISTANCE_CM: "cm",
};
const sample = (
  seconds: number,
  value: number,
  metric: MetricType = "AMBIENT_TEMPERATURE_C",
  extra: Partial<TelemetryReading> = {},
): TelemetryReading => ({
  observation_id: `${seconds}-${value}`,
  metric_type: metric,
  numeric_value: value,
  unit: units[metric],
  source_type: "SIMULATOR",
  source_identifier: "sensor-a",
  simulated: true,
  observed_at: iso(seconds),
  ingested_at: iso(seconds + 1),
  ...extra,
});
function request(readings: TelemetryReading[], current = readings.slice(-1)) {
  return {
    ...fixture("a-normal"),
    as_of: iso(0),
    profile: {
      name: "Demo",
      temperature_warning_c: 32,
      temperature_critical_c: 40,
      humidity_warning_percent: 70,
    },
    recent_telemetry: readings,
    current_telemetry: current,
  };
}
function analysis(
  readings: TelemetryReading[],
  metric: MetricType = "AMBIENT_TEMPERATURE_C",
) {
  return analyzeTrends(request(readings), 5).find(
    (t) => t.metric_type === metric,
  )!;
}
const series = (
  readings: TelemetryReading[],
  metric: MetricType = "AMBIENT_TEMPERATURE_C",
) => analysis(readings, metric).series[0];
const inc = [sample(-120, 25), sample(-60, 26), sample(0, 27)];
test("actual timestamps drive count, range, average, signed absolute change and endpoint rate", () => {
  const s = series([inc[2], inc[0], inc[1]]);
  assert.equal(s.observation_count, 3);
  assert.equal(s.first_value, 25);
  assert.equal(s.last_value, 27);
  assert.equal(s.absolute_change, 2);
  assert.equal(s.elapsed_seconds, 120);
  assert.equal(s.change_per_minute, 1);
  assert.equal(s.minimum, 25);
  assert.equal(s.maximum, 27);
  assert.equal(s.average, 26);
  assert.equal(s.direction, "increasing");
  assert.deepEqual(
    s.observation_window.observation_ids,
    inc.map((r) => r.observation_id),
  );
  assert.match(s.observation_window.sha256, /^[a-f0-9]{64}$/);
  assert.equal(s.provenance, "SIMULATED");
});
test("missing history is empty, not zero; a single sample has no rate or change", () => {
  assert.equal(analysis([]).series.length, 0);
  const s = series([sample(0, 0)]);
  assert.equal(s.first_value, 0);
  assert.equal(s.minimum, 0);
  assert.equal(s.absolute_change, null);
  assert.equal(s.change_per_minute, null);
  assert.equal(s.direction, "insufficient_data");
});
test("two points describe observed change without sustained trend", () => {
  const s = series([sample(-60, 20), sample(0, 22)]);
  assert.equal(s.change_per_minute, 2);
  assert.equal(s.direction, "insufficient_data");
});
test("minimum window is 60 seconds and minimum count is 3", () => {
  assert.equal(TREND_POLICY.minimum_samples, 3);
  assert.equal(
    series([sample(-59, 20), sample(-30, 21), sample(0, 22)]).direction,
    "insufficient_data",
  );
  assert.equal(
    series([sample(-60, 20), sample(-30, 21), sample(0, 22)]).direction,
    "increasing",
  );
});
test("stable, sustained decreasing, and inconsistent direction are distinct", () => {
  assert.equal(
    series([sample(-120, 25), sample(-60, 25.1), sample(0, 25)]).direction,
    "stable",
  );
  assert.equal(
    series([sample(-120, 30), sample(-60, 29), sample(0, 28)]).direction,
    "decreasing",
  );
  assert.equal(
    series([sample(-120, 25), sample(-60, 35), sample(0, 26)]).direction,
    "insufficient_data",
  );
});
test("equivalent offset timestamps sort chronologically, not lexicographically", () => {
  const r = structuredClone(inc);
  r[0] = { ...r[0], observed_at: "2026-11-07T15:58:00+02:00" };
  assert.equal(series(r).elapsed_seconds, 120);
  assert.equal(series(r).first_value, 25);
});
test("identical timestamp duplicates cannot create sample count or extra violations", () => {
  const s = series([inc[0], inc[0], inc[1], inc[2]]);
  assert.equal(s.observation_count, 3);
  assert.equal(s.duplicate_observations_removed, 1);
});
test("conflicting same-source timestamps are excluded and cannot support sustained trends", () => {
  const s = series([inc[0], inc[1], sample(-60, 80), inc[2]]);
  assert.equal(s.observation_count, 2);
  assert.equal(s.conflicting_observations_excluded, 2);
  assert.equal(s.direction, "insufficient_data");
});
test("multiple sensors and simulated/real provenance are never merged into a series", () => {
  const t = analysis([
    sample(-120, 25),
    sample(-60, 30, "AMBIENT_TEMPERATURE_C", { source_identifier: "sensor-b" }),
    sample(0, 20, "AMBIENT_TEMPERATURE_C", {
      // The API rejects non-SIMULATOR sources; the trend engine still never merges provenance (defence in depth).
      source_type: "ROVER" as unknown as "SIMULATOR",
      simulated: false,
    }),
  ]);
  assert.equal(t.series.length, 3);
  assert(
    t.series.every(
      (s) => s.observation_count === 1 && s.direction === "insufficient_data",
    ),
  );
  assert(
    t.series.some(
      (s) => s.provenance === "NON_SIMULATED_INPUT_NOT_DEVICE_VERIFIED",
    ),
  );
});
for (const [label, change] of Object.entries({
  NaN: { numeric_value: NaN },
  infinity: { numeric_value: Infinity },
  "bad unit": { unit: "dB" },
  "invalid time": { observed_at: "invalid" },
  "future time": { observed_at: iso(1) },
  "false provenance": { simulated: false },
  "unreasonable temperature": { numeric_value: 101 },
}))
  test(`invalid ${label} is excluded, never used in numerical statistics`, () => {
    const t = analysis([...inc, { ...sample(-30, 50), ...change }]);
    assert.equal(t.rejected_observations, 1);
    assert.equal(t.series[0].average, 26);
    assert.equal(t.series[0].direction, "insufficient_data");
  });
test("sparse history has no sustained direction and no abnormal duration across the gap", () => {
  const s = series([sample(-400, 33), sample(-200, 34), sample(0, 35)]);
  assert.equal(s.direction, "insufficient_data");
  assert.equal(s.threshold_violations, 3);
  assert.equal(s.observed_abnormal_span_seconds, null);
  assert(s.data_quality.includes("sparse_history"));
});
test("sampled abnormal duration stops at normal, invalid, or conflicting observations", () => {
  const s = series([sample(-120, 33), sample(-60, 34), sample(0, 35)]);
  assert.equal(s.threshold_violations, 3);
  assert.equal(s.observed_abnormal_span_seconds, 120);
  assert.equal(s.longest_abnormal_span_seconds, 120);
  const broken = series([sample(-120, 33), sample(-60, 20), sample(0, 35)]);
  assert.equal(broken.observed_abnormal_span_seconds, null);
  const conflict = series([
    sample(-120, 33),
    sample(-60, 33),
    sample(-60, 44),
    sample(0, 35),
  ]);
  assert.equal(conflict.observed_abnormal_span_seconds, null);
  const invalid = series([sample(-120, 33), sample(-60, NaN), sample(0, 35)]);
  assert.equal(invalid.observed_abnormal_span_seconds, null);
});
test("humidity uses selected profile high limits and no invented lower limit", () => {
  const t = analysis(
    [
      sample(-120, 70, "RELATIVE_HUMIDITY_PERCENT"),
      sample(-60, 72, "RELATIVE_HUMIDITY_PERCENT"),
      sample(0, 74, "RELATIVE_HUMIDITY_PERCENT"),
    ],
    "RELATIVE_HUMIDITY_PERCENT",
  );
  assert.equal(t.series[0].threshold_violations, 3);
  assert.equal(t.series[0].direction, "increasing");
  assert.equal(t.thresholds.critical, null);
});
test("profile reevaluation changes breaches without changing observed statistics", () => {
  const a = request(inc);
  const b = { ...a, profile: { ...a.profile, temperature_warning_c: 26 } };
  assert.equal(analyzeTrends(a, 5)[0].series[0].threshold_violations, 0);
  assert.equal(analyzeTrends(b, 5)[0].series[0].threshold_violations, 2);
  assert.equal(
    analyzeTrends(a, 5)[0].series[0].average,
    analyzeTrends(b, 5)[0].series[0].average,
  );
});
test("stale historical increase stays historical and cannot create a current early warning", () => {
  const req = { ...request(inc), as_of: iso(600) };
  const t = analyzeTrends(req, 1),
    i = earlyWarnings(req, t, 1);
  assert.equal(t[0].series[0].stale, true);
  assert(i.some((x) => x.triggering_rule.endsWith("STALE_CURRENT")));
  assert(!i.some((x) => x.classification === "EARLY_WARNING_TREND"));
});
test("fresh temperature increase below threshold produces early warning, not a fault", () => {
  const req = request(inc),
    i = earlyWarnings(req, analyzeTrends(req, 5), 5);
  assert(
    i.some(
      (x) =>
        x.classification === "EARLY_WARNING_TREND" &&
        x.triggering_rule.endsWith("SUSTAINED_INCREASE"),
    ),
  );
  assert(!i.some((x) => x.classification === "OBSERVED_ABNORMAL_CONDITION"));
  for (const item of i) {
    assert(
      item.indicator_id &&
        item.triggering_rule &&
        item.explanation &&
        item.recommended_next_inspection,
    );
  }
});
test("fresh current breach and historical repeated breaches are different observed conditions", () => {
  const r = request([sample(-120, 40), sample(-60, 41), sample(0, 42)]),
    i = earlyWarnings(r, analyzeTrends(r, 5), 5);
  assert(
    i.some(
      (x) =>
        x.triggering_rule.endsWith("CURRENT_THRESHOLD") &&
        x.severity === "CRITICAL",
    ),
  );
  assert(
    i.some(
      (x) =>
        x.triggering_rule.endsWith("REPEATED_THRESHOLD") &&
        x.classification === "OBSERVED_ABNORMAL_CONDITION",
    ),
  );
});
test("newer normal current observation suppresses an old rising-history early warning", () => {
  const r = request(inc, [sample(0, 20)]);
  assert(
    !earlyWarnings(r, analyzeTrends(r, 5), 5).some(
      (i) => i.classification === "EARLY_WARNING_TREND",
    ),
  );
});
for (const m of ["SOUND_RAW", "ULTRASONIC_DISTANCE_CM"] as const)
  test(`${m}: significant observed changes have no fault or calibrated-sound interpretation`, () => {
    const r = request([
      sample(-60, 10, m),
      sample(0, m === "SOUND_RAW" ? 200 : 25, m),
    ]);
    const t = analyzeTrends(r, 5),
      i = earlyWarnings(r, t, 5);
    assert.equal(
      t.find((t) => t.metric_type === m)!.series[0].direction,
      "insufficient_data",
    );
    assert(
      i.some((i) => i.triggering_rule.endsWith("SIGNIFICANT_OBSERVED_CHANGE")),
    );
    assert(i.every((i) => i.classification !== "OBSERVED_ABNORMAL_CONDITION"));
  });
test("missing current metrics do not establish equipment health", () => {
  const r = request([], []),
    i = earlyWarnings(r, analyzeTrends(r, 5), 5);
  assert.equal(
    i.filter((i) => i.triggering_rule.endsWith("MISSING_CURRENT")).length,
    4,
  );
  assert(i.every((i) => i.severity === "UNKNOWN"));
});
test("analysis is bounded by source count and explicitly reports omitted sources", () => {
  const t = analysis(
    Array.from({ length: 20 }, (_, i) =>
      sample(0, 20, "AMBIENT_TEMPERATURE_C", {
        source_identifier: `sensor-${i}`,
      }),
    ),
  );
  assert.equal(t.series.length, 8);
  assert.equal(t.omitted_source_series, 12);
});
test("trend tools preserve immutable snapshot isolation and reject unknown racks", async () => {
  const r = request(inc),
    ds = createSnapshotDataSource(r, { staleAfterMinutes: 5 });
  r.recent_telemetry[0].numeric_value = 99;
  assert.equal(ds.getTelemetryTrends(r.rack_id)[0].series[0].first_value, 25);
  const copy = ds.getTelemetryTrends(r.rack_id);
  copy[0].series[0].first_value = 0;
  assert.equal(ds.getTelemetryTrends(r.rack_id)[0].series[0].first_value, 25);
  const tools = createTools(ds);
  const tool = tools.find((t) => t.name === "analyze_telemetry_trends")!;
  const raw = String(
    await tool.invoke({
      rack_id: r.rack_id,
      metric_type: "AMBIENT_TEMPERATURE_C",
    }),
  );
  assert(raw.length <= MAX_TOOL_RESULT_CHARS);
  assert.equal(JSON.parse(raw).trends[0].series[0].direction, "increasing");
  assert.match(
    String(
      await tool.invoke({
        rack_id: "other",
        metric_type: "AMBIENT_TEMPERATURE_C",
      }),
    ),
    /Unknown rack/,
  );
});
const identity = {
  manufacturer: "Dell",
  model: "PowerEdge R7425",
  provenance: "OPERATOR_PROVIDED" as const,
  assertion: "Identified by the operator from rack inventory",
};
test("generic profiles and photographs never select manufacturer guidance", () => {
  for (const kind of ["Network", "Compute", "Storage", "Industrial"])
    assert.equal(lookupDocumentation(kind).match_status, "NO_MATCH");
  const r = { ...request(inc), equipment_type: "Compute" };
  assert.equal(
    createSnapshotDataSource(r, { staleAfterMinutes: 5 }).lookupDocumentation(
      "Compute",
    ).manufacturer_specification_available,
    false,
  );
});
test("exact operator identity retrieves sourced facts with conditions and citations", () => {
  const r = lookupDocumentation("Compute", "temperature", identity);
  assert.equal(r.match_status, "MATCH");
  const d = r.documents.find((d) => d.doc_id === "DELL-R7425-ENV")!;
  assert.match(d.source_url!, /^https:\/\/(dl\.)?dell.com/);
  assert(
    d.section &&
      d.revision &&
      d.access_date &&
      d.technical_facts?.length &&
      d.limitations?.length &&
      d.applicability_conditions?.length,
  );
});
test("mismatched manufacturer, model suffix, generation, topic or photo-derived identity returns NO_MATCH", () => {
  for (const bad of [
    { ...identity, model: "PowerEdge R750" },
    { ...identity, model: "PowerEdge R7425 extra" },
    { ...identity, manufacturer: "HPE" },
    { ...identity, provenance: "PHOTO_INFERRED" as any },
  ])
    assert.equal(
      lookupDocumentation("Compute", undefined, bad).match_status,
      "NO_MATCH",
    );
  assert.equal(
    lookupDocumentation("Compute", "led", identity).match_status,
    "NO_MATCH",
  );
  assert.equal(
    InvestigationRequest.safeParse({
      ...request(inc),
      equipment_identity: { ...identity, provenance: "PHOTO_INFERRED" },
    }).success,
    false,
  );
});
test("LLM tool arguments cannot invent or override rack equipment identity", async () => {
  const r = { ...request(inc), equipment_type: "Compute" },
    ds = createSnapshotDataSource(r, { staleAfterMinutes: 5 }),
    tool = createDocumentationTool(ds);
  const out = JSON.parse(
    String(
      await tool.invoke({
        equipment_type: "Compute",
        equipment_identity: identity,
      } as any),
    ),
  );
  assert.equal(out.match_status, "NO_MATCH");
  assert.throws(() => ds.lookupDocumentation("Network"), /must match/);
});
test("Cisco LED and HPE environmental references are exact matches; generic family names are not", () => {
  for (const [manufacturer, model, id] of [
    ["Cisco", "C9300-24T", "CISCO-C9300-LED"],
    ["HPE", "ProLiant DL380 Gen11", "HPE-DL380-G11-ENV"],
  ]) {
    const r = lookupDocumentation("Compute", undefined, {
      ...identity,
      manufacturer,
      model,
    });
    assert(r.documents.some((d) => d.doc_id === id));
  }
  assert.equal(
    lookupDocumentation("Network", undefined, {
      ...identity,
      manufacturer: "Cisco",
      model: "Catalyst 9300",
    }).match_status,
    "NO_MATCH",
  );
});
