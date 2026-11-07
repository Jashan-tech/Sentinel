// Regression: the dashboard's freshness window (stale_after_minutes) must reach the
// tools, the evidence and the severity policy end-to-end through POST /investigate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AIMessage } from "@langchain/core/messages";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import { fakeModel, testConfig, toolCall } from "./helpers.js";

const AS_OF = "2026-11-07T22:00:00.000Z";
const at = (secondsAgo: number) => new Date(Date.parse(AS_OF) - secondsAgo * 1000).toISOString();
// One NORMAL-range temperature reading observed 90 s before as_of.
const body = (extra: Record<string, unknown> = {}) => ({
  rack_id: "rack-1",
  rack_name: "Rack 01",
  equipment_type: "Network",
  profile: { name: "Standard Network Rack", temperature_warning_c: 32, temperature_critical_c: 40, humidity_warning_percent: 70 },
  current_telemetry: [
    { metric_type: "AMBIENT_TEMPERATURE_C", numeric_value: 25, unit: "°C", source_type: "SIMULATOR", source_identifier: "t1", observed_at: at(90), ingested_at: at(90), simulated: true },
  ],
  as_of: AS_OF,
  ...extra,
});
const json = (o: unknown) => new AIMessage(JSON.stringify(o));

async function investigate(payload: unknown) {
  const app = createApp({
    getModel: () => ({
      model: fakeModel([
        json({ plan: "p", next: "telemetry", objective: "check", reason: "r" }),
        json({ next: "verification", objective: "verify", reason: "r" }),
        json({ next: "finish", objective: "", reason: "r" }),
        json({ severity: "NORMAL", summary: "s", hypotheses: [], recommended_next_inspection: [], verified_findings: [], missing_information: [] }),
      ]).model,
      specialistModel: fakeModel([
        toolCall("get_current_telemetry", { rack_id: "rack-1" }),
        json({ observations: ["o"], hypotheses: [], missing_information: [], recommended_next_action: "" }),
        json({ grounded: true, verified_findings: [], unsupported_claims: [], contradictions: [], missing_evidence: [], request_more_investigation: false }),
      ]).model,
      config: testConfig, // default STALE_AFTER_MINUTES = 15
    }),
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/investigate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: (await res.json()) as any };
  } finally {
    server.close();
  }
}

for (const [label, minutes, stale] of [
  ["30 seconds", 0.5, true],
  ["60 seconds", 1, true],
  ["5 minutes", 5, false],
] as const) {
  test(`freshness ${label}: a 90 s old reading is ${stale ? "stale" : "fresh"} in tools, evidence and severity`, async () => {
    const { status, body: r } = await investigate(body({ stale_after_minutes: minutes }));
    assert.equal(status, 200);
    const m = r.report.evidence.measurements[0];
    assert.equal(m.stale, stale);
    // Fresh in-range temperature -> NORMAL; only stale data -> UNKNOWN (policy uses the same window).
    assert.equal(r.report.severity, stale ? "UNKNOWN" : "NORMAL");
  });
}

test("freshness omitted: falls back to the configured default (15 min)", async () => {
  const { status, body: r } = await investigate(body());
  assert.equal(status, 200);
  assert.equal(r.report.evidence.measurements[0].stale, false);
  assert.equal(r.report.severity, "NORMAL");
});

test("invalid freshness values are rejected with 400", async () => {
  for (const bad of [0, -1, 2000, "60", null]) {
    const { status } = await investigate(body({ stale_after_minutes: bad }));
    assert.equal(status, 400, `stale_after_minutes=${JSON.stringify(bad)} should be rejected`);
  }
});
