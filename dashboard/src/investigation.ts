// Adapter between SpacetimeDB-subscribed rows and the Feature 2 agent API.
// Pure functions with structural types (no SDK runtime import) so the agent's
// test suite can check the output against its own Zod request schema.

type Ts = { microsSinceUnixEpoch: bigint };

export const SUPPORTED_METRICS = [
  "AMBIENT_TEMPERATURE_C",
  "RELATIVE_HUMIDITY_PERCENT",
  "SOUND_RAW",
  "ULTRASONIC_DISTANCE_CM",
] as const;

export interface ObservationRow {
  rackId: string;
  metricType: string;
  numericValue: number;
  unit: string;
  sourceType: string;
  sourceIdentifier: string;
  observationId?: bigint;
  observedAt: Ts;
  ingestedAt: Ts;
}

export interface SnapshotInput {
  rack: { rackId: string; displayName: string; profileId: string };
  profile: {
    profileId: string;
    name: string;
    equipmentType: string;
    temperatureWarningC: number;
    temperatureCriticalC: number;
    humidityWarningPercent: number;
  };
  current: readonly ObservationRow[];
  recent: readonly ObservationRow[];
  alerts: readonly {
    alertId: string;
    rackId: string;
    metricType: string;
    severity: string;
    message: string;
    active: boolean;
    createdAt: Ts;
  }[];
  asOf: Date;
  staleAfterSeconds: number;
}

// ---------------- images (Feature 4) ----------------

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 4096;
export type ImageSourceType =
  | "MANUAL_UPLOAD"
  | "ONLINE_REFERENCE"
  | "ROVER_CAMERA";
export type InspectionMode = "TELEMETRY" | "VISUAL" | "COMBINED";

/** A validated image ready to send. base64 is sent to the agent only; it is never stored. */
export interface ImageAttachment {
  imageId: string;
  filename: string;
  mimeType: "image/jpeg" | "image/png";
  base64: string;
  sha256: string;
  byteSize: number;
  width: number;
  height: number;
  thumbnailDataUrl: string;
  sourceType: ImageSourceType;
  captureTimestamp: string | null;
  sourceUrl: string;
  attribution: string;
  license: string;
}

/** Real file signature, independent of the file name or declared type. */
export function sniffImageType(
  b: Uint8Array,
): "image/jpeg" | "image/png" | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return "image/jpeg";
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length >= 8 && png.every((v, i) => b[i] === v)) return "image/png";
  return null;
}

export const toIso = (t: Ts) =>
  new Date(Number(t.microsSinceUnixEpoch / 1000n)).toISOString();

// Ultrasonic distance belongs exclusively to collision safety, never equipment diagnosis.
const supported = (m: string) =>
  m !== "ULTRASONIC_DISTANCE_CM" &&
  (SUPPORTED_METRICS as readonly string[]).includes(m);

function reading(r: ObservationRow) {
  return {
    ...(r.observationId !== undefined
      ? { observation_id: r.observationId.toString() }
      : {}),
    metric_type: r.metricType,
    numeric_value: r.numericValue,
    unit: r.unit, // actual unit stored in SpacetimeDB (e.g. "°C", "%RH")
    source_type: r.sourceType,
    source_identifier: r.sourceIdentifier,
    observed_at: toIso(r.observedAt),
    ingested_at: toIso(r.ingestedAt),
    simulated: r.sourceType === "SIMULATOR",
  };
}

/** Build the agent's InvestigationRequest from one rack's subscribed rows. Missing readings stay missing.
 *  VISUAL mode sends no telemetry at all (the operator chose not to combine it). */
export interface EquipmentIdentity {
  manufacturer: string;
  model: string;
  provenance: "OPERATOR_PROVIDED";
  assertion: string;
}
export function buildInvestigationRequest(
  s: SnapshotInput,
  opts: {
    mode?: InspectionMode;
    image?: ImageAttachment;
    equipmentIdentity?: EquipmentIdentity;
  } = {},
) {
  const visualOnly = opts.mode === "VISUAL";
  const mine = <T extends { rackId: string }>(rows: readonly T[]) =>
    visualOnly ? [] : rows.filter((r) => r.rackId === s.rack.rackId);
  const image = opts.image;
  return {
    rack_id: s.rack.rackId,
    rack_name: s.rack.displayName,
    equipment_type: s.profile.equipmentType,
    ...(opts.equipmentIdentity
      ? { equipment_identity: opts.equipmentIdentity }
      : {}),
    profile: {
      name: s.profile.name,
      temperature_warning_c: s.profile.temperatureWarningC,
      temperature_critical_c: s.profile.temperatureCriticalC,
      humidity_warning_percent: s.profile.humidityWarningPercent,
    },
    current_telemetry: mine(s.current)
      .filter((r) => supported(r.metricType))
      .map(reading),
    recent_telemetry: mine(s.recent)
      .filter((r) => supported(r.metricType))
      .sort((a, b) =>
        a.observedAt.microsSinceUnixEpoch < b.observedAt.microsSinceUnixEpoch
          ? -1
          : 1,
      )
      .map(reading),
    active_alerts: mine(s.alerts)
      .filter((a) => a.active && supported(a.metricType))
      .map((a) => ({
        alert_id: a.alertId,
        severity: a.severity,
        message: a.message,
        ...(supported(a.metricType) ? { metric_type: a.metricType } : {}),
        raised_at: toIso(a.createdAt),
      })),
    as_of: s.asOf.toISOString(),
    stale_after_minutes: s.staleAfterSeconds / 60,
    ...(opts.mode ? { inspection_mode: opts.mode } : {}),
    ...(image
      ? {
          images: [
            {
              image_id: image.imageId,
              filename: image.filename,
              mime_type: image.mimeType,
              data_base64: image.base64,
              source_type: image.sourceType,
              capture_timestamp: image.captureTimestamp,
              source_url: image.sourceUrl || null,
              attribution: image.attribution || null,
              license: image.license || null,
            },
          ],
        }
      : {}),
  };
}

/** The persisted snapshot: identical to the request but with image bytes replaced by the hash. */
export function snapshotForStorage(
  req: ReturnType<typeof buildInvestigationRequest>,
  image?: ImageAttachment,
) {
  if (!("images" in req) || !req.images) return req;
  return {
    ...req,
    images: req.images.map(({ data_base64: _bytes, ...rest }) => ({
      ...rest,
      sha256: image?.sha256 ?? null,
      byte_size: image?.byteSize ?? null,
    })),
  };
}

// ---------------- response validation ----------------

const STATUSES = ["COMPLETED", "INCOMPLETE", "FAILED"];
const SEVERITIES = ["NORMAL", "WARNING", "CRITICAL", "UNKNOWN"];

export interface AgentEvent {
  type: string;
  timestamp: string;
  agent?: string;
  tool?: string;
  description: string;
  status: string;
}

export interface AgentReport {
  rack_id: string;
  severity: string;
  summary: string;
  investigation_status: string;
  hypotheses: {
    description: string;
    supporting_evidence: string[];
    contradicting_evidence: string[];
    missing_evidence: string[];
  }[];
  recommended_next_inspection: string[];
  tool_calls: {
    agent?: string;
    round: number;
    tool: string;
    args: Record<string, unknown>;
    status: string;
    result_summary: string;
  }[];
  model: string;
  supervisor_plan: string;
  agents_invoked: { agent: string; objective: string; status: string }[];
  specialist_findings: {
    agent: string;
    objective: string;
    status: string;
    observations: string[];
    hypotheses: { description: string }[];
    missing_information: string[];
    recommended_next_action: string;
    tools_executed: unknown[];
  }[];
  verification: null | {
    status?: "COMPLETED" | "INCOMPLETE" | "FAILED";
    grounded: boolean;
    verified_findings: string[];
    unsupported_claims: string[];
    contradictions: string[];
    missing_evidence: string[];
    request_more_investigation: boolean;
    follow_up_agent?: string | null;
    follow_up_objective?: string | null;
  };
  verified_findings: string[];
  missing_information: string[];
  evidence: {
    measurements: Record<string, unknown>[];
    history: Record<string, unknown>[];
    configured_thresholds: Record<string, unknown> | null;
    documentation: Record<string, unknown>[];
    trends?: Record<string, unknown>[];
    early_warning_indicators?: Record<string, unknown>[];
    equipment_identity?: EquipmentIdentity | null;
    documentation_match?: Record<string, unknown> | null;
  };
  limits_reached: string[];
  /** Verification quality (separate from investigation_status). Absent on reports from older agents. */
  verification_required?: boolean;
  verification_outcome?: VerificationOutcome;
  unsupported_claims?: string[];
  incomplete_reasons?: string[];
  inspection_mode?: InspectionMode;
  visual_findings?: VisualFindingView[];
}

export type VerificationOutcome =
  | "VERIFIED"
  | "NOT_GROUNDED"
  | "INCOMPLETE"
  | "FAILED"
  | "NOT_RUN"
  | "NOT_REQUIRED";
export const VERIFICATION_LABEL: Record<VerificationOutcome, string> = {
  VERIFIED: "Verified",
  NOT_GROUNDED: "Not grounded — unsupported claims found",
  INCOMPLETE: "Verification incomplete",
  FAILED: "Verification failed",
  NOT_RUN: "Required verification did not run",
  NOT_REQUIRED: "Verification not required",
};

export interface VisualFindingView {
  image_id: string;
  observation: string;
  component: string;
  image_location: string;
  category: string;
  visual_evidence: string;
  certainty: "CERTAIN" | "UNCERTAIN";
  potential_concern: string | null;
  limitations: string;
  recommended_follow_up: string;
}

const arr = (v: unknown) => Array.isArray(v);

/** Structural check of the multi-agent /investigate response. Throws with a readable reason. */
export function validateInvestigationResponse(
  body: unknown,
  rackId: string,
  expectImage = false,
): { report: AgentReport; events: AgentEvent[] } {
  const b = body as { report?: Record<string, unknown>; events?: unknown };
  const r = b?.report;
  if (!r || typeof r !== "object")
    throw new Error("Agent response has no report");
  if (r.rack_id !== rackId)
    throw new Error(`Report is for ${String(r.rack_id)}, not ${rackId}`);
  if (!STATUSES.includes(r.investigation_status as string))
    throw new Error("Report has an invalid investigation_status");
  if (!SEVERITIES.includes(r.severity as string))
    throw new Error("Report has an invalid severity");
  if (typeof r.summary !== "string") throw new Error("Report has no summary");
  for (const k of [
    "hypotheses",
    "recommended_next_inspection",
    "tool_calls",
    "agents_invoked",
    "specialist_findings",
    "verified_findings",
    "missing_information",
    "limits_reached",
  ])
    if (!arr(r[k]))
      throw new Error(
        `Report field ${k} is missing (is the agent running in multi-agent mode?)`,
      );
  if (!r.evidence || typeof r.evidence !== "object")
    throw new Error("Report has no evidence");
  if (expectImage && !arr(r.visual_findings))
    throw new Error("Report has no visual_findings although an image was sent");
  if (
    !arr(b.events) ||
    !(b.events as AgentEvent[]).every(
      (e) => typeof e?.type === "string" && typeof e?.description === "string",
    )
  )
    throw new Error("Agent response has an invalid event timeline");
  return {
    report: r as unknown as AgentReport,
    events: b.events as AgentEvent[],
  };
}
