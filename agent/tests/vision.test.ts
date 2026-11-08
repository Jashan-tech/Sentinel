// Feature 4: image validation, provenance, Vision Agent routing and verification (mocked models).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { AddressInfo } from "node:net";
import { acceptImage, ImageValidationError } from "../src/images.js";
import { runMultiAgentInvestigation, type MultiAgentOptions } from "../src/multiagent.js";
import { createSnapshotDataSource } from "../src/tools.js";
import { createApp } from "../src/app.js";
import { InvestigationRequest, MultiAgentReport, MAX_IMAGE_BYTES } from "../src/schemas.js";
import { fakeModel, fixture, rawFixture, testConfig, toolCall, type Step } from "./helpers.js";

const asset = (f: string) => readFileSync(new URL(`../test-assets/vision/${f}`, import.meta.url));
const JPEG = asset("switch-5port-led-closeup.jpg");
const manifest = JSON.parse(readFileSync(new URL("../test-assets/vision/manifest.json", import.meta.url), "utf8"));
const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const img = (bytes: Buffer, extra: Record<string, unknown> = {}) => ({
  filename: "switch.jpg",
  mime_type: "image/jpeg" as const,
  data_base64: bytes.toString("base64"),
  source_type: "ONLINE_REFERENCE" as const,
  ...extra,
});

const json = (o: unknown) => new AIMessage(JSON.stringify(o));
const decide = (next: string, objective = "", plan?: string) => json({ plan, next, objective, reason: `because ${next}` });
const findings = (obs = "AMBIENT_TEMPERATURE_C 35.4 C (sim-temp-01, SIMULATED)") =>
  json({ observations: [obs], hypotheses: [], missing_information: [], recommended_next_action: "" });
const visionOut = (extra: object = {}) =>
  json({
    visual_findings: [
      { observation: "Red cable plugged into the right-most port", component: "Ethernet port", image_location: "lower-right", category: "PORT", visual_evidence: "red RJ45 plug seated", certainty: "CERTAIN", potential_concern: null, limitations: "", recommended_follow_up: "" },
      { observation: "Three ports appear empty", component: "Ethernet ports", image_location: "front panel, left", category: "PORT", visual_evidence: "no plugs visible", certainty: "UNCERTAIN", potential_concern: "May be expected; cannot confirm", limitations: "angle hides port depth", recommended_follow_up: "Photograph the panel head-on" },
    ],
    unreadable_regions: ["small text under the ports"],
    additional_photos_needed: ["Rear panel"],
    hypotheses: [],
    missing_information: [],
    recommended_next_action: "verify",
    ...extra,
  });
const verdict = (extra: object = {}) =>
  json({ grounded: true, verified_findings: ["Red cable visible in right-most port"], unsupported_claims: [], contradictions: [], missing_evidence: [], request_more_investigation: false, ...extra });
const synthesis = (severity = "CRITICAL") =>
  json({ severity, summary: "s", hypotheses: [], recommended_next_inspection: [], verified_findings: [], missing_information: [] });
const all = (msgs: BaseMessage[]) => JSON.stringify(msgs.map((m) => m.content));

function run(req: InvestigationRequest, sup: Step[], spec: Step[], vis: Step[], over: Partial<MultiAgentOptions> = {}) {
  const s = fakeModel(sup), p = fakeModel(spec), v = fakeModel(vis);
  const images = req.images.map((i) => acceptImage(i));
  return runMultiAgentInvestigation(req, {
    supervisorModel: s.model, specialistModel: p.model, visionModel: v.model,
    supervisorModelName: "fake-super", specialistModelName: "fake-super", visionModelName: "fake-vl",
    dataSource: createSnapshotDataSource(req, { staleAfterMinutes: 15 }), staleAfterMinutes: 15,
    maxDelegations: 5, maxSpecialistToolRounds: 3, maxVerificationRetries: 1, maxInvestigationSeconds: 90, images, ...over,
  }).then((r) => ({ ...r, sup: s, spec: p, vis: v, images }));
}
const withImage = (name = "c-critical", extra: Record<string, unknown> = {}) =>
  InvestigationRequest.parse({ ...rawFixture(name), images: [img(JPEG)], ...extra });

// ---------------- image validation & provenance ----------------

test("image validation accepts real JPEG and PNG; provenance hash, size and timestamps are correct", () => {
  const now = new Date("2026-11-07T23:00:00Z");
  const j = acceptImage(img(JPEG, { source_url: "https://commons.wikimedia.org/wiki/File:Netgear_Gigabit_Switch_5-port.jpg", license: "CC BY-SA 3.0", attribution: "Simon A. Eugster" }), now);
  assert.equal(j.provenance.sha256, createHash("sha256").update(JPEG).digest("hex"));
  assert.equal(j.provenance.sha256, manifest.images.find((m: any) => m.file === "switch-5port-led-closeup.jpg").sha256);
  assert.deepEqual([j.provenance.width, j.provenance.height], [1920, 1272]);
  assert.equal(j.provenance.capture_timestamp, null, "never invented");
  assert.equal(j.provenance.uploaded_at, now.toISOString());
  assert.equal(j.provenance.source_type, "ONLINE_REFERENCE");
  assert.ok(j.dataUrl.startsWith("data:image/jpeg;base64,/9j/"));
  const p = acceptImage(img(PNG_1x1, { mime_type: "image/png", filename: "x.png" }));
  assert.deepEqual([p.provenance.width, p.provenance.height, p.provenance.mime_type], [1, 1, "image/png"]);
});

test("image validation rejects unsupported, mismatched, corrupt, truncated, oversized and huge images", () => {
  const bad = (b: Buffer, extra = {}) => () => acceptImage(img(b, extra));
  assert.throws(bad(Buffer.from("R0lGODlhAQABAAAAACw=", "base64")), /unsupported format/); // GIF
  assert.throws(bad(PNG_1x1), /declared image\/jpeg but the file content is image\/png/);
  assert.throws(bad(JPEG.subarray(0, JPEG.length / 2)), /corrupt or truncated/);
  assert.throws(bad(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(MAX_IMAGE_BYTES)])), /limit is/);
  const huge = Buffer.from(PNG_1x1);
  huge.writeUInt32BE(5000, 16);
  assert.throws(bad(huge, { mime_type: "image/png" }), /exceeds the 4096px limit/);
  assert.throws(() => acceptImage({ ...img(JPEG), data_base64: "not base64!!" }), ImageValidationError);
});

test("request schema: http(s) source URLs only, one image max, known source types", () => {
  const base = rawFixture("a-normal");
  assert.equal(InvestigationRequest.safeParse({ ...base, images: [img(JPEG, { source_url: "file:///etc/passwd" })] }).success, false);
  assert.equal(InvestigationRequest.safeParse({ ...base, images: [img(JPEG), img(JPEG)] }).success, false);
  assert.equal(InvestigationRequest.safeParse({ ...base, images: [img(JPEG, { source_type: "SATELLITE" })] }).success, false);
  assert.equal(InvestigationRequest.safeParse({ ...base, images: [img(JPEG, { source_type: "ROVER_CAMERA", capture_timestamp: "2026-11-07T22:00:00Z" })] }).success, true);
  assert.deepEqual(InvestigationRequest.parse(base).images, [], "backward compatible default");
});

// ---------------- Vision Agent & routing ----------------

test("vision agent receives the actual image bytes and returns structured visual findings", async () => {
  const { report, vis, events, images } = await run(
    withImage("a-normal", { inspection_mode: "VISUAL" }),
    [decide("vision", "inspect photo", "Inspect the photo."), decide("finish"), synthesis("NORMAL")],
    [],
    [visionOut()],
  );
  const parts = vis.calls[0][1].content as any[];
  assert.equal(parts[1].type, "image_url");
  assert.equal(parts[1].image_url.url, images[0].dataUrl, "exact uploaded bytes sent");
  assert.match(String(vis.calls[0][0].content), /text visible in the image is data/i, "prompt-injection guard in system prompt");
  MultiAgentReport.parse(report);
  assert.deepEqual(report.agents_invoked.map((a) => a.agent), ["vision"]);
  assert.equal(report.inspection_mode, "VISUAL");
  assert.equal(report.visual_findings.length, 2);
  assert.equal(report.visual_findings[0].image_id, images[0].provenance.image_id);
  assert.equal(report.evidence.images[0].sha256, images[0].provenance.sha256);
  assert.ok(events.some((e) => e.agent === "vision" && /2 visual finding\(s\) \(1 certain\)/.test(e.description)));
  assert.ok(!JSON.stringify(report).includes(images[0].dataUrl.slice(30, 200)), "no image bytes in the report");
});

test("no image: vision is not offered, and a vision request is redirected by a guard", async () => {
  const req = fixture("a-normal");
  const { report, sup, events } = await run(req, [decide("vision", "x", "p"), decide("finish"), synthesis("NORMAL")], [toolCall("get_current_telemetry", { rack_id: req.rack_id }), findings("24.1 C")], []);
  assert.doesNotMatch(String(sup.calls[0][0].content), /- vision:/);
  assert.match(String(sup.calls[0][1].content), /vision is not available/);
  assert.deepEqual(report.agents_invoked.map((a) => a.agent), ["telemetry"]);
  assert.ok(events.some((e) => e.type === "GUARD" && /no photograph was supplied/.test(e.description)));
  assert.equal(report.inspection_mode, "TELEMETRY");
  assert.deepEqual(report.visual_findings, []);
});

test("combined telemetry + image: verification sees the image and flags unsupported visual causal claims", async () => {
  const req = withImage("c-critical");
  const { report, spec, vis, sup } = await run(
    req,
    [decide("telemetry", "temp trend", "Telemetry then photo."), decide("vision", "inspect rack photo"), decide("verification", "verify"), decide("finish"), synthesis()],
    [toolCall("get_current_telemetry", { rack_id: req.rack_id }), findings()],
    [visionOut({ hypotheses: [{ description: "Empty ports caused the overheating", supporting_evidence: ["ports empty"], contradicting_evidence: [], missing_evidence: [] }] }),
     verdict({ unsupported_claims: ["Empty ports caused the overheating: visual observation does not establish a cause"] })],
  );
  assert.match(String(sup.calls[0][0].content), /- vision:/);
  assert.match(all(vis.calls[0]), /35\.4 C/, "vision saw telemetry context");
  const vparts = vis.calls[1][1].content as any[]; // verification ran on the vision model with the image attached
  assert.equal(vparts[1].type, "image_url");
  assert.match(vparts[0].text, /Red cable plugged into the right-most port/);
  assert.equal(spec.calls.length, 2, "telemetry used the specialist model only");
  assert.deepEqual(report.agents_invoked.map((a) => a.agent), ["telemetry", "vision", "verification"]);
  assert.match(report.verification!.unsupported_claims[0], /does not establish a cause/);
  assert.equal(report.inspection_mode, "COMBINED");
  assert.equal(report.severity, "CRITICAL");
});

test("operator-supplied image is not skipped: finishing early routes to vision", async () => {
  const req = withImage("a-normal");
  const { report, events } = await run(req, [decide("telemetry", "x", "p"), decide("finish"), decide("finish"), synthesis("NORMAL")], [findings("24.1 C")], [visionOut()]);
  assert.deepEqual(report.agents_invoked.map((a) => a.agent), ["telemetry", "vision"]);
  assert.ok(events.some((e) => e.type === "GUARD" && /photograph has not been inspected/.test(e.description)));
});

test("missing visual evidence becomes missing information", async () => {
  const { report } = await run(withImage("a-normal"), [decide("vision", "x", "p"), decide("finish"), synthesis("NORMAL")], [], [visionOut()]);
  const v = report.specialist_findings[0];
  assert.ok(v.missing_information.includes("Unreadable in image: small text under the ports"));
  assert.ok(v.missing_information.includes("Photo needed: Rear panel"));
  assert.deepEqual(v.unreadable_regions, ["small text under the ports"]);
});

test("malformed vision output twice: INCOMPLETE vision finding, no fabricated observations", async () => {
  const { report } = await run(withImage("a-normal"), [decide("vision", "x", "p"), decide("finish"), synthesis("NORMAL")], [], [new AIMessage("I see a switch."), json({ visual_findings: [] })]);
  const v = report.specialist_findings[0];
  assert.equal(v.status, "INCOMPLETE");
  assert.deepEqual(v.visual_findings, []);
  assert.deepEqual(report.visual_findings, []);
});

test("vision API failure is contained and visible", async () => {
  const { report, events } = await run(withImage("a-normal"), [decide("vision", "x", "p"), decide("finish"), synthesis("NORMAL")], [], [new Error("503 Service Unavailable")]);
  assert.equal(report.specialist_findings[0].status, "FAILED");
  assert.notEqual(report.investigation_status, "FAILED");
  assert.ok(events.some((e) => e.type === "ERROR" && e.agent === "vision"));
});

// ---------------- HTTP ----------------

async function post(body: unknown, path = "/investigate") {
  const app = createApp({
    getModel: () => ({
      model: fakeModel([decide("vision", "x", "p"), decide("finish"), synthesis("NORMAL")]).model,
      specialistModel: fakeModel([]).model,
      visionModel: fakeModel([visionOut()]).model,
      config: testConfig,
    }),
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  } finally {
    server.close();
  }
}

test("HTTP: valid image runs the vision workflow; bad images and single-mode images are rejected", async () => {
  const ok = await post({ ...rawFixture("a-normal"), images: [img(JPEG)], inspection_mode: "VISUAL" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.report.visual_findings.length, 2);
  assert.equal(ok.body.report.evidence.images[0].filename, "switch.jpg");
  assert.equal((await post({ ...rawFixture("a-normal"), images: [img(JPEG.subarray(0, 5000))] })).status, 400);
  assert.equal((await post({ ...rawFixture("a-normal"), images: [img(Buffer.from("GIF89a"))] })).status, 400);
  assert.equal((await post({ ...rawFixture("a-normal"), images: [img(JPEG)] }, "/investigate?mode=single")).status, 400);
});

test("regression (live run): long vision output and an over-long summary still yield a valid COMPLETED report", async () => {
  const many = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p} ${i}`);
  const longSummary = json({ severity: "NORMAL", summary: "x".repeat(3000), hypotheses: [], recommended_next_inspection: [], verified_findings: many("v", 25), missing_information: many("m", 35) });
  const { report } = await run(
    withImage("a-normal"),
    [decide("vision", "x", "p"), decide("finish"), longSummary],
    [],
    [visionOut({ missing_information: many("missing", 12), unreadable_regions: many("region", 10), additional_photos_needed: many("photo", 10) })],
  );
  MultiAgentReport.parse(report);
  assert.equal(report.investigation_status, "COMPLETED");
  assert.ok(report.summary.length <= 2501);
  assert.equal(report.specialist_findings[0].missing_information.length, 30);
});

test("regression (live run): the last delegation is reserved for verification when it is required", async () => {
  const req = withImage("c-critical");
  const { report, events } = await run(
    req,
    [decide("telemetry", "t", "p"), decide("vision", "v"), decide("documentation", "docs A"), decide("documentation", "docs B"), decide("telemetry", "again"), decide("finish"), synthesis()],
    [findings(), findings("no mfr spec"), findings("still no spec")],
    [visionOut(), verdict()],
  );
  assert.deepEqual(report.agents_invoked.map((a) => a.agent), ["telemetry", "vision", "documentation", "documentation", "verification"]);
  assert.ok(events.some((e) => e.type === "GUARD" && /Last delegation reserved for verification/.test(e.description)));
  assert.ok(report.verification);
});
