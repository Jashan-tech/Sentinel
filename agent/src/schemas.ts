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

export const EventType = z.enum(["START", "MODEL", "TOOL", "REPORT", "ERROR", "END"]);
export const InvestigationEvent = z.object({
  type: EventType,
  timestamp: z.string(),
  tool: z.string().optional(),
  description: z.string(),
  status: z.enum(["SUCCESS", "ERROR", "INFO"]),
});
export type InvestigationEvent = z.infer<typeof InvestigationEvent>;
