import { test } from "node:test";
import assert from "node:assert/strict";
import { validateInvestigationStart, validateInvestigationCompletion } from "../src/investigation";

const ok = { investigationId: "0b9f4c2e-1111-2222-3333-444455556666", rackId: "rack-1", snapshotJson: '{"rack_id":"rack-1"}' };
const report = (status: string, severity: string) => JSON.stringify({ investigation_status: status, severity, summary: "x" });

test("start: valid snapshot accepted; bad id, JSON, or rack mismatch rejected", () => {
  validateInvestigationStart(ok);
  assert.throws(() => validateInvestigationStart({ ...ok, investigationId: "x" }), /ID/);
  assert.throws(() => validateInvestigationStart({ ...ok, snapshotJson: "{" }), /valid JSON/);
  assert.throws(() => validateInvestigationStart({ ...ok, snapshotJson: '{"rack_id":"rack-2"}' }), /does not match/);
  assert.throws(() => validateInvestigationStart({ ...ok, snapshotJson: "x".repeat(200_001) }), /exceeds/);
});

test("completion: statuses, severities and report consistency are enforced", () => {
  validateInvestigationCompletion({ status: "COMPLETED", severity: "CRITICAL", reportJson: report("COMPLETED", "CRITICAL"), eventsJson: "[]" });
  validateInvestigationCompletion({ status: "INCOMPLETE", severity: "UNKNOWN", reportJson: report("INCOMPLETE", "UNKNOWN"), eventsJson: "[]" });
  validateInvestigationCompletion({ status: "FAILED", severity: "UNKNOWN", reportJson: '{"error":"agent unreachable"}', eventsJson: "[]" });
  assert.throws(() => validateInvestigationCompletion({ status: "RUNNING", severity: "UNKNOWN", reportJson: "{}", eventsJson: "[]" }), /status/);
  assert.throws(() => validateInvestigationCompletion({ status: "COMPLETED", severity: "BAD", reportJson: "{}", eventsJson: "[]" }), /severity/);
  // A failed agent run cannot be stored as a success.
  assert.throws(() => validateInvestigationCompletion({ status: "COMPLETED", severity: "NORMAL", reportJson: report("FAILED", "UNKNOWN"), eventsJson: "[]" }), /do not match/);
  assert.throws(() => validateInvestigationCompletion({ status: "COMPLETED", severity: "NORMAL", reportJson: '{"error":"x"}', eventsJson: "[]" }), /must be FAILED/);
  assert.throws(() => validateInvestigationCompletion({ status: "COMPLETED", severity: "CRITICAL", reportJson: report("COMPLETED", "CRITICAL"), eventsJson: "{}" }), /array/);
});
