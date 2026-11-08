import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AIMessage } from "@langchain/core/messages";
import { runMultiAgentInvestigation } from "../src/multiagent.js";
import {
  createSnapshotDataSource,
  createDocumentationTool,
} from "../src/tools.js";
import { acceptImage } from "../src/images.js";
import { InvestigationRequest, MultiAgentReport } from "../src/schemas.js";
import { fakeModel, fixture, toolCall } from "./helpers.js";
const json = (o: unknown) => new AIMessage(JSON.stringify(o));
const decide = (next: string) =>
  json({
    next,
    plan: "Check deterministic trends and matched documentation, inspect the reference image, then verify.",
    objective: `${next} evidence`,
    reason: "Inspect available evidence",
  });
const finding = json({
  observations: [
    "Use deterministic evidence; no equipment fault is established.",
  ],
  hypotheses: [],
  missing_information: ["Physical sensor placement"],
  recommended_next_action: "Repeat measurements",
});
export function equipmentFixture() {
  const r = fixture("a-normal");
  r.current_telemetry = [];
  r.recent_telemetry = [];
  const asOf = Date.parse(r.as_of!);
  for (const [seconds, value] of [
    [-120, 25],
    [-60, 26],
    [0, 27],
  ])
    r.recent_telemetry.push({
      metric_type: "AMBIENT_TEMPERATURE_C",
      numeric_value: value,
      unit: "°C",
      observed_at: new Date(asOf + seconds * 1000).toISOString(),
      ingested_at: new Date(asOf + seconds * 1000 + 1).toISOString(),
      source_type: "SIMULATOR",
      source_identifier: "trend-test",
      simulated: true,
      observation_id: String(seconds),
    });
  r.current_telemetry = [r.recent_telemetry.at(-1)!];
  r.equipment_identity = {
    manufacturer: "Cisco",
    model: "C9300-24T",
    provenance: "OPERATOR_PROVIDED",
    assertion:
      "Operator explicitly identifies installed equipment; no image inference",
  };
  return r;
}
test("actual tool loops connect Telemetry, Documentation, real-photo Vision and Verification with source-grounded report evidence", async () => {
  const req = equipmentFixture();
  const photo = JSON.parse(
    readFileSync(
      new URL("../test-assets/vision/manifest.json", import.meta.url),
      "utf8",
    ),
  ).images.find((i: any) => i.file === "switch-5port-led-closeup.jpg");
  const image = acceptImage({
    filename: photo.file,
    mime_type: "image/jpeg",
    data_base64: readFileSync(
      new URL(`../test-assets/vision/${photo.file}`, import.meta.url),
    ).toString("base64"),
    source_type: "ONLINE_REFERENCE",
    source_url: photo.source_page,
    attribution: photo.creator,
    license: photo.license,
  });
  const sup = fakeModel([
    decide("telemetry"),
    decide("documentation"),
    decide("vision"),
    decide("verification"),
    decide("finish"),
    json({
      severity: "NORMAL",
      summary:
        "Simulated temperature increased over the observed window. No fault is established; the reference photograph does not identify this rack.",
      hypotheses: [],
      recommended_next_inspection: ["Confirm sensor position"],
      verified_findings: ["Deterministic tool evidence agrees"],
      missing_information: ["Verified physical context"],
    }),
  ]);
  const multi = new AIMessage({
    content: "",
    tool_calls: [
      {
        name: "analyze_telemetry_trends",
        args: { rack_id: req.rack_id, metric_type: "AMBIENT_TEMPERATURE_C" },
        id: "trend-verify",
        type: "tool_call",
      },
      {
        name: "lookup_equipment_documentation",
        args: { equipment_type: req.equipment_type },
        id: "doc-verify",
        type: "tool_call",
      },
    ],
  });
  const spec = fakeModel([
    toolCall("analyze_telemetry_trends", {
      rack_id: req.rack_id,
      metric_type: "AMBIENT_TEMPERATURE_C",
    }),
    toolCall("get_early_warning_indicators", {
      rack_id: req.rack_id,
      metric_type: "AMBIENT_TEMPERATURE_C",
    }),
    finding,
    toolCall("lookup_equipment_documentation", {
      equipment_type: req.equipment_type,
    }),
    finding,
  ]);
  const vision = fakeModel([
    json({
      visual_findings: [
        {
          observation:
            "A reference switch is shown; installed rack model cannot be established.",
          component: "switch",
          image_location: "center",
          category: "EQUIPMENT",
          visual_evidence: "Reference photograph",
          certainty: "UNCERTAIN",
          limitations: "Online reference, not selected rack",
          potential_concern: null,
          recommended_follow_up: "Obtain an actual rack image",
        },
      ],
      unreadable_regions: [],
      additional_photos_needed: ["Actual rack"],
      hypotheses: [],
      missing_information: ["Actual rack appearance"],
      recommended_next_action: "Verify against rack metadata",
    }),
    multi,
    json({
      grounded: true,
      verified_findings: [
        "Observed tool-computed increase, not a confirmed fault",
      ],
      unsupported_claims: ["Reference image identifies installed equipment"],
      contradictions: [],
      missing_evidence: ["Actual rack photograph"],
      request_more_investigation: false,
    }),
  ]);
  const { report } = await runMultiAgentInvestigation(req, {
    supervisorModel: sup.model,
    specialistModel: spec.model,
    visionModel: vision.model,
    supervisorModelName: "scripted-test",
    specialistModelName: "scripted-test",
    dataSource: createSnapshotDataSource(req, { staleAfterMinutes: 5 }),
    staleAfterMinutes: 5,
    maxDelegations: 5,
    maxSpecialistToolRounds: 3,
    maxVerificationRetries: 1,
    maxInvestigationSeconds: 90,
    images: [image],
  });
  MultiAgentReport.parse(report);
  assert.equal(report.investigation_status, "COMPLETED");
  assert.deepEqual(
    report.agents_invoked.map((a) => a.agent),
    ["telemetry", "documentation", "vision", "verification"],
  );
  assert.equal(report.evidence.trends[0].metric_type, "AMBIENT_TEMPERATURE_C");
  assert.equal(
    (report.evidence.trends[0].series as any[])[0].change_per_minute,
    1,
  );
  assert(
    report.evidence.early_warning_indicators.some(
      (i) => i.classification === "EARLY_WARNING_TREND",
    ),
  );
  assert.equal(report.evidence.documentation_match?.match_status, "MATCH");
  assert(
    report.evidence.documentation.some(
      (d) =>
        d.doc_id === "CISCO-C9300-LED" &&
        String(d.source_url).startsWith("https://www.cisco.com/") &&
        d.section &&
        d.technical_facts,
    ),
  );
  assert(
    report.tool_calls
      .filter((t) => t.tool === "analyze_telemetry_trends")
      .every((t) => t.status === "SUCCESS"),
  );
  assert(
    report.tool_calls
      .filter((t) => t.tool === "lookup_equipment_documentation")
      .every(
        (t) =>
          t.status === "SUCCESS" && !t.result_summary.includes("too large"),
      ),
  );
  assert.equal(report.evidence.images[0].sha256, photo.sha256);
  assert(JSON.stringify(vision.calls).includes("data:image/jpeg;base64,"));
  assert(vision.calls.length >= 3);
  assert.equal(report.verification?.status, "COMPLETED");
  assert.equal(report.verification?.grounded, true);
  assert(!JSON.stringify(report).includes("data:image/jpeg;base64,"));
});
test("early warning below profile thresholds requires verification without changing threshold severity", async () => {
  const req = equipmentFixture();
  const sup = fakeModel([
    decide("telemetry"),
    decide("finish"),
    decide("finish"),
    json({
      severity: "NORMAL",
      summary: "Observed early warning only",
      hypotheses: [],
      recommended_next_inspection: [],
      verified_findings: [],
      missing_information: [],
    }),
  ]);
  const spec = fakeModel([
    finding,
    json({
      grounded: true,
      verified_findings: [],
      unsupported_claims: [],
      contradictions: [],
      missing_evidence: [],
      request_more_investigation: false,
    }),
  ]);
  const out = await runMultiAgentInvestigation(req, {
    supervisorModel: sup.model,
    specialistModel: spec.model,
    supervisorModelName: "scripted-test",
    specialistModelName: "scripted-test",
    dataSource: createSnapshotDataSource(req, { staleAfterMinutes: 5 }),
    staleAfterMinutes: 5,
    maxDelegations: 5,
    maxSpecialistToolRounds: 3,
    maxVerificationRetries: 1,
    maxInvestigationSeconds: 90,
  });
  assert.deepEqual(
    out.report.agents_invoked.map((a) => a.agent),
    ["telemetry", "verification"],
  );
  assert.equal(out.report.severity, "NORMAL");
  assert.equal(out.report.investigation_status, "COMPLETED");
});
test("all exact documentation matches fit bounded tool responses and preserve access dates", async () => {
  for (const [manufacturer, model] of [
    ["Cisco", "C9300-24T"],
    ["Dell", "PowerEdge R7425"],
    ["HPE", "ProLiant DL380 Gen11"],
  ]) {
    const req = equipmentFixture();
    req.equipment_identity = {
      ...req.equipment_identity!,
      manufacturer,
      model,
    };
    const result = JSON.parse(
      String(
        await createDocumentationTool(
          createSnapshotDataSource(req, { staleAfterMinutes: 5 }),
        ).invoke({ equipment_type: req.equipment_type }),
      ),
    );
    assert.equal(result.match_status, "MATCH");
    assert(!result.error);
    assert(result.documents.some((d: any) => d.access_date === "2026-11-07"));
  }
});
