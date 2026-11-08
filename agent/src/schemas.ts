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
  .regex(
    /^[A-Za-z0-9._-]{1,64}$/,
    "rack_id must be 1-64 chars of letters, digits, '.', '_' or '-'",
  );

export const TelemetryReading = z.object({
  observation_id: z.string().min(1).max(128).optional(),
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

// ---------- Images (Feature 4) ----------

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // decoded bytes
export const MAX_IMAGE_DIMENSION = 4096; // px, either side
export const MAX_IMAGES = 1;
export const IMAGE_SOURCE_TYPES = [
  "MANUAL_UPLOAD",
  "ONLINE_REFERENCE",
  "ROVER_CAMERA",
] as const;

/** One image supplied with an investigation. Bytes travel as base64; URLs are metadata only and are never fetched. */
export const ImageInput = z.object({
  image_id: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,64}$/)
    .optional(),
  filename: z.string().min(1).max(200),
  mime_type: z.enum(["image/jpeg", "image/png"]),
  data_base64: z
    .string()
    .min(1)
    .max(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8),
  source_type: z.enum(IMAGE_SOURCE_TYPES),
  /** Only when actually known (e.g. a camera clock). Never inferred. */
  capture_timestamp: z.iso.datetime({ offset: true }).nullish(),
  source_url: z
    .string()
    .max(500)
    .regex(/^https?:\/\//, "source_url must be http(s)")
    .nullish(),
  attribution: z.string().max(300).nullish(),
  license: z.string().max(100).nullish(),
});
export type ImageInput = z.infer<typeof ImageInput>;

/** Provenance recorded by the server for each accepted image (no pixel data). */
export const ImageProvenance = z.object({
  image_id: z.string(),
  filename: z.string(),
  mime_type: z.string(),
  source_type: z.enum(IMAGE_SOURCE_TYPES),
  capture_timestamp: z.string().nullable(),
  uploaded_at: z.string(),
  source_url: z.string().nullable(),
  attribution: z.string().nullable(),
  license: z.string().nullable(),
  sha256: z.string(),
  byte_size: z.number().int(),
  width: z.number().int(),
  height: z.number().int(),
});
export type ImageProvenance = z.infer<typeof ImageProvenance>;

/** Explicit operator assertion for this rack, never inferred from a profile or photograph. */
export const EquipmentIdentity = z.object({
  manufacturer: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(120),
  provenance: z.literal("OPERATOR_PROVIDED"),
  assertion: z.string().trim().min(1).max(300),
});
export type EquipmentIdentity = z.infer<typeof EquipmentIdentity>;

export const InvestigationRequest = z.object({
  equipment_identity: EquipmentIdentity.optional(),
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
  /** Optional photographs for the Vision Agent (Feature 4). */
  images: z.array(ImageInput).max(MAX_IMAGES).default([]),
  /** What the operator asked for. Informs the Supervisor; does not force any agent. */
  inspection_mode: z.enum(["TELEMETRY", "VISUAL", "COMBINED"]).optional(),
});
export type InvestigationRequest = z.infer<typeof InvestigationRequest>;

// ---------- Report ----------

export const Severity = z.enum(["NORMAL", "WARNING", "CRITICAL", "UNKNOWN"]);
export const InvestigationStatus = z.enum([
  "COMPLETED",
  "INCOMPLETE",
  "FAILED",
]);

export const Hypothesis = z.object({
  description: z.string().min(1),
  supporting_evidence: z.array(z.string()).default([]),
  contradicting_evidence: z.array(z.string()).default([]),
  missing_evidence: z.array(z.string()).default([]),
});

/** Model-written lists/text are bounded by trimming, not rejection: an over-long but otherwise
 *  valid answer should not cost a repair call or fail an investigation. */
const capped = <T extends z.ZodTypeAny>(item: T, n: number) =>
  z
    .array(item)
    .default([])
    .transform((a) => a.slice(0, n));
const cappedText = (n: number) =>
  z.string().transform((v) => (v.length > n ? `${v.slice(0, n)}…` : v));
const cappedOptText = (n: number) =>
  z
    .string()
    .nullish()
    .transform((v) =>
      (v ?? "").length > n ? `${v!.slice(0, n)}…` : (v ?? ""),
    );

/** The part of the report Nemotron writes. */
export const ModelReport = z.object({
  severity: Severity,
  summary: z.string().min(1).pipe(cappedText(2500)),
  hypotheses: capped(Hypothesis, 8),
  recommended_next_inspection: capped(z.string(), 10),
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

export const EventType = z.enum([
  "START",
  "SUPERVISOR",
  "AGENT",
  "GUARD",
  "MODEL",
  "TOOL",
  "VERIFY",
  "REPORT",
  "ERROR",
  "END",
]);
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

export const SPECIALISTS = [
  "telemetry",
  "environment",
  "documentation",
  "vision",
] as const;
export const AgentName = z.enum([...SPECIALISTS, "verification"]);
export type AgentName = z.infer<typeof AgentName>;

/** Supervisor routing decision (written by the Supervisor model). */
export const SupervisorDecision = z.object({
  plan: z
    .string()
    .nullish()
    .transform((v) => (v ? v.slice(0, 1500) : undefined)),
  next: z.enum([...AgentName.options, "finish"]),
  objective: cappedOptText(600),
  reason: cappedOptText(600),
});
export type SupervisorDecision = z.infer<typeof SupervisorDecision>;

/** What a specialist model writes. */
export const SpecialistOutput = z.object({
  observations: capped(z.string(), 20),
  hypotheses: capped(Hypothesis, 6),
  missing_information: capped(z.string(), 30),
  recommended_next_action: cappedOptText(600),
});

export const VISUAL_CATEGORIES = [
  "EQUIPMENT",
  "PORT",
  "CABLE",
  "LABEL",
  "LED",
  "PHYSICAL_IRREGULARITY",
  "OBSTRUCTION",
  "OTHER",
] as const;
const optText = cappedOptText(600);

/** One observation the Vision Agent made in an image. */
export const VisualFinding = z.object({
  observation: z.string().min(1).pipe(cappedText(600)),
  component: optText,
  image_location: optText,
  category: z.enum(VISUAL_CATEGORIES).catch("OTHER"),
  visual_evidence: optText,
  certainty: z.enum(["CERTAIN", "UNCERTAIN"]).catch("UNCERTAIN"),
  potential_concern: z
    .string()
    .nullish()
    .transform((v) => (v ? v.slice(0, 600) : null)),
  limitations: optText,
  recommended_follow_up: optText,
});
export type VisualFinding = z.infer<typeof VisualFinding>;

/** What the Vision model writes. */
export const VisionOutput = z.object({
  visual_findings: z
    .array(VisualFinding)
    .min(1)
    .transform((a) => a.slice(0, 20)),
  unreadable_regions: capped(z.string(), 10),
  additional_photos_needed: capped(z.string(), 10),
  hypotheses: capped(Hypothesis, 6),
  missing_information: capped(z.string(), 15),
  recommended_next_action: cappedOptText(600),
});

export const AgentToolCallRecord = ToolCallRecord.extend({ agent: z.string() });
export type AgentToolCallRecord = z.infer<typeof AgentToolCallRecord>;

export const AgentRunStatus = z.enum(["COMPLETED", "INCOMPLETE", "FAILED"]);

export const SpecialistFinding = SpecialistOutput.extend({
  agent: AgentName,
  objective: z.string(),
  tools_executed: z.array(AgentToolCallRecord),
  status: AgentRunStatus,
  // Vision Agent only:
  image_id: z.string().optional(),
  visual_findings: z.array(VisualFinding).optional(),
  unreadable_regions: z.array(z.string()).optional(),
  additional_photos_needed: z.array(z.string()).optional(),
});
export type SpecialistFinding = z.infer<typeof SpecialistFinding>;

/** What the Verification model writes. */
export const VerificationOutput = z.object({
  grounded: z.boolean(),
  verified_findings: capped(z.string(), 20),
  unsupported_claims: capped(z.string(), 20),
  contradictions: capped(z.string(), 20),
  missing_evidence: capped(z.string(), 20),
  request_more_investigation: z.boolean().default(false),
  follow_up_agent: z.enum(SPECIALISTS).nullable().optional(),
  follow_up_objective: z
    .string()
    .nullish()
    .transform((v) => (v ? v.slice(0, 600) : v)),
});

export const VerificationResult = VerificationOutput.extend({
  tools_executed: z.array(AgentToolCallRecord),
  status: AgentRunStatus,
});
export type VerificationResult = z.infer<typeof VerificationResult>;

/** What the Supervisor writes in the final synthesis. */
export const FinalSynthesis = ModelReport.extend({
  verified_findings: capped(z.string(), 20),
  missing_information: capped(z.string(), 30),
});

/** Evidence compiled by code from actual tool results (not model-written). */
export const Evidence = z.object({
  measurements: z.array(z.record(z.string(), z.unknown())),
  history: z.array(z.record(z.string(), z.unknown())),
  configured_thresholds: z.record(z.string(), z.unknown()).nullable(),
  documentation: z.array(z.record(z.string(), z.unknown())),
  images: z.array(ImageProvenance).default([]),
  trends: z.array(z.record(z.string(), z.unknown())).default([]),
  early_warning_indicators: z
    .array(z.record(z.string(), z.unknown()))
    .default([]),
  equipment_identity: EquipmentIdentity.nullable().default(null),
  documentation_match: z
    .record(z.string(), z.unknown())
    .nullable()
    .default(null),
});
export type Evidence = z.infer<typeof Evidence>;

export const MultiAgentReport = DiagnosticReport.extend({
  tool_calls: z.array(AgentToolCallRecord),
  supervisor_plan: z.string(),
  agents_invoked: z.array(
    z.object({
      agent: AgentName,
      objective: z.string(),
      status: AgentRunStatus,
    }),
  ),
  specialist_findings: z.array(SpecialistFinding),
  verification: VerificationResult.nullable(),
  verified_findings: z.array(z.string()),
  missing_information: z.array(z.string()),
  evidence: Evidence,
  limits_reached: z.array(z.string()),
  inspection_mode: z.enum(["TELEMETRY", "VISUAL", "COMBINED"]),
  visual_findings: z
    .array(VisualFinding.extend({ image_id: z.string() }))
    .default([]),
});
export type MultiAgentReport = z.infer<typeof MultiAgentReport>;
