// Validation for AI investigation records.
// Trust model (fix/investigation-integrity, issue 5): browsers may only START an investigation,
// attach its image provenance, or ABANDON their own run as FAILED with no diagnosis. Reports are
// recorded only by an agent identity that the database admin explicitly authorized. These checks
// additionally keep every stored report well-formed and consistent with its row.

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
  assertNoImagePayload("Snapshot", args.snapshotJson);
}

export const VERIFICATION_OUTCOMES = ["VERIFIED", "NOT_GROUNDED", "INCOMPLETE", "FAILED", "NOT_RUN", "NOT_REQUIRED"] as const;
const REPORT_ARRAYS = [
  "hypotheses",
  "recommended_next_inspection",
  "tool_calls",
  "agents_invoked",
  "specialist_findings",
  "verified_findings",
  "missing_information",
  "limits_reached",
  "incomplete_reasons",
  "unsupported_claims",
] as const;

/** Agent-recorded completion. `rackId` is the investigated rack from the stored row. */
export function validateInvestigationCompletion(
  args: { status: string; severity: string; reportJson: string; eventsJson: string },
  rackId: string,
) {
  if (!(INVESTIGATION_STATUSES as readonly string[]).includes(args.status) || args.status === "RUNNING")
    throw new Error("Completion status must be COMPLETED, INCOMPLETE or FAILED");
  if (!(SEVERITIES as readonly string[]).includes(args.severity)) throw new Error("Invalid severity");
  const report = parseJson(args.reportJson, "Report", MAX_REPORT_CHARS);
  const events = parseJson(args.eventsJson, "Events", MAX_EVENTS_CHARS);
  if (!isObject(report)) throw new Error("Report must be a JSON object");
  if (!Array.isArray(events) || !events.every((e) => isObject(e) && typeof e.type === "string" && typeof e.description === "string"))
    throw new Error("Events must be a JSON array of timeline events");
  assertNoImagePayload("Report", args.reportJson);
  assertNoImagePayload("Events", args.eventsJson);
  // The report must describe this investigation's rack and agree with the summary columns.
  if (report.rack_id !== rackId) throw new Error(`Report rack_id ${JSON.stringify(report.rack_id)} does not match investigated rack ${rackId}`);
  if (report.investigation_status !== args.status || report.severity !== args.severity)
    throw new Error("Report status/severity do not match the submitted values");
  if (typeof report.summary !== "string" || !report.summary.trim()) throw new Error("Report has no summary");
  for (const k of REPORT_ARRAYS) if (!Array.isArray(report[k])) throw new Error(`Report field ${k} must be an array`);
  if (!isObject(report.evidence)) throw new Error("Report has no evidence object");
  if (!(VERIFICATION_OUTCOMES as readonly string[]).includes(report.verification_outcome as string))
    throw new Error("Report has an invalid verification_outcome");
  const reasons = report.incomplete_reasons as unknown[];
  // Processing completion and verification quality must be consistent (issue 3).
  if (args.status === "COMPLETED") {
    if (reasons.length) throw new Error("A COMPLETED report cannot list incomplete reasons");
    if (report.verification_outcome !== "VERIFIED" && report.verification_outcome !== "NOT_REQUIRED")
      throw new Error("A COMPLETED report requires VERIFIED (or NOT_REQUIRED) verification");
  } else if (!reasons.length) {
    throw new Error("An INCOMPLETE or FAILED report must state why");
  }
  if (args.status === "FAILED" && args.severity !== "UNKNOWN") throw new Error("A FAILED investigation must have UNKNOWN severity");
}

export const MAX_ABANDON_REASON = 500;
/** What a browser may store when it gives up on its own run: FAILED, UNKNOWN, no diagnosis. */
export function abandonedReport(reason: string): string {
  const clean = reason.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_ABANDON_REASON) || "Investigation abandoned by the client";
  return JSON.stringify({ error: clean, recorded_by: "CLIENT", diagnosis: null });
}
export function expiredReport(seconds: number): string {
  return JSON.stringify({
    error: `No completion was recorded within ${seconds} s; the database marked this investigation as failed.`,
    recorded_by: "DATABASE",
    diagnosis: null,
  });
}

// ---- Stale recovery and retention (issues 7, 10) ----
export const DEFAULT_RUNNING_TIMEOUT_SECONDS = 300; // agent hard stop is ~145 s; client gives up at 180 s
export const EXPIRY_INTERVAL_SECONDS = 60;
export const MAX_INVESTIGATIONS_PER_RACK = 20;

export function isStaleRunning(row: { status: string; createdMicros: bigint }, nowMicros: bigint, timeoutSeconds: number) {
  return row.status === "RUNNING" && nowMicros - row.createdMicros > BigInt(timeoutSeconds) * 1_000_000n;
}

/** Oldest terminal investigations beyond the per-rack limit. RUNNING rows are never deleted. */
export function retentionDeletions(rows: { id: string; status: string; createdMicros: bigint }[], keep = MAX_INVESTIGATIONS_PER_RACK): string[] {
  const newestFirst = [...rows].sort((a, b) => (a.createdMicros < b.createdMicros ? 1 : a.createdMicros > b.createdMicros ? -1 : a.id < b.id ? 1 : -1));
  return newestFirst.slice(keep).filter((r) => r.status !== "RUNNING").map((r) => r.id);
}

// ---- Image provenance (Feature 4) ----
export const IMAGE_SOURCE_TYPES = ["MANUAL_UPLOAD", "ONLINE_REFERENCE", "ROVER_CAMERA"] as const;
export const MAX_THUMBNAIL_CHARS = 60_000; // small JPEG preview only; full images are never stored
const THUMB_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/;

/** Stored investigation rows must never carry image payloads (only ids, hashes and provenance). */
export function assertNoImagePayload(label: string, json: string) {
  if (/"data_base64"\s*:/.test(json) || /data:image\/[a-z]+;base64,/i.test(json))
    throw new Error(`${label} must not contain image data; store provenance only`);
}

export function validateInvestigationImage(args: {
  imageId: string;
  filename: string;
  mimeType: string;
  sourceType: string;
  sourceUrl: string;
  attribution: string;
  license: string;
  sha256: string;
  byteSize: number;
  width: number;
  height: number;
  thumbnailDataUrl: string;
}) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(args.imageId)) throw new Error("Invalid image ID");
  if (!args.filename.trim() || args.filename.length > 200) throw new Error("Invalid filename");
  if (args.mimeType !== "image/jpeg" && args.mimeType !== "image/png") throw new Error("Only JPEG and PNG images are supported");
  if (!(IMAGE_SOURCE_TYPES as readonly string[]).includes(args.sourceType)) throw new Error("Invalid image source type");
  if (args.sourceUrl && (!/^https?:\/\//.test(args.sourceUrl) || args.sourceUrl.length > 500)) throw new Error("Invalid source URL");
  if (args.attribution.length > 300 || args.license.length > 100) throw new Error("Attribution or license too long");
  if (!/^[0-9a-f]{64}$/.test(args.sha256)) throw new Error("sha256 must be 64 lowercase hex characters");
  if (!Number.isInteger(args.byteSize) || args.byteSize < 1 || args.byteSize > 4 * 1024 * 1024) throw new Error("Invalid image size");
  for (const d of [args.width, args.height])
    if (!Number.isInteger(d) || d < 1 || d > 4096) throw new Error("Invalid image dimensions");
  if (args.thumbnailDataUrl && (args.thumbnailDataUrl.length > MAX_THUMBNAIL_CHARS || !THUMB_RE.test(args.thumbnailDataUrl)))
    throw new Error(`Thumbnail must be a JPEG data URL of at most ${MAX_THUMBNAIL_CHARS} characters`);
}
