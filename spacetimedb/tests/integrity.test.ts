// fix/investigation-integrity: database-side checks for issues 5, 7, 9 and 10 (pure functions).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateInvestigationCompletion,
  abandonedReport,
  expiredReport,
  isStaleRunning,
  retentionDeletions,
  MAX_INVESTIGATIONS_PER_RACK,
} from "../src/investigation";
import { fairEvictions, RECENT_LIMIT } from "../src/rules";

const report = (extra: object = {}) => ({
  rack_id: "rack-1", investigation_status: "COMPLETED", severity: "CRITICAL", summary: "Measured 41.5 °C.",
  hypotheses: [], recommended_next_inspection: [], tool_calls: [], agents_invoked: [], specialist_findings: [],
  verified_findings: [], missing_information: [], limits_reached: [], unsupported_claims: [], evidence: {},
  verification_outcome: "VERIFIED", incomplete_reasons: [], ...extra,
});
const complete = (r: Record<string, unknown>, rackId = "rack-1", events = "[]") =>
  validateInvestigationCompletion(
    { status: String(r.investigation_status), severity: String(r.severity), reportJson: JSON.stringify(r), eventsJson: events },
    rackId,
  );

test("5: a report must be for the investigated rack", () => {
  complete(report());
  assert.throws(() => complete(report(), "rack-2"), /does not match investigated rack/);
  assert.throws(() => complete(report({ rack_id: undefined })), /rack_id/);
});

test("5: report structure is enforced", () => {
  assert.throws(() => complete(report({ summary: "" })), /summary/);
  assert.throws(() => complete(report({ hypotheses: "none" })), /hypotheses must be an array/);
  assert.throws(() => complete(report({ evidence: null })), /evidence/);
  assert.throws(() => complete(report({ verification_outcome: "TRUST_ME" })), /verification_outcome/);
  assert.throws(() => complete(report(), "rack-1", '[{"type":"START"}]'), /timeline events/);
});

test("5: forged success: COMPLETED is rejected unless verification and processing agree", () => {
  assert.throws(() => complete(report({ verification_outcome: "NOT_GROUNDED" })), /requires VERIFIED/);
  assert.throws(() => complete(report({ verification_outcome: "NOT_RUN" })), /requires VERIFIED/);
  assert.throws(() => complete(report({ incomplete_reasons: ["vision agent failed"] })), /cannot list incomplete reasons/);
  assert.throws(() => complete(report({ investigation_status: "INCOMPLETE", verification_outcome: "NOT_RUN" })), /must state why/);
  assert.throws(() => complete(report({ investigation_status: "FAILED", incomplete_reasons: ["x"], verification_outcome: "FAILED" })), /UNKNOWN severity/);
  complete(report({ verification_outcome: "NOT_REQUIRED", severity: "NORMAL" }));
});

test("5: reports and events may not carry image bytes", () => {
  assert.throws(() => complete(report({ summary: "data:image/png;base64,iVBOR" })), /image data/);
  assert.throws(() => complete(report(), "rack-1", JSON.stringify([{ type: "X", description: "data:image/jpeg;base64,/9j/4AAQ" }])), /image data/);
});

test("5/7: client abandonment and database expiry never contain a diagnosis", () => {
  const a = JSON.parse(abandonedReport("Agent service is unreachable\u0000"));
  assert.equal(a.diagnosis, null);
  assert.equal(a.recorded_by, "CLIENT");
  assert.ok(!a.error.includes("\u0000"));
  assert.equal(JSON.parse(abandonedReport("x".repeat(2000))).error.length, 500);
  assert.match(JSON.parse(abandonedReport("")).error, /abandoned/);
  const e = JSON.parse(expiredReport(300));
  assert.equal(e.recorded_by, "DATABASE");
  assert.match(e.error, /300 s/);
});

test("7: only RUNNING rows older than the timeout are stale", () => {
  const now = 1_000_000_000_000n;
  const at = (s: number) => now - BigInt(s) * 1_000_000n;
  assert.equal(isStaleRunning({ status: "RUNNING", createdMicros: at(301) }, now, 300), true);
  assert.equal(isStaleRunning({ status: "RUNNING", createdMicros: at(300) }, now, 300), false);
  assert.equal(isStaleRunning({ status: "COMPLETED", createdMicros: at(10_000) }, now, 300), false);
});

test("10: retention keeps the newest investigations per rack and never deletes RUNNING rows", () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({ id: `inv-${String(i).padStart(2, "0")}`, status: i === 1 ? "RUNNING" : "COMPLETED", createdMicros: BigInt(i) }));
  const del = retentionDeletions(rows);
  assert.equal(MAX_INVESTIGATIONS_PER_RACK, 20);
  assert.deepEqual(del, ["inv-04", "inv-03", "inv-02", "inv-00"], "oldest terminal rows beyond 20; RUNNING inv-01 kept");
  assert.deepEqual(retentionDeletions(rows.slice(0, 20)), []);
});

test("9: fast sensors cannot crowd slow sensors or other metrics out of recent history", () => {
  let id = 0n;
  const row = (metricType: string, sourceIdentifier: string, t: number) => ({ observationId: ++id, metricType, sourceIdentifier, ingestedMicros: BigInt(t) });
  // A slow humidity sensor (5 readings) and a slow second temperature sensor (5), then a fast temperature sensor (60).
  let rows = [
    ...Array.from({ length: 5 }, (_, i) => row("RELATIVE_HUMIDITY_PERCENT", "hum-slow", i * 100)),
    ...Array.from({ length: 5 }, (_, i) => row("AMBIENT_TEMPERATURE_C", "temp-slow", i * 100 + 1)),
  ];
  for (let i = 0; i < 60; i++) {
    rows.push(row("AMBIENT_TEMPERATURE_C", "temp-fast", 1000 + i));
    const evict = new Set(fairEvictions(rows));
    rows = rows.filter((r) => !evict.has(r.observationId));
  }
  assert.equal(rows.length, RECENT_LIMIT, "per-rack bound preserved");
  const count = (s: string) => rows.filter((r) => r.sourceIdentifier === s).length;
  assert.equal(count("hum-slow"), 5, "slow humidity history survives");
  assert.equal(count("temp-slow"), 5, "slow temperature source survives");
  assert.equal(count("temp-fast"), 40);
  // The fast sensor keeps its NEWEST readings.
  const fast = rows.filter((r) => r.sourceIdentifier === "temp-fast").map((r) => Number(r.ingestedMicros));
  assert.equal(Math.min(...fast), 1020);
});

test("9: below the limit nothing is evicted; ties evict the oldest row", () => {
  const rows = [
    { observationId: 1n, metricType: "SOUND_RAW", sourceIdentifier: "a", ingestedMicros: 5n },
    { observationId: 2n, metricType: "SOUND_RAW", sourceIdentifier: "b", ingestedMicros: 1n },
  ];
  assert.deepEqual(fairEvictions(rows, 2), []);
  assert.deepEqual(fairEvictions(rows, 1), [2n]);
});

// ---- live investigation progress ----
import { validateProgress } from "../src/investigation";
test("progress: small, structured, descriptive steps only", () => {
  const ok = JSON.stringify([{ agent: "telemetry", state: "done", started_at: "2026-11-08T07:00:00Z", ended_at: "2026-11-08T07:00:06Z", tool_calls: 4 }]);
  validateProgress("Verification agent is cross-checking", ok);
  validateProgress("Supervisor is planning", "[]");
  for (const [phase, steps] of [
    ["", ok],
    ["x".repeat(201), ok],
    ["p", "not json"],
    ["p", "{}"],
    ["p", JSON.stringify([{ agent: "hacker", state: "done", started_at: "2026-11-08T07:00:00Z", tool_calls: 0 }])],
    ["p", JSON.stringify([{ agent: "telemetry", state: "maybe", started_at: "2026-11-08T07:00:00Z", tool_calls: 0 }])],
    ["p", JSON.stringify([{ agent: "telemetry", state: "done", started_at: "soon", tool_calls: 0 }])],
    ["p", JSON.stringify([{ agent: "telemetry", state: "done", started_at: "2026-11-08T07:00:00Z", tool_calls: -1 }])],
    ["p", "[" + Array(31).fill('{"agent":"telemetry","state":"done","started_at":"2026-11-08T07:00:00Z","tool_calls":0}').join(",") + "]"],
    ["p", JSON.stringify([{ agent: "telemetry", state: "done", started_at: "2026-11-08T07:00:00Z", tool_calls: 0, note: "y".repeat(5000) }])],
  ] as const)
    assert.throws(() => validateProgress(phase, steps), Error, `${phase.slice(0, 20)} ${steps.slice(0, 60)}`);
});
