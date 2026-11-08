// Contract test: the dashboard's SpacetimeDB -> agent adapter must produce a request
// the agent accepts, without inventing readings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInvestigationRequest, validateInvestigationResponse, toIso, snapshotForStorage, sniffImageType } from "../../dashboard/src/investigation.js";
import { readFileSync } from "node:fs";
import { acceptImage } from "../src/images.js";
import { InvestigationRequest } from "../src/schemas.js";

const us = (iso: string) => ({ microsSinceUnixEpoch: BigInt(Date.parse(iso)) * 1000n });
const obs = (rackId: string, metricType: string, v: number, unit: string, at: string) => ({
  rackId, metricType, numericValue: v, unit, sourceType: "SIMULATOR", sourceIdentifier: "dashboard-demo", observedAt: us(at), ingestedAt: us(at),
});
const base = {
  rack: { rackId: "rack-1", displayName: "Rack 01", profileId: "standard" },
  profile: { profileId: "standard", name: "Standard Network Rack", equipmentType: "Network", temperatureWarningC: 32, temperatureCriticalC: 40, humidityWarningPercent: 70 },
  current: [obs("rack-1", "AMBIENT_TEMPERATURE_C", 41.5, "°C", "2026-11-07T22:00:00Z"), obs("rack-2", "AMBIENT_TEMPERATURE_C", 20, "°C", "2026-11-07T22:00:00Z")],
  recent: [obs("rack-1", "AMBIENT_TEMPERATURE_C", 41.5, "°C", "2026-11-07T22:00:00Z"), obs("rack-1", "AMBIENT_TEMPERATURE_C", 30, "°C", "2026-11-07T21:59:00Z")],
  alerts: [
    { alertId: "rack-1:AMBIENT_TEMPERATURE_C", rackId: "rack-1", metricType: "AMBIENT_TEMPERATURE_C", severity: "CRITICAL", message: "Temperature critical", active: true, createdAt: us("2026-11-07T22:00:01Z") },
    { alertId: "rack-1:RELATIVE_HUMIDITY_PERCENT", rackId: "rack-1", metricType: "RELATIVE_HUMIDITY_PERCENT", severity: "WARNING", message: "old", active: false, createdAt: us("2026-11-07T21:00:00Z") },
  ],
  asOf: new Date("2026-11-07T22:00:10Z"),
  staleAfterSeconds: 60,
};

test("adapter output passes the agent's request schema and preserves provenance", () => {
  const req = InvestigationRequest.parse(buildInvestigationRequest(base));
  assert.equal(req.rack_id, "rack-1");
  assert.equal(req.equipment_type, "Network");
  assert.equal(req.profile.temperature_critical_c, 40);
  assert.equal(req.current_telemetry.length, 1, "only the selected rack");
  assert.deepEqual(req.current_telemetry[0], {
    metric_type: "AMBIENT_TEMPERATURE_C", numeric_value: 41.5, unit: "°C", source_type: "SIMULATOR",
    source_identifier: "dashboard-demo", observed_at: "2026-11-07T22:00:00.000Z", ingested_at: "2026-11-07T22:00:00.000Z", simulated: true,
  });
  assert.deepEqual(req.recent_telemetry.map((r) => r.numeric_value), [30, 41.5], "oldest first");
  assert.equal(req.active_alerts.length, 1, "inactive alerts excluded");
  assert.equal(req.stale_after_minutes, 1);
});

test("adapter keeps missing readings missing", () => {
  const req = InvestigationRequest.parse(buildInvestigationRequest({ ...base, current: [], recent: [], alerts: [] }));
  assert.deepEqual(req.current_telemetry, []);
  assert.deepEqual(req.recent_telemetry, []);
});

test("timestamps convert to ISO 8601", () => {
  assert.equal(toIso(us("2026-11-07T22:00:00.123Z")), "2026-11-07T22:00:00.123Z");
});

test("response validation rejects wrong rack, single-agent reports and bad statuses", () => {
  const report = { rack_id: "rack-1", severity: "CRITICAL", summary: "s", investigation_status: "COMPLETED", hypotheses: [], recommended_next_inspection: [], tool_calls: [], agents_invoked: [], specialist_findings: [], verified_findings: [], missing_information: [], limits_reached: [], evidence: {} };
  assert.ok(validateInvestigationResponse({ report, events: [] }, "rack-1"));
  assert.throws(() => validateInvestigationResponse({ report, events: [] }, "rack-2"), /not rack-2/);
  assert.throws(() => validateInvestigationResponse({ report: { ...report, agents_invoked: undefined }, events: [] }, "rack-1"), /multi-agent/);
  assert.throws(() => validateInvestigationResponse({ report: { ...report, investigation_status: "DONE" }, events: [] }, "rack-1"), /status/);
});

test("image request: passes the agent schema and byte validation; VISUAL mode sends no telemetry; storage has no bytes", () => {
  const bytes = readFileSync(new URL("../test-assets/vision/switch-5port-led-closeup.jpg", import.meta.url));
  assert.equal(sniffImageType(bytes), "image/jpeg");
  const image = {
    imageId: "img-1", filename: "switch.jpg", mimeType: "image/jpeg" as const, base64: bytes.toString("base64"),
    sha256: "x".repeat(64), byteSize: bytes.length, width: 1920, height: 1272, thumbnailDataUrl: "",
    sourceType: "ONLINE_REFERENCE" as const, captureTimestamp: null, sourceUrl: "https://commons.wikimedia.org/wiki/File:X.jpg", attribution: "A", license: "CC0",
  };
  const combined = InvestigationRequest.parse(buildInvestigationRequest(base, { mode: "COMBINED", image }));
  assert.equal(combined.inspection_mode, "COMBINED");
  assert.equal(combined.current_telemetry.length, 1);
  assert.equal(acceptImage(combined.images[0]).provenance.image_id, "img-1");
  assert.equal(acceptImage(combined.images[0]).provenance.capture_timestamp, null);
  const visual = InvestigationRequest.parse(buildInvestigationRequest(base, { mode: "VISUAL", image }));
  assert.deepEqual([visual.current_telemetry, visual.recent_telemetry, visual.active_alerts], [[], [], []]);
  const stored = JSON.stringify(snapshotForStorage(buildInvestigationRequest(base, { mode: "COMBINED", image }), image));
  assert.ok(!stored.includes("data_base64") && !stored.includes(image.base64.slice(0, 100)));
  assert.match(stored, /"sha256":"x{64}"/);
  assert.equal("images" in buildInvestigationRequest(base), false, "telemetry-only requests unchanged");
});
