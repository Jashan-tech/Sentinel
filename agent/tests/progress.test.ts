// Live progress + headline (SCRIPTED models; no NVIDIA calls).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { AIMessage } from "@langchain/core/messages";
import { ProgressTracker, createProgressPublisher, type ProgressSnapshot } from "../src/progress.js";
import { runMultiAgentInvestigation } from "../src/multiagent.js";
import { createSnapshotDataSource } from "../src/tools.js";
import { InvestigationRequest, MultiAgentReport, type InvestigationEvent } from "../src/schemas.js";
import { createApp } from "../src/app.js";
import type { InvestigationStore } from "../src/persistence.js";
import { fakeModel, rawFixture, testConfig, type Step } from "./helpers.js";

const json = (o: unknown) => new AIMessage(JSON.stringify(o));
const decide = (next: string, objective = "", plan?: string) => json({ plan, next, objective, reason: "r" });
const finding = json({ observations: ["x"], hypotheses: [], missing_information: [], recommended_next_action: "" });
const synthesis = (extra: object = {}) =>
  json({ severity: "NORMAL", summary: "s", hypotheses: [], recommended_next_inspection: [], verified_findings: [], missing_information: [], ...extra });
const ev = (type: InvestigationEvent["type"], description: string, agent?: string, status: InvestigationEvent["status"] = "INFO"): InvestigationEvent => ({
  type, description, status, agent, timestamp: new Date().toISOString(),
});

test("progress: agent start/complete, tool counts and phases come from engine events", () => {
  const t = new ProgressTracker();
  assert.match(t.snapshot().phase, /planning/);
  assert.equal(t.update(ev("SUPERVISOR", "Delegated to telemetry: check")), true);
  assert.match(t.snapshot().phase, /assigned the telemetry agent/);
  t.update(ev("AGENT", "telemetry agent started: check", "telemetry"));
  assert.equal(t.update(ev("TOOL", "[telemetry] get_current_telemetry returned", "telemetry")), false);
  t.update(ev("TOOL", "[telemetry] get_rack_profile returned", "telemetry"));
  let s = t.snapshot();
  assert.deepEqual(s.steps.map((x) => [x.agent, x.state, x.tool_calls]), [["telemetry", "running", 2]]);
  assert.match(s.phase, /Telemetry agent is checking/);
  t.update(ev("AGENT", "telemetry agent completed: 3 observation(s)", "telemetry", "SUCCESS"));
  t.update(ev("AGENT", "verification agent started: verify", "verification"));
  t.update(ev("ERROR", "verification agent model call failed: timeout", "verification", "ERROR"));
  t.update(ev("SUPERVISOR", "Decided to finish: done"));
  s = t.snapshot();
  assert.deepEqual(s.steps.map((x) => [x.agent, x.state]), [["telemetry", "done"], ["verification", "failed"]]);
  assert.ok(s.steps[0].ended_at);
  assert.match(s.phase, /writing the final report/);
});

test("progress: VERIFY event closes the verification step", () => {
  const t = new ProgressTracker();
  t.update(ev("AGENT", "verification agent started: v", "verification"));
  t.update(ev("VERIFY", "Verification found the findings grounded: 3 verified"));
  assert.equal(t.snapshot().steps[0].state, "done");
});

test("progress publisher: never blocks, keeps only the latest snapshot, swallows failures", async () => {
  const sent: ProgressSnapshot[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let first = true;
  const logs: string[] = [];
  const pub = createProgressPublisher(async (s) => {
    if (first) {
      first = false;
      await gate;
      throw new Error("db down");
    }
    sent.push(s);
  }, (m) => logs.push(m));
  pub.onEvent(ev("AGENT", "telemetry agent started: a", "telemetry")); // in flight (blocked)
  pub.onEvent(ev("AGENT", "telemetry agent completed: a", "telemetry"));
  pub.onEvent(ev("AGENT", "environment agent started: b", "environment")); // supersedes the previous pending one
  release();
  await pub.idle();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].steps.map((s) => [s.agent, s.state]), [["telemetry", "done"], ["environment", "running"]]);
  assert.equal(logs.length, 1);
});

test("engine: onEvent sees every timeline event live; a throwing listener cannot break the run", async () => {
  const req = InvestigationRequest.parse(rawFixture("a-normal"));
  const seen: string[] = [];
  const result = await runMultiAgentInvestigation(req, {
    supervisorModel: fakeModel([decide("telemetry", "t", "p"), decide("finish"), synthesis({ headline: "Rack 01 looks normal on simulated data." })]).model,
    specialistModel: fakeModel([finding]).model,
    supervisorModelName: "s", specialistModelName: "s",
    dataSource: createSnapshotDataSource(req, { staleAfterMinutes: 15 }),
    staleAfterMinutes: 15, maxDelegations: 4, maxSpecialistToolRounds: 2, maxVerificationRetries: 1, maxInvestigationSeconds: 60,
    onEvent: (e) => {
      seen.push(e.type);
      throw new Error("listener bug");
    },
  });
  assert.deepEqual(seen, result.events.map((e) => e.type));
  assert.equal(result.report.headline, "Rack 01 looks normal on simulated data.");
});

test("headline: optional for the model; failed runs get a plain fallback; long ones are capped", async () => {
  const req = InvestigationRequest.parse(rawFixture("a-normal"));
  const run = (sup: Step[]) =>
    runMultiAgentInvestigation(req, {
      supervisorModel: fakeModel(sup).model, specialistModel: fakeModel([finding]).model,
      supervisorModelName: "s", specialistModelName: "s", dataSource: createSnapshotDataSource(req, { staleAfterMinutes: 15 }),
      staleAfterMinutes: 15, maxDelegations: 4, maxSpecialistToolRounds: 2, maxVerificationRetries: 1, maxInvestigationSeconds: 60,
    });
  const noHeadline = await run([decide("telemetry", "t", "p"), decide("finish"), synthesis()]);
  assert.equal(noHeadline.report.headline, "");
  const long = await run([decide("telemetry", "t", "p"), decide("finish"), synthesis({ headline: "x".repeat(400) })]);
  assert.ok(long.report.headline.length <= 241);
  const failed = await run([() => { throw new Error("NVIDIA 503"); }]);
  assert.equal(failed.report.investigation_status, "FAILED");
  assert.match(failed.report.headline, /failed before a diagnosis/);
  MultiAgentReport.parse(failed.report);
});

test("persisted mode: progress is written to the store while running, and stays best-effort", async () => {
  const snapshot = rawFixture("a-normal");
  const ID = "0b9f4c2e-1111-2222-3333-444455556666";
  const progress: { phase: string; steps: any[] }[] = [];
  let completed = 0;
  const store: InvestigationStore = {
    async load(id) {
      return { row: { investigation_id: id, rack_id: snapshot.rack_id, status: "RUNNING", snapshot_json: JSON.stringify(snapshot) }, image: null };
    },
    async complete() {
      completed++;
    },
    async progress(_id, phase, stepsJson) {
      progress.push({ phase, steps: JSON.parse(stepsJson) });
      if (progress.length === 2) throw new Error("transient"); // must not affect the run
    },
  };
  const app = createApp({
    store,
    getModel: () => ({
      model: fakeModel([decide("telemetry", "t", "p"), decide("finish"), synthesis()]).model,
      specialistModel: fakeModel([finding]).model, visionModel: fakeModel([]).model, config: testConfig,
    }),
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/investigate`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ investigation_id: ID }),
    });
    assert.equal(res.status, 200);
  } finally {
    server.close();
  }
  assert.equal(completed, 1);
  assert.ok(progress.length >= 2, `progress updates: ${progress.length}`);
  assert.ok(progress.some((p) => p.steps.some((s) => s.agent === "telemetry")));
  assert.ok(progress.every((p) => JSON.stringify(p).length < 4000));
});
