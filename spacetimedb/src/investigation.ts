// Validation for client-submitted AI investigation records (Feature 2 integration).
// These checks keep stored records well-formed and self-consistent. They do NOT
// authenticate that a report was produced by the agent service: in this local demo
// any connected identity may submit one. See README "AI investigation trust model".

export const INVESTIGATION_STATUSES = ["RUNNING", "COMPLETED", "INCOMPLETE", "FAILED"] as const;
export const SEVERITIES = ["NORMAL", "WARNING", "CRITICAL", "UNKNOWN"] as const;
export const MAX_SNAPSHOT_CHARS = 200_000;
export const MAX_REPORT_CHARS = 200_000;
export const MAX_EVENTS_CHARS = 100_000;

const ID_RE = /^[A-Za-z0-9-]{8,64}$/;

function parseJson(text: string, label: string, max: number): unknown {
  if (text.length > max) throw new Error(`${label} exceeds ${max} characters`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validateInvestigationStart(args: { investigationId: string; rackId: string; snapshotJson: string }) {
  if (!ID_RE.test(args.investigationId)) throw new Error("Invalid investigation ID");
  const snap = parseJson(args.snapshotJson, "Snapshot", MAX_SNAPSHOT_CHARS);
  if (!isObject(snap) || snap.rack_id !== args.rackId)
    throw new Error("Snapshot rack_id does not match the investigated rack");
}

export function validateInvestigationCompletion(args: {
  status: string;
  severity: string;
  reportJson: string;
  eventsJson: string;
}) {
  if (!(INVESTIGATION_STATUSES as readonly string[]).includes(args.status) || args.status === "RUNNING")
    throw new Error("Completion status must be COMPLETED, INCOMPLETE or FAILED");
  if (!(SEVERITIES as readonly string[]).includes(args.severity)) throw new Error("Invalid severity");
  const report = parseJson(args.reportJson, "Report", MAX_REPORT_CHARS);
  const events = parseJson(args.eventsJson, "Events", MAX_EVENTS_CHARS);
  if (!isObject(report)) throw new Error("Report must be a JSON object");
  if (!Array.isArray(events)) throw new Error("Events must be a JSON array");
  // A report that came back from the agent must agree with the stored summary columns.
  if ("investigation_status" in report || "severity" in report) {
    if (report.investigation_status !== args.status || report.severity !== args.severity)
      throw new Error("Report status/severity do not match the submitted values");
  } else if (args.status !== "FAILED" || args.severity !== "UNKNOWN") {
    // No agent report (e.g. agent unreachable): may only be recorded as a failure.
    throw new Error("A record without an agent report must be FAILED with UNKNOWN severity");
  }
}
