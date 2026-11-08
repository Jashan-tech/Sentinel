// Phase 1 regression tests (fix/investigation-integrity): input validation, mandatory visual
// verification, report verification integrity, and history statistics consistency.
// All model output here is SCRIPTED (fakeModel); no NVIDIA inference is involved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AIMessage } from "@langchain/core/messages";
import type { AddressInfo } from "node:net";
import { acceptImage } from "../src/images.js";
import { runMultiAgentInvestigation, type MultiAgentOptions } from "../src/multiagent.js";
import { createSnapshotDataSource, createTools } from "../src/tools.js";
import { createApp } from "../src/app.js";
import { InvestigationRequest, METRIC_RULES, MultiAgentReport } from "../src/schemas.js";
import { METRICS as DB_METRICS } from "../../spacetimedb/src/rules.js";
import { fakeModel, hang, rawFixture, testConfig, toolCall, type Step } from "./helpers.js";

const JPEG = readFileSync(new URL("../test-assets/vision/switch-5port-led-closeup.jpg", import.meta.url));
const json = (o: unknown) => new AIMessage(JSON.stringify(o));
const decide = (next: string, objective = "", plan?: string) => json({ plan, next, objective, reason: `because ${next}` });
const findings = (obs = "AMBIENT_TEMPERATURE_C 35.4 °C (sim-temp-01, SIMULATED)") =>
  json({ observations: [obs], hypotheses: [], missing_information: [], recommended_next_action: "" });
const visionOut = () =>
  json({
    visual_findings: [
      { observation: "Red cable plugged into port 5", component: "port", image_location: "right", category: "PORT", visual_evidence: "plug", certainty: "CERTAIN", potential_concern: null, limitations: "", recommended_follow_up: "" },
    ],
    unreadable_regions: [], additional_photos_needed: [], hypotheses: [], missing_information: [], recommended_next_action: "",
  });
const verdict = (extra: object = {}) =>
  json({ grounded: true, verified_findings: ["Red cable visible in port 5"], unsupported_claims: [], contradictions: [], missing_evidence: [], request_more_investigation: false, ...extra });
const synthesis = (severity: string, extra: object = {}) =>
  json({ severity, summary: "s", hypotheses: [], recommended_next_inspection: [], verified_findings: [], missing_information: [], ...extra });

const img = { filename: "switch.jpg", mime_type: "image/jpeg", data_base64: JPEG.toString("base64"), source_type: "ONLINE_REFERENCE" };
const withImage = (name: string, extra: Record<string, unknown> = {}) =>
  InvestigationRequest.parse({ ...rawFixture(name), images: [img], ...extra });

function run(req: InvestigationRequest, sup: Step[], spec: Step[], vis: Step[] = [], over: Partial<MultiAgentOptions> = {}) {
  const s = fakeModel(sup), p = fakeModel(spec), v = fakeModel(vis);
  return runMultiAgentInvestigation(req, {
    supervisorModel: s.model, specialistModel: p.model, visionModel: v.model,
    supervisorModelName: "fake-super", specialistModelName: "fake-super", visionModelName: "fake-vl",
    dataSource: createSnapshotDataSource(req, { staleAfterMinutes: 15 }), staleAfterMinutes: 15,
    maxDelegations: 5, maxSpecialistToolRounds: 3, maxVerificationRetries: 1, maxInvestigationSeconds: 90,
    images: req.images.map((i) => acceptImage(i)), ...over,
  }).then((r) => ({ ...r, sup: s, spec: p, vis: v }));
}
const agents = (r: MultiAgentReport) => r.agents_invoked.map((a) => a.agent);

// ============ 1. Agent input validation ============

const reading = (over: Record<string, unknown> = {}) => ({
  metric_type: "AMBIENT_TEMPERATURE_C", numeric_value: 30, unit: "°C", source_type: "SIMULATOR",
  source_identifier: "sim-temp-01", observed_at: "2026-11-07T13:59:00.000Z", ingested_at: "2026-11-07T13:59:01.000Z", simulated: true, ...over,
});
const withReading = (over: Record<string, unknown>, where: "current_telemetry" | "recent_telemetry" = "current_telemetry") => ({
  ...rawFixture("a-normal"), [where]: [reading(over)],
});

test("1: agent sensor rules are identical to the SpacetimeDB rules (units and bounds)", () => {
  assert.deepEqual(METRIC_RULES, DB_METRICS);
});

test("1: valid readings in database units are accepted", () => {
  for (const [metric, r] of Object.entries(METRIC_RULES))
    assert.ok(InvestigationRequest.safeParse(withReading({ metric_type: metric, unit: r.unit, numeric_value: r.min })).success, metric);
});

for (const [label, over, where] of [
  ["audit repro: 999 with an incorrect unit", { numeric_value: 999, unit: "C" }],
  ["temperature above 100 °C", { numeric_value: 999 }],
  ["temperature below -50 °C", { numeric_value: -51 }],
  ["humidity above 100 %RH", { metric_type: "RELATIVE_HUMIDITY_PERCENT", unit: "%RH", numeric_value: 101 }],
  ["negative raw sound", { metric_type: "SOUND_RAW", unit: "raw", numeric_value: -1 }],
  ["negative distance", { metric_type: "ULTRASONIC_DISTANCE_CM", unit: "cm", numeric_value: -0.5 }],
  ["legacy unit 'C'", { unit: "C" }],
  ["unit for another metric", { unit: "%RH" }],
  ["humidity in '%'", { metric_type: "RELATIVE_HUMIDITY_PERCENT", unit: "%", numeric_value: 40 }],
  ["Fahrenheit", { unit: "°F", numeric_value: 80 }],
  ["unauthorized source type", { source_type: "REDFISH", simulated: false }],
  ["ROVER labelled simulated", { source_type: "ROVER", simulated: true }],
  ["SIMULATOR labelled non-simulated", { simulated: false }],
  ["blank source identifier", { source_identifier: "   " }],
  ["source identifier over 100 chars", { source_identifier: "s".repeat(101) }],
  ["observed after as_of (beyond 30 s)", { observed_at: "2026-11-07T14:00:31.000Z", ingested_at: "2026-11-07T14:00:31.000Z" }],
  ["ingested before observed (beyond 30 s)", { observed_at: "2026-11-07T13:59:00.000Z", ingested_at: "2026-11-07T13:58:00.000Z" }],
  ["ingested after as_of (beyond 30 s)", { ingested_at: "2026-11-07T14:05:00.000Z" }],
  ["epoch timestamp", { observed_at: "1970-01-01T00:00:00.000Z", ingested_at: "1970-01-01T00:00:01.000Z" }],
  ["out-of-range history value", { numeric_value: 1e6 }, "recent_telemetry"],
] as const)
  test(`1: rejects ${label}`, () => {
    const r = InvestigationRequest.safeParse(withReading(over, where ?? "current_telemetry"));
    assert.equal(r.success, false, JSON.stringify(over));
  });

test("1: rejects conflicting duplicate observation ids", () => {
  const body = { ...rawFixture("a-normal"), recent_telemetry: [reading({ observation_id: "7" }), reading({ observation_id: "7", numeric_value: 31 })] };
  assert.equal(InvestigationRequest.safeParse(body).success, false);
});

test("1: rejects invalid profiles", () => {
  for (const profile of [
    { name: "p", temperature_warning_c: 32, temperature_critical_c: 400 },
    { name: "p", temperature_warning_c: 32, temperature_critical_c: 40, humidity_warning_percent: 80, humidity_critical_percent: 70 },
  ])
    assert.equal(InvestigationRequest.safeParse({ ...rawFixture("a-normal"), profile }).success, false, JSON.stringify(profile));
});

for (const [label, over] of [
  ["URL without host", { source_url: "http://" }],
  ["URL with embedded credentials", { source_url: "https://user:pw@example.org/x.jpg" }],
  ["non-http URL", { source_url: "javascript:alert(1)" }],
  ["URL with whitespace", { source_url: "https://exa mple.org/x" }],
  ["capture time in the future", { capture_timestamp: "2999-01-01T00:00:00.000Z" }],
  ["filename with a path", { filename: "../../etc/passwd.jpg" }],
  ["filename with control characters", { filename: "a\u0000b.jpg" }],
  ["attribution with control characters", { attribution: "x\u0007" }],
] as const)
  test(`1: rejects malformed image provenance: ${label}`, () => {
    assert.equal(InvestigationRequest.safeParse({ ...rawFixture("a-normal"), images: [{ ...img, ...over }] }).success, false);
  });

test("1: HTTP rejects the audit repro (999, wrong unit) with 400 before any model call", async () => {
  let modelCalls = 0;
  const counting = { bindTools: () => { throw new Error("no"); }, invoke: async () => { modelCalls++; return new AIMessage("{}"); } } as any;
  const app = createApp({ getModel: () => ({ model: counting, specialistModel: counting, config: testConfig }) });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/investigate`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(withReading({ numeric_value: 999, unit: "C" })),
    });
    assert.equal(res.status, 400);
    assert.equal(modelCalls, 0);
  } finally {
    server.close();
  }
});

// ============ 2. Mandatory visual verification ============

test("2: image-only: verification runs even when the Supervisor tries to finish right after vision", async () => {
  const { report, events } = await run(withImage("a-normal"), [decide("vision", "x", "p"), decide("finish"), decide("finish"), synthesis("NORMAL")], [], [visionOut(), verdict()]);
  assert.deepEqual(agents(report), ["vision", "verification"]);
  assert.equal(report.verification_outcome, "VERIFIED");
  assert.equal(report.investigation_status, "COMPLETED");
  assert.ok(events.some((e) => e.type === "GUARD" && /mandatory/i.test(e.description)));
});

test("2: image-only: verification runs even when vision used the last delegation", async () => {
  const { report } = await run(withImage("a-normal"), [decide("vision", "x", "p"), decide("telemetry", "more"), decide("finish"), synthesis("NORMAL")], [], [visionOut(), verdict()], { maxDelegations: 1 });
  assert.deepEqual(agents(report), ["vision", "verification"]);
  assert.equal(report.verification_outcome, "VERIFIED");
});

test("2: combined: verification that ran before vision is re-run after vision", async () => {
  const req = withImage("c-critical");
  const { report } = await run(
    req,
    [decide("telemetry", "t", "p"), decide("verification", "v1"), decide("vision", "photo"), decide("finish"), decide("finish"), synthesis("CRITICAL")],
    [findings(), verdict({ verified_findings: ["35.4 °C exceeds 33 °C"] })],
    [visionOut(), verdict()],
  );
  assert.deepEqual(agents(report), ["telemetry", "verification", "vision", "verification"]);
  assert.deepEqual(report.verified_findings, ["Red cable visible in port 5"]);
});

test("2: image-only with failed Vision: no verification of nothing; report is INCOMPLETE, never COMPLETED", async () => {
  const { report } = await run(withImage("a-normal"), [decide("vision", "x", "p"), decide("finish"), synthesis("NORMAL")], [], [new Error("503 Service Unavailable")]);
  assert.deepEqual(agents(report), ["vision"]);
  assert.equal(report.verification_outcome, "NOT_RUN");
  assert.equal(report.investigation_status, "INCOMPLETE");
  assert.ok(report.incomplete_reasons.some((r) => /vision/i.test(r)));
});

test("2: combined with failed Vision: telemetry findings are still verified; report INCOMPLETE", async () => {
  const req = withImage("a-normal");
  const { report } = await run(req, [decide("telemetry", "t", "p"), decide("vision", "v"), decide("finish"), decide("finish"), synthesis("NORMAL")], [findings("24.1 °C"), verdict({ verified_findings: ["24.1 °C"] })], [new Error("500 boom")]);
  assert.deepEqual(agents(report), ["telemetry", "vision", "verification"]);
  assert.equal(report.investigation_status, "INCOMPLETE");
});

test("2: verification model failure is explicit: FAILED outcome, no verified findings, INCOMPLETE", async () => {
  const { report } = await run(withImage("a-normal"), [decide("vision", "x", "p"), decide("finish"), decide("finish"), synthesis("NORMAL", { verified_findings: ["made up"] })], [], [visionOut(), new Error("503 down")]);
  assert.equal(report.verification_outcome, "FAILED");
  assert.deepEqual(report.verified_findings, []);
  assert.equal(report.investigation_status, "INCOMPLETE");
});

test("2: verification timeout is explicit (not silently skipped)", async () => {
  // Vision consumes the budget; there is no time left for a verification call.
  let now = Date.now();
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const slowVision = () => { now += 80_000; return visionOut() as AIMessage; };
    const { report } = await run(withImage("a-normal"), [decide("vision", "x", "p"), synthesis("NORMAL")], [], [slowVision]);
    assert.notEqual(report.verification_outcome, "VERIFIED");
    assert.ok(["FAILED", "NOT_RUN"].includes(report.verification_outcome));
    assert.ok(report.limits_reached.includes("VERIFICATION_TIMEOUT"));
    assert.equal(report.investigation_status, "INCOMPLETE");
  } finally {
    Date.now = realNow;
  }
});

test("2 (live run): a hung verification call is aborted by the enforced deadline and reported as FAILED", async () => {
  // Live: verification started at 34.6 s with ~80 s budget and was only aborted at 238.6 s
  // (per-attempt HTTP timeout multiplied by retries). Every call now carries an AbortSignal.
  // Vision "takes" 64.6 s of a 90 s budget (clock shifted), leaving 25.4 s: enough for the gate to run
  // verification with a ~10.4 s budget. The hung call must end at that budget, not minutes later.
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  const t0 = realNow();
  let report: MultiAgentReport;
  try {
    const slowVision: Step = () => { offset += 64_600; return visionOut(); };
    ({ report } = await run(withImage("a-normal"), [decide("vision", "x", "p"), decide("finish"), synthesis("NORMAL")], [], [slowVision, hang]));
  } finally {
    Date.now = realNow;
  }
  const elapsed = realNow() - t0;
  assert.ok(elapsed > 9000 && elapsed < 13_000, `verification should be aborted at its ~10.4 s budget, took ${elapsed} ms`);
  assert.equal(report.verification?.status, "FAILED");
  assert.equal(report.verification_outcome, "FAILED");
  assert.equal(report.investigation_status, "INCOMPLETE");
});

test("7: caller cancellation aborts in-flight model calls", async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  const t0 = Date.now();
  const { report } = await run(InvestigationRequest.parse(rawFixture("a-normal")), [hang, synthesis("NORMAL")], [], [], { signal: ac.signal });
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(report.investigation_status, "FAILED");
});

test("7: the hard deadline bounds the whole investigation even if synthesis hangs", async () => {
  const t0 = Date.now();
  const { report } = await run(InvestigationRequest.parse(rawFixture("a-normal")), [hang], [], [], { maxInvestigationSeconds: 0.2 } as any);
  assert.ok(Date.now() - t0 < 16_000 + 2000);
  assert.equal(report.investigation_status, "FAILED");
});

// ============ 3. Report verification integrity ============

test("3: grounded:false verification never yields a COMPLETED report", async () => {
  const req = withImage("c-critical");
  const { report } = await run(
    req,
    [decide("telemetry", "t", "p"), decide("vision", "v"), decide("verification", "v"), decide("finish"), synthesis("CRITICAL")],
    [findings()],
    [visionOut(), verdict({ grounded: false, unsupported_claims: ["Cabling caused the temperature rise"] })],
  );
  assert.equal(report.verification_outcome, "NOT_GROUNDED");
  assert.equal(report.investigation_status, "INCOMPLETE");
  assert.deepEqual(report.unsupported_claims, ["Cabling caused the temperature rise"]);
});

test("3 (live run): grounded:true with an unresolved contradiction is NOT_GROUNDED; 'No contradiction' entries are ignored", async () => {
  const req = InvestigationRequest.parse(rawFixture("c-critical"));
  const script = (contradictions: string[]) =>
    run(req, [decide("telemetry", "t", "p"), decide("verification", "v"), decide("finish"), synthesis("CRITICAL")], [findings(), verdict({ grounded: true, contradictions })]);
  const bad = await script(["Vision says ports 1-4 appear empty but also reports a yellow cable in port 3", "No contradiction between telemetry tools: values are consistent"]);
  assert.equal(bad.report.verification_outcome, "NOT_GROUNDED");
  assert.equal(bad.report.investigation_status, "INCOMPLETE");
  assert.ok(bad.report.incomplete_reasons.some((r) => /1 unresolved contradiction/.test(r)));
  const ok = await script(["No contradiction between telemetry tools: values are consistent", "None"]);
  assert.equal(ok.report.verification_outcome, "VERIFIED");
  assert.equal(ok.report.investigation_status, "COMPLETED");
});

test("3: an INCOMPLETE specialist means the report is not COMPLETED", async () => {
  const req = rawFixture("a-normal");
  const { report } = await run(InvestigationRequest.parse(req), [decide("telemetry", "x", "p"), decide("finish"), synthesis("NORMAL")], [new AIMessage("not json"), new AIMessage("still not json")]);
  assert.equal(report.specialist_findings[0].status, "INCOMPLETE");
  assert.equal(report.investigation_status, "INCOMPLETE");
  assert.ok(report.incomplete_reasons.some((r) => /telemetry/.test(r)));
});

test("3: verified_findings only contains claims the Verification Agent explicitly accepted", async () => {
  const req = InvestigationRequest.parse(rawFixture("c-critical"));
  const { report } = await run(
    req,
    [decide("telemetry", "t", "p"), decide("verification", "v"), decide("finish"),
     synthesis("CRITICAL", { verified_findings: ["35.4 °C exceeds 33 °C", "Fan failure confirmed"] })],
    [findings(), verdict({ verified_findings: ["35.4 °C exceeds 33 °C", "Airflow is blocked"], unsupported_claims: ["Airflow is blocked"] })],
  );
  assert.deepEqual(report.verified_findings, ["35.4 °C exceeds 33 °C"]);
});

test("3: final synthesis cannot re-introduce an unsupported claim as a hypothesis", async () => {
  const req = InvestigationRequest.parse(rawFixture("c-critical"));
  const hyp = (d: string) => ({ description: d, supporting_evidence: [], contradicting_evidence: [], missing_evidence: [] });
  const { report, events } = await run(
    req,
    [decide("telemetry", "t", "p"), decide("verification", "v"), decide("finish"),
     synthesis("CRITICAL", { hypotheses: [hyp("A failed fan caused the overheating"), hyp("Insufficient cooling airflow")] })],
    [findings(), verdict({ unsupported_claims: ["A failed fan caused the overheating: no fan telemetry exists"] })],
  );
  assert.deepEqual(report.hypotheses.map((h) => h.description), ["Insufficient cooling airflow"]);
  assert.ok(events.some((e) => e.type === "GUARD" && /unsupported/i.test(e.description)));
});

test("3: verified findings from an INCOMPLETE verification are not reported as verified", async () => {
  const req = InvestigationRequest.parse(rawFixture("c-critical"));
  const loop = Array.from({ length: 4 }, () => toolCall("get_current_telemetry", { rack_id: req.rack_id }));
  const { report } = await run(req, [decide("telemetry", "t", "p"), decide("verification", "v"), decide("finish"), synthesis("CRITICAL")], [findings(), ...loop, verdict()]);
  assert.equal(report.verification?.status, "INCOMPLETE");
  assert.equal(report.verification_outcome, "INCOMPLETE");
  assert.deepEqual(report.verified_findings, []);
  assert.equal(report.investigation_status, "INCOMPLETE");
});

test("3: normal rack without required verification stays COMPLETED with NOT_REQUIRED", async () => {
  const req = InvestigationRequest.parse(rawFixture("a-normal"));
  const { report } = await run(req, [decide("telemetry", "x", "p"), decide("finish"), synthesis("NORMAL", { verified_findings: ["invented"] })], [findings("24.1 °C")]);
  assert.equal(report.verification_required, false);
  assert.equal(report.verification_outcome, "NOT_REQUIRED");
  assert.deepEqual(report.verified_findings, []);
  assert.equal(report.investigation_status, "COMPLETED");
});

test("3: findings added after the last verification are re-verified when verification is required", async () => {
  const req = InvestigationRequest.parse(rawFixture("c-critical"));
  const { report } = await run(
    req,
    [decide("telemetry", "t", "p"), decide("verification", "v"), decide("documentation", "follow-up"), decide("finish"), decide("finish"), synthesis("CRITICAL")],
    [findings(), verdict({ request_more_investigation: true, follow_up_agent: "documentation", follow_up_objective: "specs" }), findings("no spec"), verdict()],
  );
  assert.deepEqual(agents(report), ["telemetry", "verification", "documentation", "verification"]);
  assert.equal(report.verification_outcome, "VERIFIED");
});

// ============ 4. History statistics consistency ============

function history(n: number, opts: { shuffle?: boolean } = {}) {
  const base = Date.parse("2026-11-07T13:00:00Z");
  const rows = Array.from({ length: n }, (_, i) =>
    reading({
      observation_id: String(i),
      numeric_value: 20 + i * 0.25,
      source_identifier: `simulated-ambient-temperature-sensor-${String(i % 3).padStart(2, "0")}`,
      observed_at: new Date(base + i * 60_000).toISOString(),
      ingested_at: new Date(base + i * 60_000 + 1000).toISOString(),
    }),
  );
  if (opts.shuffle) rows.reverse();
  return InvestigationRequest.parse({ ...rawFixture("a-normal"), recent_telemetry: rows });
}
async function callHistory(req: InvestigationRequest, limit = 50) {
  const tool = createTools(createSnapshotDataSource(req, { staleAfterMinutes: 15 })).find((t) => t.name === "get_telemetry_history")!;
  return JSON.parse(String(await tool.invoke({ rack_id: req.rack_id, metric_type: "AMBIENT_TEMPERATURE_C", limit })));
}

test("4: audit repro: when 50 observations are trimmed to fit, stats describe exactly the returned observations", async () => {
  const r = await callHistory(history(50));
  assert.ok(r.returned < 50, `expected trimming, got ${r.returned}`);
  const vals = r.observations.map((o: any) => o.numeric_value);
  assert.equal(r.returned, r.observations.length);
  assert.equal(r.stats.count, r.observations.length);
  assert.equal(r.stats.first, vals[0]);
  assert.equal(r.stats.last, vals.at(-1));
  assert.equal(r.stats.min, Math.min(...vals));
  assert.equal(r.stats.max, Math.max(...vals));
  assert.equal(r.stats.average, Math.round((vals.reduce((a: number, b: number) => a + b, 0) / vals.length) * 100) / 100);
  assert.equal(r.stats.change_first_to_last, Math.round((vals.at(-1) - vals[0]) * 100) / 100);
  assert.equal(r.total_available, 50);
  assert.equal(r.truncated_oldest, 50 - r.returned);
  assert.equal(r.window.from, r.observations[0].observed_at);
  assert.equal(r.window.to, r.observations.at(-1).observed_at);
});

test("4: history is chronological (oldest to newest) regardless of input order; newest are kept", async () => {
  const r = await callHistory(history(12, { shuffle: true }), 5);
  const times = r.observations.map((o: any) => Date.parse(o.observed_at));
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  assert.equal(r.returned, 5);
  assert.equal(r.stats.last, 20 + 11 * 0.25);
  assert.equal(r.stats.first, 20 + 7 * 0.25);
});

test("4: evidence history entry matches the returned window exactly", async () => {
  const req = history(50);
  const { report } = await run(
    req,
    [decide("telemetry", "t", "p"), decide("finish"), synthesis("NORMAL")],
    [toolCall("get_telemetry_history", { rack_id: req.rack_id, metric_type: "AMBIENT_TEMPERATURE_C", limit: 50 }), findings()],
  );
  const h = report.evidence.history[0] as any;
  const direct = await callHistory(req);
  assert.equal(h.observations, direct.returned);
  assert.equal(h.from, direct.observations[0].observed_at);
  assert.deepEqual(h.stats, direct.stats);
});
