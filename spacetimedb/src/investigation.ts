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
  assertNoImagePayload("Snapshot", args.snapshotJson);
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
  assertNoImagePayload("Report", args.reportJson);
  // A report that came back from the agent must agree with the stored summary columns.
  if ("investigation_status" in report || "severity" in report) {
    if (report.investigation_status !== args.status || report.severity !== args.severity)
      throw new Error("Report status/severity do not match the submitted values");
  } else if (args.status !== "FAILED" || args.severity !== "UNKNOWN") {
    // No agent report (e.g. agent unreachable): may only be recorded as a failure.
    throw new Error("A record without an agent report must be FAILED with UNKNOWN severity");
  }
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
