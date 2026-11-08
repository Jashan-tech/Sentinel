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
  assert.throws(() => extractJson("no json here"));
  assert.throws(() => SpecialistOutput.parse(extractJson('{"observations": "not an array"}')));
});
test("output caps: specialist observations are capped at 8", () => {
  const o = SpecialistOutput.parse({ observations: Array.from({ length: 15 }, (_, i) => `o${i}`) });
  assert.equal(o.observations.length, 8);
});
