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
  alerts: readonly { alertId: string; rackId: string; metricType: string; severity: string; message: string; active: boolean; createdAt: Ts }[];
  asOf: Date;
  staleAfterSeconds: number;
}

export const toIso = (t: Ts) => new Date(Number(t.microsSinceUnixEpoch / 1000n)).toISOString();

const supported = (m: string) => (SUPPORTED_METRICS as readonly string[]).includes(m);

function reading(r: ObservationRow) {
  return {
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

/** Build the agent's InvestigationRequest from one rack's subscribed rows. Missing readings stay missing. */
export function buildInvestigationRequest(s: SnapshotInput) {
  const mine = <T extends { rackId: string }>(rows: readonly T[]) => rows.filter((r) => r.rackId === s.rack.rackId);
  return {
    rack_id: s.rack.rackId,
    rack_name: s.rack.displayName,
    equipment_type: s.profile.equipmentType,
    profile: {
      name: s.profile.name,
      temperature_warning_c: s.profile.temperatureWarningC,
      temperature_critical_c: s.profile.temperatureCriticalC,
      humidity_warning_percent: s.profile.humidityWarningPercent,
    },
    current_telemetry: mine(s.current).filter((r) => supported(r.metricType)).map(reading),
    recent_telemetry: mine(s.recent)
      .filter((r) => supported(r.metricType))
      .sort((a, b) => (a.observedAt.microsSinceUnixEpoch < b.observedAt.microsSinceUnixEpoch ? -1 : 1))
      .map(reading),
    active_alerts: mine(s.alerts)
      .filter((a) => a.active)
      .map((a) => ({
        alert_id: a.alertId,
        severity: a.severity,
        message: a.message,
        ...(supported(a.metricType) ? { metric_type: a.metricType } : {}),
        raised_at: toIso(a.createdAt),
      })),
    as_of: s.asOf.toISOString(),
    stale_after_minutes: s.staleAfterSeconds / 60,
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
  hypotheses: { description: string; supporting_evidence: string[]; contradicting_evidence: string[]; missing_evidence: string[] }[];
  recommended_next_inspection: string[];
  tool_calls: { agent?: string; round: number; tool: string; args: Record<string, unknown>; status: string; result_summary: string }[];
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
  };
  limits_reached: string[];
}

const arr = (v: unknown) => Array.isArray(v);

/** Structural check of the multi-agent /investigate response. Throws with a readable reason. */
export function validateInvestigationResponse(body: unknown, rackId: string): { report: AgentReport; events: AgentEvent[] } {
  const b = body as { report?: Record<string, unknown>; events?: unknown };
  const r = b?.report;
  if (!r || typeof r !== "object") throw new Error("Agent response has no report");
  if (r.rack_id !== rackId) throw new Error(`Report is for ${String(r.rack_id)}, not ${rackId}`);
  if (!STATUSES.includes(r.investigation_status as string)) throw new Error("Report has an invalid investigation_status");
  if (!SEVERITIES.includes(r.severity as string)) throw new Error("Report has an invalid severity");
  if (typeof r.summary !== "string") throw new Error("Report has no summary");
  for (const k of ["hypotheses", "recommended_next_inspection", "tool_calls", "agents_invoked", "specialist_findings", "verified_findings", "missing_information", "limits_reached"])
    if (!arr(r[k])) throw new Error(`Report field ${k} is missing (is the agent running in multi-agent mode?)`);
  if (!r.evidence || typeof r.evidence !== "object") throw new Error("Report has no evidence");
  if (!arr(b.events) || !(b.events as AgentEvent[]).every((e) => typeof e?.type === "string" && typeof e?.description === "string"))
    throw new Error("Agent response has an invalid event timeline");
  return { report: r as unknown as AgentReport, events: b.events as AgentEvent[] };
}
