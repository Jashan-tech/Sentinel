import { test } from "node:test";
import assert from "node:assert/strict";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { AddressInfo } from "node:net";
import { createAgentToolsets, runMultiAgentInvestigation, type MultiAgentOptions } from "../src/multiagent.js";
import { createSnapshotDataSource } from "../src/tools.js";
import { createApp } from "../src/app.js";
import { MultiAgentReport, InvestigationEvent, type InvestigationRequest } from "../src/schemas.js";
import { fakeModel, fixture, rawFixture, testConfig, toolCall, type Step } from "./helpers.js";

const json = (o: unknown) => new AIMessage(JSON.stringify(o));
const decide = (next: string, objective = "", plan?: string) => json({ plan, next, objective, reason: `because ${next}` });
const findings = (obs = "AMBIENT_TEMPERATURE_C 35.4 C (sim-temp-01, 2026-11-07T13:59:00Z, SIMULATED)") =>
  json({ observations: [obs], hypotheses: [{ description: "Insufficient cooling", supporting_evidence: ["35.4 C > 33 C"], contradicting_evidence: [], missing_evidence: ["fan status"] }], missing_information: ["fan RPM unavailable"], recommended_next_action: "verify" });
const verdict = (extra: object = {}) =>
  json({ grounded: true, verified_findings: ["35.4 C exceeds 33 C critical"], unsupported_claims: [], contradictions: [], missing_evidence: ["fan status"], request_more_investigation: false, follow_up_agent: null, follow_up_objective: null, ...extra });
const synthesis = (severity = "CRITICAL") =>
  json({ severity, summary: "Measured 35.4 C vs configured critical 33 C (fictional demo threshold).", hypotheses: [], recommended_next_inspection: ["Inspect airflow"], verified_findings: ["35.4 C exceeds 33 C"], missing_information: ["fan RPM"] });

const textOfAll = (msgs: BaseMessage[]) => msgs.map((m) => String(m.content)).join("\n");

function run(req: InvestigationRequest, sup: Step[], spec: Step[], over: Partial<MultiAgentOptions> = {}) {
  const s = fakeModel(sup);
  const p = fakeModel(spec);
  return runMultiAgentInvestigation(req, {
    supervisorModel: s.model,
    specialistModel: p.model,
    supervisorModelName: "fake-super",
    specialistModelName: "fake-spec",
    dataSource: createSnapshotDataSource(req, { staleAfterMinutes: 15 }),
    staleAfterMinutes: 15,
    maxDelegations: 5,
    maxSpecialistToolRounds: 3,
    maxVerificationRetries: 1,
    maxInvestigationSeconds: 90,
    ...over,
  }).then((r) => ({ ...r, sup: s, spec: p }));
}

test("supervisor routes to specialists and verification; findings and evidence flow through shared state", async () => {
  const req = fixture("c-critical");
  const { report, events, sup, spec } = await run(
    req,
    [decide("telemetry", "check temp trend", "Check trend, then environment, then verify."), decide("environment", "correlate sound"), decide("verification", "verify"), decide("finish"), synthesis()],
    [
      toolCall("get_telemetry_history", { rack_id: req.rack_id, metric_type: "AMBIENT_TEMPERATURE_C" }),
      toolCall("get_rack_profile", { rack_id: req.rack_id }),
      findings(),
      toolCall("get_current_telemetry", { rack_id: req.rack_id }),
      findings("SOUND_RAW 910 raw (sim-mic-01, SIMULATED)"),
      toolCall("get_current_telemetry", { rack_id: req.rack_id, metric_type: "AMBIENT_TEMPERATURE_C" }),
      verdict(),
    ],
  );
  MultiAgentReport.parse(report);
  for (const e of events) InvestigationEvent.parse(e);
  assert.equal(report.investigation_status, "COMPLETED");
  assert.equal(report.supervisor_plan, "Check trend, then environment, then verify.");
  assert.deepEqual(report.agents_invoked.map((a) => a.agent), ["telemetry", "environment", "verification"]);
  assert.deepEqual([...new Set(report.tool_calls.map((t) => t.agent))], ["telemetry", "environment", "verification"]);
  assert.equal(report.specialist_findings.length, 2);
  assert.equal(report.verification?.grounded, true);
  // Evidence passing: environment agent saw telemetry's finding; supervisor saw both + verification.
  assert.match(textOfAll(spec.calls[3]), /35\.4 C \(sim-temp-01/);
  assert.match(textOfAll(sup.calls[3]), /SOUND_RAW 910 raw/);
  assert.match(textOfAll(sup.calls[3]), /"grounded":true/);
  // Evidence compiled from real tool output, provenance preserved.
  const m = report.evidence.measurements.find((x: any) => x.metric_type === "AMBIENT_TEMPERATURE_C") as any;
  assert.equal(m.source_identifier, "sim-temp-01");
  assert.equal(m.simulated, true);
  assert.equal((report.evidence.configured_thresholds as any).provenance, "FICTIONAL_DEMO_CONFIGURATION");
  assert.equal(report.evidence.history[0].metric_type, "AMBIENT_TEMPERATURE_C");
});

test("normal rack: minimal delegation, no forced verification", async () => {
  const req = fixture("a-normal");
  const { report } = await run(req, [decide("telemetry", "quick check", "Quick check."), decide("finish"), synthesis("NORMAL")], [toolCall("get_current_telemetry", { rack_id: req.rack_id }), findings("24.1 C")]);
  assert.deepEqual(report.agents_invoked.map((a) => a.agent), ["telemetry"]);
  assert.equal(report.verification, null);
  assert.equal(report.severity, "NORMAL");
  assert.equal(report.investigation_status, "COMPLETED");
});

test("agent-specific tool permissions", async () => {
  const sets = createAgentToolsets(createSnapshotDataSource(fixture("a-normal"), { staleAfterMinutes: 15 }));
  const names = (a: keyof typeof sets) => sets[a].map((t) => t.name).sort();
  assert.deepEqual(names("telemetry"), ["analyze_telemetry_trends", "get_current_telemetry", "get_early_warning_indicators", "get_rack_profile", "get_telemetry_history"]);
  assert.deepEqual(names("environment"), ["get_current_telemetry", "get_telemetry_history"]);
  assert.deepEqual(names("documentation"), ["get_rack_profile", "lookup_equipment_documentation"]);
  assert.deepEqual(names("verification"), ["analyze_telemetry_trends", "get_current_telemetry", "get_early_warning_indicators", "get_rack_profile", "get_telemetry_history", "lookup_equipment_documentation"]);

  const req = fixture("a-normal");
  const { report } = await run(
    req,
    [decide("environment", "x", "p"), decide("documentation", "docs"), decide("finish"), synthesis("NORMAL")],
    [toolCall("get_rack_profile", { rack_id: req.rack_id }), findings(), toolCall("lookup_equipment_documentation", { equipment_type: "Network" }), findings("no mfr spec")],
  );
  const [denied, docs] = report.tool_calls;
  assert.equal(denied.status, "ERROR");
  assert.match(denied.result_summary, /not available to the environment agent/);
  assert.equal(docs.status, "SUCCESS");
  assert.ok(report.evidence.documentation.some((d: any) => d.doc_id === "MFR-SPEC-NETWORK" && d.availability === "UNAVAILABLE"));
});

test("guards: cannot finish without evidence; non-normal rack requires verification", async () => {
  const req = fixture("c-critical");
  const { report, events } = await run(req, [decide("finish", "", "Done."), decide("finish"), decide("finish"), synthesis()], [findings(), verdict()]);
  assert.deepEqual(report.agents_invoked.map((a) => a.agent), ["telemetry", "verification"]);
  assert.equal(events.filter((e) => e.type === "GUARD").length, 2);
});

test("maximum delegation limit ends the investigation as INCOMPLETE", async () => {
  const req = fixture("b-elevated");
  const sup = [decide("telemetry", "a", "p"), decide("environment", "b"), decide("telemetry", "c"), synthesis("WARNING")];
  const { report } = await run(req, sup, [findings(), findings(), findings()], { maxDelegations: 2 });
  assert.equal(report.agents_invoked.length, 2);
  assert.deepEqual(report.limits_reached, ["MAX_DELEGATIONS"]);
  assert.equal(report.investigation_status, "INCOMPLETE");
});

test("specialist tool-round limit forces findings and marks the agent INCOMPLETE", async () => {
  const req = fixture("b-elevated");
  const loop = Array.from({ length: 4 }, () => toolCall("get_current_telemetry", { rack_id: req.rack_id }));
  const { report } = await run(req, [decide("telemetry", "x", "p"), decide("finish"), decide("finish"), synthesis("WARNING")], [...loop, findings(), verdict()]);
  const t = report.specialist_findings[0];
  assert.equal(t.tools_executed.length, 3);
  assert.equal(t.status, "INCOMPLETE");
  assert.equal(t.observations.length, 1);
});

test("verification feedback drives a follow-up and the verification retry limit is enforced", async () => {
  const req = fixture("d-stale");
  const { report, sup, events } = await run(
    req,
    [decide("telemetry", "freshness", "p"), decide("verification", "v1"), decide("documentation", "follow-up docs"), decide("verification", "v2"), decide("verification", "v3"), synthesis("UNKNOWN")],
    [findings(), verdict({ grounded: false, request_more_investigation: true, follow_up_agent: "documentation", follow_up_objective: "check specs" }), findings("no mfr spec"), verdict()],
  );
  assert.match(textOfAll(sup.calls[2]), /"follow_up_agent":"documentation"/);
  assert.deepEqual(report.agents_invoked.map((a) => a.agent), ["telemetry", "verification", "documentation", "verification"]);
  assert.ok(report.limits_reached.includes("MAX_VERIFICATION_RETRIES"));
  assert.ok(events.some((e) => e.type === "VERIFY" && /requested follow-up by documentation/.test(e.description)));
});

test("invalid agent outputs: bad supervisor JSON is repaired; bad specialist JSON twice yields INCOMPLETE finding", async () => {
  const req = fixture("a-normal");
  const { report } = await run(
    req,
    [decide("hacker_agent", "x", "p"), decide("telemetry", "x", "p"), decide("finish"), synthesis("NORMAL")],
    [new AIMessage("not json"), new AIMessage("still not json")],
  );
  assert.deepEqual(report.agents_invoked.map((a) => a.agent), ["telemetry"]);
  assert.equal(report.specialist_findings[0].status, "INCOMPLETE");
  // Fixed (issue 3): an INCOMPLETE specialist can no longer produce a COMPLETED report.
  assert.equal(report.investigation_status, "INCOMPLETE");

  const r2 = await run(req, [new AIMessage("??"), new AIMessage("??"), synthesis("NORMAL")], []);
  assert.deepEqual(r2.report.limits_reached, ["SUPERVISOR_OUTPUT_INVALID"]);
  assert.equal(r2.report.investigation_status, "INCOMPLETE");
});

test("API failures: supervisor failure => FAILED; specialist failure is contained", async () => {
  const req = fixture("c-critical");
  const r1 = await run(req, [new Error("503 Service Unavailable nvapi-SECRETKEY")], []);
  assert.equal(r1.report.investigation_status, "FAILED");
  assert.ok(!JSON.stringify(r1).includes("SECRETKEY"));

  const r2 = await run(req, [decide("telemetry", "x", "p"), decide("finish"), decide("finish"), synthesis()], [new Error("500 upstream error"), verdict()]);
  assert.equal(r2.report.specialist_findings[0].status, "FAILED");
  assert.notEqual(r2.report.investigation_status, "FAILED");
});

test("malformed final report twice => INCOMPLETE with UNKNOWN severity, findings preserved", async () => {
  const req = fixture("a-normal");
  const { report } = await run(req, [decide("telemetry", "x", "p"), decide("finish"), new AIMessage("{}"), new AIMessage("nope")], [findings()]);
  MultiAgentReport.parse(report);
  assert.equal(report.investigation_status, "INCOMPLETE");
  assert.equal(report.severity, "UNKNOWN");
  assert.equal(report.specialist_findings.length, 1);
});

test("time limit: investigation finishes INCOMPLETE when the budget is too small", async () => {
  const { report } = await run(fixture("a-normal"), [synthesis("NORMAL")], [], { maxInvestigationSeconds: 5 });
  assert.deepEqual(report.limits_reached, ["MAX_INVESTIGATION_SECONDS"]);
  assert.equal(report.investigation_status, "INCOMPLETE");
});

test("HTTP: /investigate defaults to multi-agent", async () => {
  const app = createApp({
    getModel: () => ({ model: fakeModel([decide("telemetry", "x", "p"), decide("finish"), synthesis("NORMAL")]).model, specialistModel: fakeModel([findings()]).model, config: testConfig }),
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/investigate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(rawFixture("a-normal")) });
    const body = await res.json();
    assert.equal(res.status, 200);
    MultiAgentReport.parse(body.report);
    assert.deepEqual(body.report.agents_invoked.map((a: any) => a.agent), ["telemetry"]);
  } finally {
    server.close();
  }
});

test("regression (live run): an identical repeated task is not re-run; verification still happens", async () => {
  const req = fixture("c-critical");
  const same = "Look up manufacturer documentation for the switches";
  const { report, events } = await run(
    req,
    [decide("telemetry", "t", "p"), decide("documentation", same), decide("documentation", same), decide("finish"), synthesis()],
    [findings(), findings("no mfr spec"), verdict()],
  );
  assert.deepEqual(report.agents_invoked.map((a) => a.agent), ["telemetry", "documentation", "verification"]);
  assert.ok(events.some((e) => e.type === "GUARD" && /identical documentation task/.test(e.description)));
  assert.equal(report.investigation_status, "COMPLETED");
});
