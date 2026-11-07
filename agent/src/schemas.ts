import { z } from "zod";

/** Measurements a SENTINEL rover can actually take. Nothing else is accepted. */
export const METRIC_TYPES = [
  "AMBIENT_TEMPERATURE_C",
  "RELATIVE_HUMIDITY_PERCENT",
  "SOUND_RAW",
  "ULTRASONIC_DISTANCE_CM",
] as const;
export const MetricType = z.enum(METRIC_TYPES);
export type MetricType = z.infer<typeof MetricType>;

export const RackId = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,64}$/, "rack_id must be 1-64 chars of letters, digits, '.', '_' or '-'");

export const TelemetryReading = z.object({
  metric_type: MetricType,
  numeric_value: z.number().finite(),
  unit: z.string().min(1).max(16),
  source_type: z.string().min(1).max(32), // e.g. SIMULATOR, ROVER
  source_identifier: z.string().min(1).max(128),
  observed_at: z.iso.datetime({ offset: true }),
  ingested_at: z.iso.datetime({ offset: true }),
  simulated: z.boolean(),
});
export type TelemetryReading = z.infer<typeof TelemetryReading>;

/** Fictional demo thresholds — NOT manufacturer specifications. */
export const RackProfile = z
  .object({
    name: z.string().min(1).max(128),
    temperature_warning_c: z.number().finite(),
    temperature_critical_c: z.number().finite(),
    humidity_warning_percent: z.number().min(0).max(100).optional(),
    humidity_critical_percent: z.number().min(0).max(100).optional(),
  })
  .refine((p) => p.temperature_warning_c < p.temperature_critical_c, {
    message: "temperature_warning_c must be below temperature_critical_c",
  });
export type RackProfile = z.infer<typeof RackProfile>;

export const ActiveAlert = z.object({
  alert_id: z.string().max(128).optional(),
  severity: z.string().min(1).max(32),
  message: z.string().min(1).max(500),
  metric_type: MetricType.optional(),
  raised_at: z.iso.datetime({ offset: true }).optional(),
});

export const InvestigationRequest = z.object({
  rack_id: RackId,
  rack_name: z.string().min(1).max(128),
  equipment_type: z.string().min(1).max(64),
  profile: RackProfile,
  current_telemetry: z.array(TelemetryReading).max(100).default([]),
  recent_telemetry: z.array(TelemetryReading).max(1000).default([]),
  active_alerts: z.array(ActiveAlert).max(50).default([]),
  /** Reference time for staleness. Defaults to server time when omitted. */
  as_of: z.iso.datetime({ offset: true }).optional(),
  /** Freshness window for current readings. Defaults to STALE_AFTER_MINUTES. */
  stale_after_minutes: z.number().positive().max(1440).optional(),
});
export type InvestigationRequest = z.infer<typeof InvestigationRequest>;

// ---------- Report ----------

export const Severity = z.enum(["NORMAL", "WARNING", "CRITICAL", "UNKNOWN"]);
export const InvestigationStatus = z.enum(["COMPLETED", "INCOMPLETE", "FAILED"]);

export const Hypothesis = z.object({
  description: z.string().min(1),
  supporting_evidence: z.array(z.string()).default([]),
  contradicting_evidence: z.array(z.string()).default([]),
  missing_evidence: z.array(z.string()).default([]),
});

/** The part of the report Nemotron writes. */
export const ModelReport = z.object({
  severity: Severity,
  summary: z.string().min(1).max(1000),
  hypotheses: z.array(Hypothesis).max(6).default([]),
  recommended_next_inspection: z.array(z.string()).max(8).default([]),
});
export type ModelReport = z.infer<typeof ModelReport>;

export const ToolCallRecord = z.object({
  round: z.number().int(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  status: z.enum(["SUCCESS", "ERROR"]),
  result_summary: z.string(),
});
export type ToolCallRecord = z.infer<typeof ToolCallRecord>;

export const DiagnosticReport = ModelReport.extend({
  rack_id: z.string(),
  tool_calls: z.array(ToolCallRecord),
  investigation_status: InvestigationStatus,
  model: z.string(),
  generated_at: z.string(),
});
export type DiagnosticReport = z.infer<typeof DiagnosticReport>;

// ---------- Timeline ----------

export const EventType = z.enum(["START", "SUPERVISOR", "AGENT", "GUARD", "MODEL", "TOOL", "VERIFY", "REPORT", "ERROR", "END"]);
export const InvestigationEvent = z.object({
  type: EventType,
  timestamp: z.string(),
  agent: z.string().optional(),
  tool: z.string().optional(),
  description: z.string(),
  status: z.enum(["SUCCESS", "ERROR", "INFO"]),
});
export type InvestigationEvent = z.infer<typeof InvestigationEvent>;

// ---------- Multi-agent ----------

export const SPECIALISTS = ["telemetry", "environment", "documentation"] as const;
export const AgentName = z.enum([...SPECIALISTS, "verification"]);
export type AgentName = z.infer<typeof AgentName>;

/** Supervisor routing decision (written by the Supervisor model). */
export const SupervisorDecision = z.object({
  plan: z.string().max(1500).nullish().transform((v) => v ?? undefined),
  next: z.enum([...AgentName.options, "finish"]),
  objective: z.string().max(600).nullish().transform((v) => v ?? ""),
  reason: z.string().max(600).nullish().transform((v) => v ?? ""),
});
export type SupervisorDecision = z.infer<typeof SupervisorDecision>;

/** What a specialist model writes. */
export const SpecialistOutput = z.object({
  observations: z.array(z.string()).max(15).default([]),
  hypotheses: z.array(Hypothesis).max(5).default([]),
  missing_information: z.array(z.string()).max(10).default([]),
  recommended_next_action: z.string().max(600).default(""),
});

export const AgentToolCallRecord = ToolCallRecord.extend({ agent: z.string() });
export type AgentToolCallRecord = z.infer<typeof AgentToolCallRecord>;

export const AgentRunStatus = z.enum(["COMPLETED", "INCOMPLETE", "FAILED"]);

export const SpecialistFinding = SpecialistOutput.extend({
  agent: AgentName,
  objective: z.string(),
  tools_executed: z.array(AgentToolCallRecord),
  status: AgentRunStatus,
});
export type SpecialistFinding = z.infer<typeof SpecialistFinding>;

/** What the Verification model writes. */
export const VerificationOutput = z.object({
  grounded: z.boolean(),
  verified_findings: z.array(z.string()).max(10).default([]),
  unsupported_claims: z.array(z.string()).max(10).default([]),
  contradictions: z.array(z.string()).max(10).default([]),
  missing_evidence: z.array(z.string()).max(10).default([]),
  request_more_investigation: z.boolean().default(false),
  follow_up_agent: z.enum(SPECIALISTS).nullable().optional(),
  follow_up_objective: z.string().max(600).nullable().optional(),
});

export const VerificationResult = VerificationOutput.extend({
  tools_executed: z.array(AgentToolCallRecord),
  status: AgentRunStatus,
});
export type VerificationResult = z.infer<typeof VerificationResult>;

/** What the Supervisor writes in the final synthesis. */
export const FinalSynthesis = ModelReport.extend({
  verified_findings: z.array(z.string()).max(10).default([]),
  missing_information: z.array(z.string()).max(12).default([]),
});

/** Evidence compiled by code from actual tool results (not model-written). */
export const Evidence = z.object({
  measurements: z.array(z.record(z.string(), z.unknown())),
  history: z.array(z.record(z.string(), z.unknown())),
  configured_thresholds: z.record(z.string(), z.unknown()).nullable(),
  documentation: z.array(z.record(z.string(), z.unknown())),
});
export type Evidence = z.infer<typeof Evidence>;

export const MultiAgentReport = DiagnosticReport.extend({
  tool_calls: z.array(AgentToolCallRecord),
  supervisor_plan: z.string(),
  agents_invoked: z.array(z.object({ agent: AgentName, objective: z.string(), status: AgentRunStatus })),
  specialist_findings: z.array(SpecialistFinding),
  verification: VerificationResult.nullable(),
  verified_findings: z.array(z.string()),
  missing_information: z.array(z.string()),
  evidence: Evidence,
  limits_reached: z.array(z.string()),
});
export type MultiAgentReport = z.infer<typeof MultiAgentReport>;
