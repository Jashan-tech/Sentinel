// Speed changes: parallel independent specialists, short outputs, local JSON repair (SCRIPTED models).
import { test } from "node:test";
import assert from "node:assert/strict";
import { AIMessage } from "@langchain/core/messages";
import { runMultiAgentInvestigation } from "../src/multiagent.js";
import { extractJson } from "../src/graph.js";
import { createSnapshotDataSource } from "../src/tools.js";
import { InvestigationRequest, SpecialistOutput } from "../src/schemas.js";
import { fakeModel, rawFixture, type Step } from "./helpers.js";

const json = (o: unknown) => new AIMessage(JSON.stringify(o));
const finding = json({ observations: ["x"], hypotheses: [], missing_information: [], recommended_next_action: "" });
const synthesis = json({ severity: "NORMAL", headline: "h", summary: "s", hypotheses: [], recommended_next_inspection: [], verified_findings: [], missing_information: [] });
const slow = (ms: number): Step => async () => {
  await new Promise((r) => setTimeout(r, ms));
  return finding;
};
const run = (sup: Step[], spec: Step[], maxDelegations = 4) => {
  const req = InvestigationRequest.parse(rawFixture("a-normal"));
  return runMultiAgentInvestigation(req, {
    supervisorModel: fakeModel(sup).model, specialistModel: fakeModel(spec).model,
    supervisorModelName: "s", specialistModelName: "s", dataSource: createSnapshotDataSource(req, { staleAfterMinutes: 15 }),
    staleAfterMinutes: 15, maxDelegations, maxSpecialistToolRounds: 2, maxVerificationRetries: 1, maxInvestigationSeconds: 60,
  });
};

test("parallel: specialists listed in 'also' run concurrently and all findings are kept", async () => {
  const t0 = Date.now();
  const r = await run(
    [json({ plan: "p", next: "telemetry", objective: "readings", reason: "r", also: [{ agent: "documentation", objective: "docs" }, { agent: "environment", objective: "env" }] }), json({ next: "finish", reason: "done" }), synthesis],
    [slow(300), slow(300), slow(300)],
  );
  const ms = Date.now() - t0;
  assert.deepEqual(r.report.agents_invoked.map((a) => a.agent).sort(), ["documentation", "environment", "telemetry"]);
  assert.ok(ms < 800, `three 300 ms specialists took ${ms} ms; they did not overlap`);
  assert.equal(r.events.filter((e) => /\(in parallel\)/.test(e.description)).length, 2);
});
test("parallel: companions respect the delegation budget, duplicates and repeats", async () => {
  const r = await run(
    [json({ plan: "p", next: "telemetry", objective: "a", reason: "r", also: [{ agent: "telemetry", objective: "dup" }, { agent: "documentation", objective: "d" }, { agent: "environment", objective: "e" }] }), json({ next: "finish", reason: "done" }), synthesis],
    [finding, finding],
    2,
  );
  assert.equal(r.report.agents_invoked.length, 2);
  assert.ok(r.events.some((e) => e.type === "GUARD" && /Ran 1 of 2 requested parallel/.test(e.description)));
});
test("parallel: 'also' is ignored for verification", async () => {
  const r = await run(
    [json({ plan: "p", next: "telemetry", objective: "a", reason: "r" }), json({ next: "verification", objective: "v", reason: "r", also: [{ agent: "documentation", objective: "d" }] }), json({ next: "finish", reason: "done" }), synthesis],
    [finding, json({ grounded: true, verified_findings: [], unsupported_claims: [], contradictions: [], requested_follow_up: null })],
  );
  assert.ok(!r.report.agents_invoked.some((a) => a.agent === "documentation"));
});
test("json: common model slips are repaired locally, then still validated strictly", () => {
  const broken = '{"observations": ["a" "b"], "hypotheses": [], "missing_information": [],}';
  assert.deepEqual((extractJson(broken) as any).observations, ["a", "b"]);
  assert.deepEqual((extractJson('```json\n{"x": 1,}\n```') as any).x, 1);
  assert.deepEqual(extractJson('{"next": "finish", "reason": "a"}\n{"next": "telemetry"}'), { next: "finish", reason: "a" });
  assert.deepEqual(extractJson('{"s": "a } b"}{"x": 2}'), { s: "a } b" });
  // Seen live: a slip plus prose after the JSON. Repair the first complete object, never return an array.
  assert.deepEqual(extractJson('{"observations": ["a"], hypotheses: []}\nThese findings show the rack is warm. {see above}'), { observations: ["a"], hypotheses: [] });
  assert.deepEqual(extractJson('Here:\n{"observations": ["a"], \'hypotheses\': [],}\n\nLet me know.'), { observations: ["a"], hypotheses: [] });
  assert.throws(() => extractJson("no json here"));
  assert.throws(() => SpecialistOutput.parse(extractJson('{"observations": "not an array"}')));
});
test("output caps: specialist observations are capped at 8", () => {
  const o = SpecialistOutput.parse({ observations: Array.from({ length: 15 }, (_, i) => `o${i}`) });
  assert.equal(o.observations.length, 8);
});

// ---- verification completeness ----
import { toolCall } from "./helpers.js";
const verdict = json({ grounded: true, verified_findings: ["x"], unsupported_claims: [], contradictions: [], missing_evidence: [], request_more_investigation: false, follow_up_agent: null, follow_up_objective: null });
const telemetryCall = () => toolCall("get_current_telemetry", { rack_id: "rack-a" });
test("verification has its own larger tool budget (5 rounds), so checking several agents can finish", async () => {
  const req = InvestigationRequest.parse(rawFixture("c-critical"));
  const r = await runMultiAgentInvestigation(req, {
    supervisorModel: fakeModel([json({ plan: "p", next: "telemetry", objective: "a", reason: "r" }), json({ next: "verification", objective: "v", reason: "r" }), json({ next: "finish", reason: "done" }), synthesis]).model,
    // telemetry: answers immediately; verification: 4 tool rounds then its verdict (over the 3-round specialist limit)
    specialistModel: fakeModel([finding, telemetryCall(), telemetryCall(), telemetryCall(), telemetryCall(), verdict]).model,
    supervisorModelName: "s", specialistModelName: "s", dataSource: createSnapshotDataSource(req, { staleAfterMinutes: 15 }),
    staleAfterMinutes: 15, maxDelegations: 4, maxSpecialistToolRounds: 3, maxVerificationToolRounds: 5, maxVerificationRetries: 1, maxInvestigationSeconds: 60,
  });
  assert.equal(r.report.verification?.status, "COMPLETED");
  assert.ok(!r.events.some((e) => /verification reached its tool-round/.test(e.description)));
});
test("an INCOMPLETE verification is not repeated over the same findings", async () => {
  const req = InvestigationRequest.parse(rawFixture("c-critical"));
  const r = await runMultiAgentInvestigation(req, {
    supervisorModel: fakeModel([json({ plan: "p", next: "telemetry", objective: "a", reason: "r" }), json({ next: "verification", objective: "v", reason: "r" }), json({ next: "verification", objective: "again", reason: "r" }), synthesis]).model,
    specialistModel: fakeModel([finding, telemetryCall(), telemetryCall(), verdict]).model,
    supervisorModelName: "s", specialistModelName: "s", dataSource: createSnapshotDataSource(req, { staleAfterMinutes: 15 }),
    staleAfterMinutes: 15, maxDelegations: 5, maxSpecialistToolRounds: 3, maxVerificationToolRounds: 1, maxVerificationRetries: 1, maxInvestigationSeconds: 60,
  });
  assert.equal(r.report.agents_invoked.filter((a) => a.agent === "verification").length, 1);
  assert.ok(r.events.some((e) => /could not finish; not repeating it/.test(e.description)));
  assert.equal(r.report.verification_outcome, "INCOMPLETE"); // still honest: it did not finish
});
test("the verifier receives current readings and matched manufacturer facts as code-computed evidence", async () => {
  const raw = rawFixture("c-critical");
  const req = InvestigationRequest.parse({ ...raw, equipment_type: "Compute",
    equipment_identity: { manufacturer: "Dell", model: "PowerEdge R760", provenance: "OPERATOR_PROVIDED", assertion: "assigned" } });
  let seen = "";
  const capture: Step = (msgs: any) => {
    seen = msgs.map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
    return verdict;
  };
  await runMultiAgentInvestigation(req, {
    supervisorModel: fakeModel([json({ plan: "p", next: "telemetry", objective: "a", reason: "r" }), json({ next: "finish", reason: "done" }), synthesis]).model,
    specialistModel: fakeModel([finding, capture]).model,
    supervisorModelName: "s", specialistModelName: "s", dataSource: createSnapshotDataSource(req, { staleAfterMinutes: 15 }),
    staleAfterMinutes: 15, maxDelegations: 4, maxSpecialistToolRounds: 3, maxVerificationToolRounds: 5, maxVerificationRetries: 1, maxInvestigationSeconds: 60,
  });
  assert.match(seen, /current readings: \{"readings":\[\{"metric":"AMBIENT_TEMPERATURE_C"/);
  assert.match(seen, /DELL-R760-ENV/);
  assert.match(seen, /documentation lookup \(match MATCH\)/);
  assert.match(seen, /contradictions: ONLY pairs of statements that cannot both be true/);
});

import { SupervisorDecision } from "../src/schemas.js";
test("an invalid 'also' entry is dropped; it never invalidates the routing decision", () => {
  const d = SupervisorDecision.parse({ next: "telemetry", objective: "a", reason: "r", also: [{ agent: "verification", objective: "v" }, { agent: "documentation", objective: "d" }, "junk"] });
  assert.equal(d.next, "telemetry");
  assert.deepEqual(d.also, [{ agent: "documentation", objective: "d" }]);
});

test("routing slips are normalised: several agents in next become next + also; synonyms map to routes", () => {
  const a = SupervisorDecision.parse({ next: "telemetry, documentation", objective: "check", reason: "r" });
  assert.equal(a.next, "telemetry");
  assert.deepEqual(a.also.map((x) => x.agent), ["documentation"]);
  const b = SupervisorDecision.parse({ next: ["documentation", "environment"], objective: "o", reason: "r" });
  assert.equal(b.next, "documentation");
  assert.deepEqual(b.also.map((x) => x.agent), ["environment"]);
  assert.equal(SupervisorDecision.parse({ next: "Verify", objective: "v", reason: "r" }).next, "verification");
  assert.equal(SupervisorDecision.parse({ next: "done", reason: "r" }).next, "finish");
  assert.throws(() => SupervisorDecision.parse({ next: "reboot the rack", reason: "r" }));
});

test("routing key variants are accepted (wrapped decision, next_agent, action)", () => {
  assert.equal(SupervisorDecision.parse({ decision: { next: "telemetry", objective: "a" }, reason: "r" }).next, "telemetry");
  assert.equal(SupervisorDecision.parse({ next_agent: "documentation", objective: "d", reason: "r" }).next, "documentation");
  assert.equal(SupervisorDecision.parse({ action: "finish", reason: "r" }).next, "finish");
  assert.throws(() => SupervisorDecision.parse({ plan: "p", reason: "r" })); // still nothing to route on
});
