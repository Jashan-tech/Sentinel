// Phase 2/3 regression tests (fix/investigation-integrity). Scripted models only; no NVIDIA inference.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { acceptImage, ImageValidationError } from "../src/images.js";

const JPEG = readFileSync(new URL("../test-assets/vision/switch-5port-led-closeup.jpg", import.meta.url));
const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const asInput = (bytes: Buffer, mime: "image/jpeg" | "image/png") => ({
  filename: mime === "image/png" ? "x.png" : "x.jpg", mime_type: mime, data_base64: bytes.toString("base64"), source_type: "MANUAL_UPLOAD" as const,
});
const rejects = (bytes: Buffer, mime: "image/jpeg" | "image/png") =>
  assert.throws(() => acceptImage(asInput(bytes, mime)), ImageValidationError);

// ---- PNG chunk helpers (real CRCs, so only the property under test is broken) ----
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const SIG = PNG_1x1.subarray(0, 8);
const ihdr = (w: number, h: number) => { const d = Buffer.alloc(13); d.writeUInt32BE(w, 0); d.writeUInt32BE(h, 4); d[8] = 8; d[9] = 6; return chunk("IHDR", d); };
const png = (...chunks: Buffer[]) => Buffer.concat([SIG, ...chunks, chunk("IEND", Buffer.alloc(0))]);

test("6: valid JPEG and PNG still decode, with SHA-256 and dimensions preserved", () => {
  const j = acceptImage(asInput(JPEG, "image/jpeg"));
  assert.deepEqual([j.provenance.width, j.provenance.height], [1920, 1272]);
  assert.match(j.provenance.sha256, /^[0-9a-f]{64}$/);
  const p = acceptImage(asInput(PNG_1x1, "image/png"));
  assert.deepEqual([p.provenance.width, p.provenance.height], [1, 1]);
  // A correctly encoded synthetic PNG (2x2 RGBA) is accepted.
  const raw = Buffer.concat([0, 0].map(() => Buffer.from([0, 255, 0, 0, 255, 0, 255, 0, 255]))); // filter byte + 2 px per row
  assert.equal(acceptImage(asInput(png(ihdr(2, 2), chunk("IDAT", deflateSync(raw))), "image/png")).provenance.width, 2);
});

test("6: audit repro: PNG with signature, IHDR and IEND but no image data is rejected", () => {
  rejects(png(ihdr(64, 64)), "image/png");
});

test("6: PNG whose IDAT is not valid zlib data is rejected", () => {
  rejects(png(ihdr(2, 2), chunk("IDAT", Buffer.from("definitely not deflate"))), "image/png");
});

test("6: PNG whose decompressed data is too short for its dimensions is rejected", () => {
  rejects(png(ihdr(64, 64), chunk("IDAT", deflateSync(Buffer.alloc(10)))), "image/png");
});

test("6: PNG with a corrupted chunk CRC is rejected", () => {
  const bad = Buffer.from(PNG_1x1);
  bad[bad.length - 20] ^= 0xff; // flip a byte inside IDAT; CRC no longer matches
  rejects(bad, "image/png");
});

test("6: JPEG with valid headers and EOI marker but garbage entropy data is rejected", () => {
  const sos = JPEG.indexOf(Buffer.from([0xff, 0xda]));
  const garbage = Buffer.alloc(5000, 0xff); // 0xFF runs are not valid scan data
  rejects(Buffer.concat([JPEG.subarray(0, sos + 14), garbage, Buffer.from([0xff, 0xd9])]), "image/jpeg");
});

test("6: JPEG with headers only (no scan) plus an EOI marker is rejected", () => {
  const sos = JPEG.indexOf(Buffer.from([0xff, 0xda]));
  rejects(Buffer.concat([JPEG.subarray(0, sos), Buffer.from([0xff, 0xd9])]), "image/jpeg");
});

test("6: JPEG truncated mid-scan with an EOI appended is rejected", () => {
  rejects(Buffer.concat([JPEG.subarray(0, Math.floor(JPEG.length / 3)), Buffer.from([0xff, 0xd9])]), "image/jpeg");
});

// ============ 8. Evidence deduplication ============
import { AIMessage } from "@langchain/core/messages";
import { runMultiAgentInvestigation } from "../src/multiagent.js";
import { createSnapshotDataSource } from "../src/tools.js";
import { InvestigationRequest } from "../src/schemas.js";
import { fakeModel, rawFixture, toolCall, type Step } from "./helpers.js";

const json = (o: unknown) => new AIMessage(JSON.stringify(o));
const decide = (next: string, objective = "", plan?: string) => json({ plan, next, objective, reason: "r" });
const finding = json({ observations: ["x"], hypotheses: [], missing_information: [], recommended_next_action: "" });
const synthesis = json({ severity: "NORMAL", summary: "s", hypotheses: [], recommended_next_inspection: [], verified_findings: [], missing_information: [] });
const reading = (over: Record<string, unknown>) => ({
  metric_type: "AMBIENT_TEMPERATURE_C", numeric_value: 24, unit: "°C", source_type: "SIMULATOR", source_identifier: "sim-temp-01",
  observed_at: "2026-11-07T13:59:00.000Z", ingested_at: "2026-11-07T13:59:01.000Z", simulated: true, ...over,
});
function runWith(req: InvestigationRequest, spec: Step[], sup: Step[] = [decide("telemetry", "t", "p"), decide("finish"), synthesis]) {
  return runMultiAgentInvestigation(req, {
    supervisorModel: fakeModel(sup).model, specialistModel: fakeModel(spec).model, supervisorModelName: "s", specialistModelName: "s",
    dataSource: createSnapshotDataSource(req, { staleAfterMinutes: 15 }), staleAfterMinutes: 15,
    maxDelegations: 5, maxSpecialistToolRounds: 3, maxVerificationRetries: 1, maxInvestigationSeconds: 90,
  });
}

test("8: two distinct readings from one source at the same timestamp are both kept as evidence", async () => {
  const req = InvestigationRequest.parse({
    ...rawFixture("a-normal"),
    current_telemetry: [reading({ observation_id: "1", numeric_value: 24 }), reading({ observation_id: "2", numeric_value: 31 })],
  });
  const { report } = await runWith(req, [toolCall("get_current_telemetry", { rack_id: req.rack_id }), toolCall("get_current_telemetry", { rack_id: req.rack_id }), finding]);
  const temps = report.evidence.measurements.filter((m: any) => m.metric_type === "AMBIENT_TEMPERATURE_C").map((m: any) => m.numeric_value).sort();
  assert.deepEqual(temps, [24, 31], "distinct readings preserved, the repeated tool call does not duplicate them");
});

test("8: readings without ids are distinguished by value, ingestion and provenance", async () => {
  const req = InvestigationRequest.parse({
    ...rawFixture("a-normal"),
    current_telemetry: [reading({ numeric_value: 24 }), reading({ numeric_value: 24, ingested_at: "2026-11-07T13:59:05.000Z" }), reading({ numeric_value: 25 })],
  });
  const { report } = await runWith(req, [toolCall("get_current_telemetry", { rack_id: req.rack_id }), finding]);
  assert.equal(report.evidence.measurements.filter((m: any) => m.metric_type === "AMBIENT_TEMPERATURE_C").length, 3);
  for (const m of report.evidence.measurements as any[]) {
    assert.equal(m.source_type, "SIMULATOR");
    assert.equal(m.simulated, true);
  }
});

test("8: distinct history windows with the same observation count are separate evidence entries", async () => {
  const rows = (metric: string, unit: string, start: number) =>
    Array.from({ length: 5 }, (_, i) => reading({ metric_type: metric, unit, numeric_value: 40 + i, observation_id: `${metric}-${start + i}`,
      observed_at: new Date(Date.parse("2026-11-07T13:00:00Z") + (start + i) * 60_000).toISOString(),
      ingested_at: new Date(Date.parse("2026-11-07T13:00:00Z") + (start + i) * 60_000 + 1000).toISOString() }));
  const req = InvestigationRequest.parse({ ...rawFixture("a-normal"), recent_telemetry: [...rows("AMBIENT_TEMPERATURE_C", "°C", 0), ...rows("AMBIENT_TEMPERATURE_C", "°C", 10)] });
  const h = (limit: number) => toolCall("get_telemetry_history", { rack_id: req.rack_id, metric_type: "AMBIENT_TEMPERATURE_C", limit });
  // limit 3 twice (same window -> one entry), then 5 (different window) and 10 (different window)
  const { report } = await runWith(req, [h(3), h(3), h(5), finding]);
  const windows = report.evidence.history.map((x: any) => `${x.from}..${x.to}#${x.observations}`);
  assert.equal(new Set(windows).size, windows.length, "no duplicates");
  assert.equal(windows.length, 2);
  for (const x of report.evidence.history as any[]) {
    assert.ok(x.window_id, "history entries carry a content-derived window id");
    assert.deepEqual(x.source_types, ["SIMULATOR"]);
  }
});

test("8: same count but different window contents are not collapsed", async () => {
  const req1 = InvestigationRequest.parse({ ...rawFixture("a-normal"), recent_telemetry: [reading({ observation_id: "a", numeric_value: 20 }), reading({ observation_id: "b", numeric_value: 21, observed_at: "2026-11-07T13:59:30.000Z", ingested_at: "2026-11-07T13:59:31.000Z" })] });
  const { report } = await runWith(req1, [
    toolCall("get_telemetry_history", { rack_id: req1.rack_id, metric_type: "AMBIENT_TEMPERATURE_C", limit: 1 }),
    toolCall("get_telemetry_history", { rack_id: req1.rack_id, metric_type: "AMBIENT_TEMPERATURE_C", limit: 2 }),
    finding,
  ]);
  assert.equal(report.evidence.history.length, 2);
});

// ============ 9. Source filtering happens before the eight-source cap ============
import { createTools } from "../src/tools.js";

test("9: a source outside the 8 most recent series is still analyzed when explicitly requested", async () => {
  const base = Date.parse("2026-11-07T13:00:00Z");
  const rows = [];
  for (let s = 0; s < 10; s++)
    for (let i = 0; i < 4; i++) {
      const t = base + (s * 4 + i) * 60_000; // sensor-00 is the oldest series, sensor-09 the newest
      rows.push(reading({ observation_id: `s${s}-${i}`, source_identifier: `sensor-${String(s).padStart(2, "0")}`, numeric_value: 20 + i,
        observed_at: new Date(t).toISOString(), ingested_at: new Date(t + 1000).toISOString() }));
    }
  const req = InvestigationRequest.parse({ ...rawFixture("a-normal"), recent_telemetry: rows });
  const tools = createTools(createSnapshotDataSource(req, { staleAfterMinutes: 15 }));
  const call = async (name: string, args: object) => JSON.parse(String(await (tools.find((t) => t.name === name)! as any).invoke({ rack_id: req.rack_id, metric_type: "AMBIENT_TEMPERATURE_C", ...args })));
  const all = await call("analyze_telemetry_trends", {});
  assert.equal(all.trends[0].series.length, 8, "unfiltered analysis is still capped");
  assert.ok(!all.trends[0].series.some((s: any) => s.source_identifier === "sensor-00"));
  const one = await call("analyze_telemetry_trends", { source_identifier: "sensor-00" });
  assert.equal(one.trends[0].series.length, 1);
  assert.equal(one.trends[0].series[0].source_identifier, "sensor-00");
  assert.equal(one.trends[0].series[0].observation_count, 4);
  assert.equal(one.trends[0].omitted_source_series, 0);
  const missing = await call("analyze_telemetry_trends", { source_identifier: "no-such-sensor" });
  assert.equal(missing.trends[0].series.length, 0);
});

// ============ 5/7. Agent records reports itself; disconnect cancellation ============
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import type { InvestigationStore } from "../src/persistence.js";
import { hang, testConfig } from "./helpers.js";
import { MultiAgentReport } from "../src/schemas.js";

function memoryStore(rows: Record<string, { rack_id: string; status: string; snapshot: unknown; image?: { image_id: string; sha_256: string } }>, failComplete = false) {
  const completed: { id: string; status: string; severity: string; report: any }[] = [];
  const store: InvestigationStore = {
    async load(id) {
      const r = rows[id];
      return { row: r ? { investigation_id: id, rack_id: r.rack_id, status: r.status, snapshot_json: JSON.stringify(r.snapshot) } : null, image: r?.image ?? null };
    },
    async complete(id, status, severity, reportJson) {
      if (failComplete) throw new Error("SpacetimeDB down");
      completed.push({ id, status, severity, report: JSON.parse(reportJson) });
      rows[id].status = status;
    },
  };
  return { store, completed };
}
async function postTo(app: ReturnType<typeof createApp>, body: unknown, opts: { abortAfterMs?: number } = {}) {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const ac = new AbortController();
  if (opts.abortAfterMs) setTimeout(() => ac.abort(), opts.abortAfterMs);
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/investigate`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ac.signal,
    });
    return { status: res.status, body: (await res.json()) as any };
  } catch (err) {
    return { status: 0, body: { error: String(err) } };
  } finally {
    server.close();
  }
}
const normalApp = (store: InvestigationStore | null, sup: Step[] = [decide("telemetry", "t", "p"), decide("finish"), synthesis], spec: Step[] = [finding]) => {
  let calls = 0;
  const app = createApp({
    store,
    getModel: () => {
      calls++;
      return { model: fakeModel(sup).model, specialistModel: fakeModel(spec).model, visionModel: fakeModel([]).model, config: testConfig };
    },
  });
  return { app, modelCalls: () => calls };
};
const ID = "0b9f4c2e-1111-2222-3333-444455556666";

test("5: the agent runs on the STORED snapshot and records the report itself", async () => {
  const snapshot = rawFixture("a-normal");
  const { store, completed } = memoryStore({ [ID]: { rack_id: snapshot.rack_id, status: "RUNNING", snapshot } });
  const { app } = normalApp(store);
  const r = await postTo(app, { investigation_id: ID });
  assert.equal(r.status, 200);
  assert.equal(r.body.persisted, true);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].report.rack_id, snapshot.rack_id);
  assert.equal(completed[0].status, r.body.report.investigation_status);
  MultiAgentReport.parse(completed[0].report);
});

test("5: unknown, already-finished and unconfigured cases are refused before any model call", async () => {
  const snapshot = rawFixture("a-normal");
  const { store, completed } = memoryStore({ [ID]: { rack_id: snapshot.rack_id, status: "COMPLETED", snapshot } });
  const a = normalApp(store);
  assert.equal((await postTo(a.app, { investigation_id: "ffffffff-0000-0000-0000-000000000000" })).status, 404);
  assert.equal((await postTo(a.app, { investigation_id: ID })).status, 409);
  assert.equal((await postTo(a.app, { investigation_id: "bad id;DROP" })).status, 400);
  const b = normalApp(null);
  const r = await postTo(b.app, { investigation_id: ID });
  assert.equal(r.status, 503);
  assert.match(r.body.message, /agent:register/);
  assert.equal(a.modelCalls() + b.modelCalls(), 0);
  assert.equal(completed.length, 0);
});

test("5: image bytes must match the SHA-256 recorded for the investigation", async () => {
  const jpeg = readFileSync(new URL("../test-assets/vision/switch-5port-led-closeup.jpg", import.meta.url));
  const other = readFileSync(new URL("../test-assets/vision/cable-closet.jpg", import.meta.url));
  const realSha = acceptImage(asInput(jpeg, "image/jpeg")).provenance.sha256;
  const img = (bytes: Buffer) => ({ image_id: "img-1", filename: "x.jpg", mime_type: "image/jpeg", data_base64: bytes.toString("base64"), source_type: "MANUAL_UPLOAD" });
  const snapshot = { ...rawFixture("a-normal"), images: [{ image_id: "img-1", filename: "x.jpg", mime_type: "image/jpeg", source_type: "MANUAL_UPLOAD", sha256: realSha }] };
  const { store, completed } = memoryStore({ [ID]: { rack_id: snapshot.rack_id, status: "RUNNING", snapshot, image: { image_id: "img-1", sha_256: realSha } } });
  const { app, modelCalls } = normalApp(store);
  const swapped = await postTo(app, { investigation_id: ID, images: [img(other)] });
  assert.equal(swapped.status, 400);
  assert.match(swapped.body.message, /SHA-256/);
  const missing = await postTo(app, { investigation_id: ID, images: [] });
  assert.equal(missing.status, 400);
  assert.equal(modelCalls(), 0);
  assert.equal(completed.length, 0);
});

test("5: if recording fails the response says so (persisted: false) instead of claiming success", async () => {
  const snapshot = rawFixture("a-normal");
  const { store } = memoryStore({ [ID]: { rack_id: snapshot.rack_id, status: "RUNNING", snapshot } }, true);
  const r = await postTo(normalApp(store).app, { investigation_id: ID });
  assert.equal(r.status, 502);
  assert.equal(r.body.persisted, false);
  assert.match(r.body.persist_error, /SpacetimeDB down/);
});

test("7: a stateless request is cancelled when the client disconnects", async () => {
  let aborted = false;
  const watching: Step = (msgs, config) => {
    config?.signal?.addEventListener("abort", () => (aborted = true));
    return (hang as any)(msgs, config);
  };
  const { app } = normalApp(null, [watching, synthesis]);
  const t0 = Date.now();
  const r = await postTo(app, rawFixture("a-normal"), { abortAfterMs: 100 });
  assert.equal(r.status, 0, "client gave up");
  await new Promise((res) => setTimeout(res, 100));
  assert.ok(aborted, "the in-flight model call received the cancellation");
  assert.ok(Date.now() - t0 < 3000);
});

// ============ Token efficiency (live measurement: verification and routing dominated usage) ============
test("efficiency: a repeated verification with no new findings is skipped", async () => {
  const req = InvestigationRequest.parse(rawFixture("c-critical"));
  const v = json({ grounded: true, verified_findings: ["35.4 °C exceeds 33 °C"], unsupported_claims: [], contradictions: [], missing_evidence: [], request_more_investigation: false });
  const { report } = await runMultiAgentInvestigation(req, {
    supervisorModel: fakeModel([decide("telemetry", "t", "p"), decide("verification", "v1"), decide("verification", "v2 again"), synthesis]).model,
    specialistModel: fakeModel([finding, v]).model, supervisorModelName: "s", specialistModelName: "s",
    dataSource: createSnapshotDataSource(req, { staleAfterMinutes: 15 }), staleAfterMinutes: 15,
    maxDelegations: 5, maxSpecialistToolRounds: 3, maxVerificationRetries: 1, maxInvestigationSeconds: 90,
  });
  assert.deepEqual(report.agents_invoked.map((a) => a.agent), ["telemetry", "verification"]);
  assert.equal(report.verification_outcome, "VERIFIED");
});

test("efficiency: a FAILED verification may still be retried", async () => {
  const req = InvestigationRequest.parse(rawFixture("c-critical"));
  const v = json({ grounded: true, verified_findings: ["35.4 °C exceeds 33 °C"], unsupported_claims: [], contradictions: [], missing_evidence: [], request_more_investigation: false });
  const { report } = await runMultiAgentInvestigation(req, {
    supervisorModel: fakeModel([decide("telemetry", "t", "p"), decide("verification", "v1"), decide("verification", "retry"), decide("finish"), synthesis]).model,
    specialistModel: fakeModel([finding, new Error("503 down"), v]).model, supervisorModelName: "s", specialistModelName: "s",
    dataSource: createSnapshotDataSource(req, { staleAfterMinutes: 15 }), staleAfterMinutes: 15,
    maxDelegations: 5, maxSpecialistToolRounds: 3, maxVerificationRetries: 1, maxInvestigationSeconds: 90,
  });
  assert.deepEqual(report.agents_invoked.map((a) => a.agent), ["telemetry", "verification", "verification"]);
  assert.equal(report.verification_outcome, "VERIFIED");
});

test("efficiency: later Supervisor prompts carry a compact digest; verification gets code-computed evidence", async () => {
  const req = InvestigationRequest.parse(rawFixture("c-critical"));
  const sup = fakeModel([decide("telemetry", "t", "p"), decide("verification", "v"), decide("finish"), synthesis]);
  const spec = fakeModel([finding, json({ grounded: true, verified_findings: [], unsupported_claims: [], contradictions: [], missing_evidence: [], request_more_investigation: false })]);
  const { report } = await runMultiAgentInvestigation(req, {
    supervisorModel: sup.model, specialistModel: spec.model, supervisorModelName: "s", specialistModelName: "s",
    dataSource: createSnapshotDataSource(req, { staleAfterMinutes: 15 }), staleAfterMinutes: 15,
    maxDelegations: 5, maxSpecialistToolRounds: 3, maxVerificationRetries: 1, maxInvestigationSeconds: 90,
  });
  const size = (i: number) => String(sup.calls[i][1].content).length;
  assert.match(String(sup.calls[0][1].content), /policy_version/, "first decision sees full evidence");
  assert.doesNotMatch(String(sup.calls[1][1].content), /policy_version/, "later decisions see the digest");
  assert.match(String(sup.calls[1][1].content), /compact digest/);
  assert.ok(size(1) < size(0), `later prompt ${size(1)} should be smaller than first ${size(0)}`);
  const verifyPrompt = String(spec.calls[1][1].content);
  assert.match(verifyPrompt, /Code-computed evidence/);
  assert.match(verifyPrompt, /"direction"/);
  assert.match(verifyPrompt, /FICTIONAL_DEMO_CONFIGURATION/);
  assert.equal((report.evidence.configured_thresholds as any).provenance, "FICTIONAL_DEMO_CONFIGURATION");
});

test("efficiency: verification requested before any findings is redirected (photo -> vision, else telemetry)", async () => {
  const req = InvestigationRequest.parse(rawFixture("c-critical"));
  const v = json({ grounded: true, verified_findings: ["35.4 °C exceeds 33 °C"], unsupported_claims: [], contradictions: [], missing_evidence: [], request_more_investigation: false });
  const { report, events } = await runMultiAgentInvestigation(req, {
    supervisorModel: fakeModel([decide("verification", "verify first", "p"), decide("verification", "v"), decide("finish"), synthesis]).model,
    specialistModel: fakeModel([finding, v]).model, supervisorModelName: "s", specialistModelName: "s",
    dataSource: createSnapshotDataSource(req, { staleAfterMinutes: 15 }), staleAfterMinutes: 15,
    maxDelegations: 5, maxSpecialistToolRounds: 3, maxVerificationRetries: 1, maxInvestigationSeconds: 90,
  });
  assert.deepEqual(report.agents_invoked.map((a) => a.agent), ["telemetry", "verification"]);
  assert.ok(events.some((e) => e.type === "GUARD" && /Nothing to verify yet/.test(e.description)));
});
