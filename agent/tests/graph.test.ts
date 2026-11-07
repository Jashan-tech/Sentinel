import { test } from "node:test";
import assert from "node:assert/strict";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import type { AddressInfo } from "node:net";
import { runInvestigation } from "../src/graph.js";
import { createSnapshotDataSource, createTools } from "../src/tools.js";
import { createApp } from "../src/app.js";
import { ConfigError } from "../src/model.js";
import { DiagnosticReport, InvestigationEvent, type InvestigationRequest } from "../src/schemas.js";
import { done, fakeModel, fixture, rawFixture, reportJson, testConfig, toolCall, type Step } from "./helpers.js";

const run = (req: InvestigationRequest, steps: Step[], maxRounds = 5) => {
  const fm = fakeModel(steps);
  const tools = createTools(createSnapshotDataSource(req, { staleAfterMinutes: 15 }));
  return runInvestigation(req, { model: fm.model, modelName: "fake", tools, maxRounds }).then((r) => ({ ...r, fm }));
};

test("multi-step investigation: model-selected tools execute and results feed back", async () => {
  const req = fixture("c-critical");
  const { report, events, fm } = await run(req, [
    toolCall("get_rack_profile", { rack_id: "rack-cmp-03" }),
    toolCall("get_telemetry_history", { rack_id: "rack-cmp-03", metric_type: "AMBIENT_TEMPERATURE_C" }),
    done(),
    reportJson(),
  ]);
  assert.equal(report.investigation_status, "COMPLETED");
  assert.deepEqual(report.tool_calls.map((c) => c.tool), ["get_rack_profile", "get_telemetry_history"]);
  assert.ok(report.tool_calls.every((c) => c.status === "SUCCESS"));
  // Second model call must have seen the first tool's real output.
  const toolMsg = fm.calls[1].find((m) => m instanceof ToolMessage) as ToolMessage;
  assert.match(String(toolMsg.content), /High-Density Compute Rack/);
  assert.deepEqual(events.map((e) => e.type), ["START", "MODEL", "TOOL", "MODEL", "TOOL", "MODEL", "REPORT", "END"]);
  for (const e of events) InvestigationEvent.parse(e);
  DiagnosticReport.parse(report);
});

test("max investigation rounds: budget is enforced and report is INCOMPLETE", async () => {
  const req = fixture("b-elevated");
  const forever = Array.from({ length: 3 }, () => toolCall("get_current_telemetry", { rack_id: "rack-cmp-02" }));
  const { report } = await run(req, [...forever, toolCall("get_rack_profile", { rack_id: "rack-cmp-02" }), reportJson("WARNING")], 3);
  assert.equal(report.tool_calls.length, 3);
  assert.equal(report.investigation_status, "INCOMPLETE");
  assert.equal(report.severity, "WARNING");
});

test("tool errors (bad args, unknown tool, wrong rack) are returned to the model, not thrown", async () => {
  const req = fixture("a-normal");
  const { report } = await run(req, [
    toolCall("get_telemetry_history", { rack_id: "rack-net-01", metric_type: "FAN_RPM" }),
    toolCall("reboot_server", { rack_id: "rack-net-01" }),
    toolCall("get_rack_profile", { rack_id: "rack-zzz" }),
    done(),
    reportJson("NORMAL"),
  ]);
  assert.deepEqual(report.tool_calls.map((c) => c.status), ["ERROR", "ERROR", "ERROR"]);
  assert.equal(report.investigation_status, "COMPLETED");
});

test("malformed tool call from model gets one retry", async () => {
  const req = fixture("a-normal");
  const malformed = new AIMessage({ content: "", invalid_tool_calls: [{ name: "get_rack_profile", args: "{bad", id: "x", error: "bad json", type: "invalid_tool_call" }] });
  const { report, events } = await run(req, [malformed, toolCall("get_rack_profile", { rack_id: "rack-net-01" }), done(), reportJson("NORMAL")]);
  assert.ok(events.some((e) => e.status === "ERROR" && /malformed/.test(e.description)));
  assert.equal(report.tool_calls.length, 1);
  assert.equal(report.investigation_status, "COMPLETED");
});

test("malformed report: one repair attempt succeeds", async () => {
  const { report } = await run(fixture("c-critical"), [done(), new AIMessage("Severity is critical!"), reportJson()]);
  assert.equal(report.investigation_status, "COMPLETED");
  assert.equal(report.severity, "CRITICAL");
});

test("malformed report twice: clearly marked INCOMPLETE, no fabricated diagnosis", async () => {
  const bad = new AIMessage(JSON.stringify({ severity: "VERY_BAD", summary: "x" }));
  const { report } = await run(fixture("c-critical"), [done(), bad, bad]);
  assert.equal(report.investigation_status, "INCOMPLETE");
  assert.equal(report.severity, "UNKNOWN");
  assert.deepEqual(report.hypotheses, []);
  DiagnosticReport.parse(report);
});

test("NVIDIA API error: FAILED report, key redacted", async () => {
  const { report, events } = await run(fixture("c-critical"), [new Error("401 Unauthorized for key nvapi-SECRET123")]);
  assert.equal(report.investigation_status, "FAILED");
  assert.equal(report.severity, "UNKNOWN");
  assert.ok(!JSON.stringify({ report, events }).includes("SECRET123"));
});

async function withServer(app: ReturnType<typeof createApp>, fn: (url: string) => Promise<void>) {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}
const post = (url: string, body: unknown) =>
  fetch(`${url}/investigate`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

test("HTTP: validation errors return 400; missing config returns 500 with clear message", async () => {
  await withServer(createApp({ getModel: () => { throw new ConfigError("NVIDIA_API_KEY is not set."); } }), async (url) => {
    assert.equal((await post(url, { rack_id: "x" })).status, 400);
    assert.equal((await post(url, "{not json")).status, 400);
    const res = await post(url, rawFixture("a-normal"));
    assert.equal(res.status, 500);
    assert.match((await res.json()).message, /NVIDIA_API_KEY/);
  });
});

test("HTTP: concurrent investigations stay isolated", async () => {
  const app = createApp({
    getModel: () => {
      // Each request gets its own scripted model; it asks for current telemetry of whatever rack it is given.
      const { model } = fakeModel([
        (msgs) => toolCall("get_current_telemetry", { rack_id: String(msgs[1].content).match(/rack "([^"]+)"/)![1] }),
        done(),
        reportJson(),
      ]);
      return { model, config: testConfig };
    },
  });
  await withServer(app, async (url) => {
    const [a, c] = await Promise.all([post(url, rawFixture("a-normal")), post(url, rawFixture("c-critical"))]);
    const ra = (await a.json()).report;
    const rc = (await c.json()).report;
    assert.equal(ra.rack_id, "rack-net-01");
    assert.equal(rc.rack_id, "rack-cmp-03");
    assert.match(ra.tool_calls[0].result_summary, /4 reading/);
    assert.equal(ra.tool_calls[0].args.rack_id, "rack-net-01");
    assert.equal(rc.tool_calls[0].args.rack_id, "rack-cmp-03");
  });
});
