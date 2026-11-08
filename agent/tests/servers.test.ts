// Five sourced servers + documented thresholds (SCRIPTED/unit; no NVIDIA calls).
import { test } from "node:test";
import assert from "node:assert/strict";
import { lookupDocumentation } from "../src/documentation.js";
import { InvestigationRequest, RackProfile, thresholdProvenance } from "../src/schemas.js";
import { createSnapshotDataSource } from "../src/tools.js";
import { rawFixture } from "./helpers.js";

const SERVERS = [
  ["Dell", "PowerEdge R760", "DELL-R760-ENV"],
  ["HPE", "ProLiant DL360 Gen11", "HPE-DL360-G11-ENV"],
  ["Lenovo", "ThinkSystem SR650 V3", "LENOVO-SR650-V3-ENV"],
  ["Cisco", "UCS C220 M7", "CISCO-C220-M7-ENV"],
  ["Supermicro", "SYS-621C-TN12R", "SUPERMICRO-SYS-621C-TN12R-ENV"],
] as const;
const id = (manufacturer: string, model: string) => ({ manufacturer, model, provenance: "OPERATOR_PROVIDED" as const, assertion: "assigned" });

test("documentation: each of the five servers matches exactly its own sourced record", () => {
  for (const [mfr, model, docId] of SERVERS) {
    const r = lookupDocumentation("Compute", "temperature", id(mfr, model));
    assert.equal(r.match_status, "MATCH", model);
    const mfrDocs = r.documents.filter((d) => d.source_type === "MANUFACTURER_SPECIFICATION" && d.verified);
    assert.deepEqual(mfrDocs.map((d) => d.doc_id), [docId]);
    assert.ok(mfrDocs[0].source_url?.startsWith("https://"));
    assert.ok(mfrDocs[0].technical_facts!.length >= 2);
  }
});
test("documentation: near-miss models and unasserted identities get no model-specific guidance", () => {
  assert.equal(lookupDocumentation("Compute", "temperature", id("Dell", "PowerEdge R760xa")).match_status, "NO_MATCH");
  assert.equal(lookupDocumentation("Compute", "temperature", id("HPE", "ProLiant DL360 Gen10 Plus")).match_status, "NO_MATCH");
  assert.equal(lookupDocumentation("Compute", "temperature").match_status, "NO_MATCH");
});
const source = { kind: "MANUFACTURER_DOCUMENTED_RANGE" as const, doc_id: "CISCO-C220-M7-ENV", manufacturer: "Cisco", model: "UCS C220 M7",
  source_url: "https://www.cisco.com/c/en/us/td/docs/unified_computing/ucs/c/hw/C220M7/install/b-c220-m7-installation-guide/m-specifications.html",
  mapping: "Critical at 35 °C (the only documented operating upper limit; no separate warning tier is documented)" };
test("profile: a documented range may have no separate warning tier; a demo profile may not", () => {
  const base = { name: "p", temperature_warning_c: 35, temperature_critical_c: 35, humidity_warning_percent: 90 };
  assert.throws(() => RackProfile.parse(base));
  const p = RackProfile.parse({ ...base, threshold_source: source });
  assert.equal(thresholdProvenance(p), "MANUFACTURER_DOCUMENTED_RANGE");
  assert.equal(thresholdProvenance({}), "FICTIONAL_DEMO_CONFIGURATION");
});
test("tools: threshold provenance in profile and trends follows the applied source", () => {
  const raw = rawFixture("c-critical");
  const doc = InvestigationRequest.parse({ ...raw, profile: { ...raw.profile, temperature_warning_c: 35, temperature_critical_c: 35, threshold_source: source } });
  const ds = createSnapshotDataSource(doc, { staleAfterMinutes: 15 });
  const prof = ds.getRackProfile(doc.rack_id) as any;
  assert.equal(prof.threshold_provenance, "MANUFACTURER_DOCUMENTED_RANGE");
  assert.match(prof.note, /documented range .* not inlet temperature/);
  const trend = ds.getTelemetryTrends(doc.rack_id).find((t: any) => t.metric_type === "AMBIENT_TEMPERATURE_C");
  assert.equal(trend!.thresholds.provenance, "MANUFACTURER_DOCUMENTED_RANGE");
  const demo = createSnapshotDataSource(InvestigationRequest.parse(raw), { staleAfterMinutes: 15 });
  assert.equal((demo.getRackProfile(raw.rack_id) as any).threshold_provenance, "FICTIONAL_DEMO_CONFIGURATION");
});

test("documentation: the 'thresholds are fictional' project note is not returned once a documented range is applied", () => {
  const raw = rawFixture("c-critical");
  const ident = { manufacturer: "Cisco", model: "UCS C220 M7", provenance: "OPERATOR_PROVIDED" as const, assertion: "assigned" };
  const doc = InvestigationRequest.parse({ ...raw, equipment_type: "Compute", equipment_identity: ident,
    profile: { ...raw.profile, temperature_warning_c: 35, temperature_critical_c: 35, threshold_source: source } });
  const ids = (r: any) => r.documents.map((d: any) => d.doc_id);
  const withSource = createSnapshotDataSource(doc, { staleAfterMinutes: 15 }).lookupDocumentation("Compute", "temperature") as any;
  assert.ok(!ids(withSource).includes("SENTINEL-DEMO-PROFILES"));
  assert.ok(ids(withSource).includes("CISCO-C220-M7-ENV"));
  const demo = InvestigationRequest.parse({ ...raw, equipment_type: "Compute" });
  assert.ok(ids(createSnapshotDataSource(demo, { staleAfterMinutes: 15 }).lookupDocumentation("Compute", "temperature")).includes("SENTINEL-DEMO-PROFILES"));
});
