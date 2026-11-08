import { test } from "node:test";
import assert from "node:assert/strict";
import { validateInvestigationStart, validateInvestigationCompletion } from "../src/investigation";

const ok = { investigationId: "0b9f4c2e-1111-2222-3333-444455556666", rackId: "rack-1", snapshotJson: '{"rack_id":"rack-1"}' };
const report = (status: string, severity: string, extra: object = {}) =>
  JSON.stringify({
    rack_id: "rack-1", investigation_status: status, severity, summary: "x",
    hypotheses: [], recommended_next_inspection: [], tool_calls: [], agents_invoked: [], specialist_findings: [],
    verified_findings: [], missing_information: [], limits_reached: [], unsupported_claims: [], evidence: {},
    verification_outcome: status === "COMPLETED" ? "VERIFIED" : "NOT_RUN",
    incomplete_reasons: status === "COMPLETED" ? [] : ["reason"],
    ...extra,
  });

test("start: valid snapshot accepted; bad id, JSON, or rack mismatch rejected", () => {
  validateInvestigationStart(ok);
  assert.throws(() => validateInvestigationStart({ ...ok, investigationId: "x" }), /ID/);
  assert.throws(() => validateInvestigationStart({ ...ok, snapshotJson: "{" }), /valid JSON/);
  assert.throws(() => validateInvestigationStart({ ...ok, snapshotJson: '{"rack_id":"rack-2"}' }), /does not match/);
  assert.throws(() => validateInvestigationStart({ ...ok, snapshotJson: "x".repeat(200_001) }), /exceeds/);
});

test("completion: statuses, severities and report consistency are enforced", () => {
  const c = (status: string, severity: string, reportJson: string, eventsJson = "[]") =>
    validateInvestigationCompletion({ status, severity, reportJson, eventsJson }, "rack-1");
  c("COMPLETED", "CRITICAL", report("COMPLETED", "CRITICAL"));
  c("INCOMPLETE", "UNKNOWN", report("INCOMPLETE", "UNKNOWN"));
  c("FAILED", "UNKNOWN", report("FAILED", "UNKNOWN"));
  assert.throws(() => c("RUNNING", "UNKNOWN", "{}"), /status/);
  assert.throws(() => c("COMPLETED", "BAD", "{}"), /severity/);
  // A failed agent run cannot be stored as a success.
  assert.throws(() => c("COMPLETED", "NORMAL", report("FAILED", "UNKNOWN")), /do not match/);
  // Agents must submit a real report; "no report" failures are only possible via abandon_investigation.
  assert.throws(() => c("FAILED", "UNKNOWN", '{"error":"x"}'), /rack_id/);
  assert.throws(() => c("COMPLETED", "CRITICAL", report("COMPLETED", "CRITICAL"), "{}"), /array/);
});

import { validateInvestigationImage, assertNoImagePayload } from "../src/investigation";

const image = {
  imageId: "ref-switch-5port-led-closeup",
  filename: "switch.jpg",
  mimeType: "image/jpeg",
  sourceType: "ONLINE_REFERENCE",
  sourceUrl: "https://commons.wikimedia.org/wiki/File:Netgear_Gigabit_Switch_5-port.jpg",
  attribution: "Simon A. Eugster",
  license: "CC BY-SA 3.0",
  sha256: "071617f2108d" + "0".repeat(52),
  byteSize: 169_000,
  width: 1920,
  height: 1272,
  thumbnailDataUrl: "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
};

test("image provenance: valid record accepted; bad hash, type, source, URL, size, thumbnail rejected", () => {
  validateInvestigationImage(image);
  validateInvestigationImage({ ...image, sourceUrl: "", thumbnailDataUrl: "" });
  assert.throws(() => validateInvestigationImage({ ...image, sha256: "abc" }), /sha256/);
  assert.throws(() => validateInvestigationImage({ ...image, mimeType: "image/gif" }), /JPEG and PNG/);
  assert.throws(() => validateInvestigationImage({ ...image, sourceType: "SATELLITE" }), /source type/);
  assert.throws(() => validateInvestigationImage({ ...image, sourceUrl: "file:///etc/passwd" }), /source URL/);
  assert.throws(() => validateInvestigationImage({ ...image, width: 5000 }), /dimensions/);
  assert.throws(() => validateInvestigationImage({ ...image, thumbnailDataUrl: "data:image/png;base64,AAAA" }), /Thumbnail/);
  assert.throws(() => validateInvestigationImage({ ...image, thumbnailDataUrl: "data:image/jpeg;base64," + "A".repeat(60_001) }), /Thumbnail/);
});

test("investigation rows never store image payloads", () => {
  assert.throws(() => validateInvestigationStart({ ...ok, snapshotJson: JSON.stringify({ rack_id: "rack-1", images: [{ data_base64: "/9j/" }] }) }), /must not contain image data/);
  assert.throws(
    () => validateInvestigationCompletion({ status: "COMPLETED", severity: "NORMAL", reportJson: JSON.stringify({ investigation_status: "COMPLETED", severity: "NORMAL", x: "data:image/jpeg;base64,/9j/" }), eventsJson: "[]" }, "rack-1"),
    /must not contain image data/,
  );
  assertNoImagePayload("Snapshot", JSON.stringify({ rack_id: "rack-1", images: [{ image_id: "a", sha256: "b" }] }));
});
