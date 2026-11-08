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

/** Units and accepted bounds per metric. Must equal spacetimedb/src/rules.ts METRICS (parity is tested). */
export const METRIC_RULES = {
  AMBIENT_TEMPERATURE_C: { unit: "°C", min: -50, max: 100 },
  RELATIVE_HUMIDITY_PERCENT: { unit: "%RH", min: 0, max: 100 },
  SOUND_RAW: { unit: "raw", min: 0, max: Number.MAX_SAFE_INTEGER },
  ULTRASONIC_DISTANCE_CM: { unit: "cm", min: 0, max: Number.MAX_SAFE_INTEGER },
} as const satisfies Record<MetricType, { unit: string; min: number; max: number }>;

export const RackId = z
  .string()
  .regex(
    /^[A-Za-z0-9._-]{1,64}$/,
    "rack_id must be 1-64 chars of letters, digits, '.', '_' or '-'",
  );

/** Database parity (spacetimedb/src/rules.ts): only SIMULATOR sources are authorized in this demonstration. */
export const SOURCE_TYPES = ["SIMULATOR"] as const;
/** Same tolerance the database applies to observation timestamps. */
export const FUTURE_TOLERANCE_MS = 30_000;
const EARLIEST_VALID_MS = Date.parse("2000-01-01T00:00:00Z");
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export const TelemetryReading = z
  .object({
    observation_id: z.string().min(1).max(128).optional(),
    metric_type: MetricType,
    numeric_value: z.number().finite(),
    unit: z.string().min(1).max(16),
    source_type: z.enum(SOURCE_TYPES),
    source_identifier: z
      .string()
      .max(100, "source_identifier must be at most 100 characters")
      .refine((v) => v.trim().length > 0, "source_identifier must not be blank")
      .refine((v) => !CONTROL_CHARS.test(v), "source_identifier contains control characters"),
    observed_at: z.iso.datetime({ offset: true }),
    ingested_at: z.iso.datetime({ offset: true }),
    simulated: z.boolean(),
  })
  .superRefine((r, ctx) => {
    // Exactly the database's sensor rules; invalid readings are rejected, never normalized.
    const rule = METRIC_RULES[r.metric_type];
    if (r.unit !== rule.unit)
      ctx.addIssue({ code: "custom", path: ["unit"], message: `${r.metric_type} must use unit "${rule.unit}", got "${r.unit}"` });
    if (r.numeric_value < rule.min || r.numeric_value > rule.max)
      ctx.addIssue({ code: "custom", path: ["numeric_value"], message: `${r.metric_type} value ${r.numeric_value} is outside the accepted range ${rule.min}..${rule.max}` });
    if (r.simulated !== (r.source_type === "SIMULATOR"))
      ctx.addIssue({ code: "custom", path: ["simulated"], message: "simulated must be true exactly when source_type is SIMULATOR" });
    const observed = Date.parse(r.observed_at);
    const ingested = Date.parse(r.ingested_at);
    if (observed < EARLIEST_VALID_MS || ingested < EARLIEST_VALID_MS)
      ctx.addIssue({ code: "custom", path: ["observed_at"], message: "timestamps before 2000-01-01 are not valid observations" });
    if (observed > ingested + FUTURE_TOLERANCE_MS)
      ctx.addIssue({ code: "custom", path: ["observed_at"], message: "observed_at is later than ingested_at (beyond the 30 s tolerance)" });
  });
export type TelemetryReading = z.infer<typeof TelemetryReading>;

/** Fictional demo thresholds — NOT manufacturer specifications. */
const temperatureC = z
  .number()
  .finite()
  .min(METRIC_RULES.AMBIENT_TEMPERATURE_C.min)
  .max(METRIC_RULES.AMBIENT_TEMPERATURE_C.max);
/** Present when the operator applied a manufacturer-documented range as this rack's thresholds. */
export const ThresholdSource = z.object({
  kind: z.literal("MANUFACTURER_DOCUMENTED_RANGE"),
  doc_id: z.string().min(1).max(80),
  manufacturer: z.string().min(1).max(80),
  model: z.string().min(1).max(120),
  source_url: z.string().url().max(500),
  mapping: z.string().min(1).max(600),
});
export type ThresholdSource = z.infer<typeof ThresholdSource>;
export const RackProfile = z
  .object({
    name: z.string().min(1).max(128),
    temperature_warning_c: temperatureC,
    temperature_critical_c: temperatureC,
    humidity_warning_percent: z.number().min(0).max(100).optional(),
    humidity_critical_percent: z.number().min(0).max(100).optional(),
    threshold_source: ThresholdSource.optional(),
  })
  // A documented range may have no separate warning tier (warning == critical); demo profiles always do.
  .refine((p) => (p.threshold_source ? p.temperature_warning_c <= p.temperature_critical_c : p.temperature_warning_c < p.temperature_critical_c), {
    message: "temperature_warning_c must be below temperature_critical_c",
  })
  .refine(
    (p) =>
      p.humidity_warning_percent === undefined ||
      p.humidity_critical_percent === undefined ||
      p.humidity_warning_percent < p.humidity_critical_percent,
    { message: "humidity_warning_percent must be below humidity_critical_percent" },
  );
export type RackProfile = z.infer<typeof RackProfile>;
export type ThresholdProvenance = "FICTIONAL_DEMO_CONFIGURATION" | "MANUFACTURER_DOCUMENTED_RANGE";
export const thresholdProvenance = (p: { threshold_source?: unknown }): ThresholdProvenance =>
  p.threshold_source ? "MANUFACTURER_DOCUMENTED_RANGE" : "FICTIONAL_DEMO_CONFIGURATION";

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
/** http(s) URL with a host, no credentials and no whitespace. Metadata only: never fetched. */
const SourceUrl = z
  .string()
  .max(500)
  .refine((v) => {
    if (/\s/.test(v) || !/^https?:\/\//i.test(v)) return false;
    try {
      const u = new URL(v);
      return (u.protocol === "http:" || u.protocol === "https:") && u.hostname.length > 0 && !u.username && !u.password;
    } catch {
      return false;
    }
  }, "source_url must be an http(s) URL with a host and no credentials");
const ProvenanceText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((v) => !CONTROL_CHARS.test(v), "must not contain control characters");

export const ImageInput = z.object({
  image_id: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,64}$/)
    .optional(),
  filename: z
    .string()
    .min(1)
    .max(200)
    .refine((v) => !CONTROL_CHARS.test(v) && !/[\\/]/.test(v) && v.trim() !== "" && !/^\.+$/.test(v), "filename must be a plain file name (no path or control characters)"),
  mime_type: z.enum(["image/jpeg", "image/png"]),
  data_base64: z
    .string()
    .min(1)
    .max(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8),
  source_type: z.enum(IMAGE_SOURCE_TYPES),
  /** Only when actually known (e.g. a camera clock). Never inferred. Not in the future (server clock + 30 s). */
  capture_timestamp: z.iso
    .datetime({ offset: true })
    .refine((v) => Date.parse(v) <= Date.now() + FUTURE_TOLERANCE_MS, "capture_timestamp cannot be in the future")
    .refine((v) => Date.parse(v) >= EARLIEST_VALID_MS, "capture_timestamp is before 2000-01-01")
    .nullish(),
  source_url: SourceUrl.nullish(),
  attribution: ProvenanceText(300).nullish(),
  license: ProvenanceText(100).nullish(),
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
}).superRefine((req, ctx) => {
  // Timestamps must be consistent with the investigation's reference time (database tolerance: 30 s).
  const asOf = req.as_of ? Date.parse(req.as_of) : Date.now();
  if (req.as_of && asOf > Date.now() + 24 * 3600_000)
    ctx.addIssue({ code: "custom", path: ["as_of"], message: "as_of is more than 24 h ahead of the server clock" });
  for (const key of ["current_telemetry", "recent_telemetry"] as const)
    req[key].forEach((r, i) => {
      for (const field of ["observed_at", "ingested_at"] as const)
        if (Date.parse(r[field]) > asOf + FUTURE_TOLERANCE_MS)
          ctx.addIssue({ code: "custom", path: [key, i, field], message: `${field} is later than as_of (beyond the 30 s tolerance)` });
    });
  // One observation id must always describe the same reading.
  const byId = new Map<string, string>();
  [...req.current_telemetry, ...req.recent_telemetry].forEach((r) => {
    if (!r.observation_id) return;
    const sig = JSON.stringify([r.metric_type, r.numeric_value, r.unit, r.source_type, r.source_identifier, r.observed_at, r.simulated]);
    const prev = byId.get(r.observation_id);
    if (prev !== undefined && prev !== sig)
      ctx.addIssue({ code: "custom", path: ["recent_telemetry"], message: `observation_id ${r.observation_id} is used for conflicting readings` });
    byId.set(r.observation_id, sig);
  });
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

const ParallelTask = z.object({
  agent: z.enum(["telemetry", "environment", "documentation"]),
  objective: z.string().min(1).transform((v) => v.slice(0, 600)),
});
const ROUTES = ["telemetry", "environment", "documentation", "vision", "verification", "finish"] as const;
const ROUTE_SYNONYMS: Record<string, string> = {
  verify: "verification", verifier: "verification", docs: "documentation", documents: "documentation",
  env: "environment", done: "finish", stop: "finish", complete: "finish", end: "finish", none: "finish",
};
const route = (v: unknown): string | null => {
  const t = String(v ?? "").trim().toLowerCase().replace(/[^a-z]/g, "");
  const r = ROUTE_SYNONYMS[t] ?? t;
  return (ROUTES as readonly string[]).includes(r) ? r : null;
};
/**
 * Normalise common model slips in the routing decision instead of rejecting it (seen live twice:
 * "next" naming several agents). Several agents become `next` + `also`; synonyms map to routes.
 * Anything still unrecognisable is left as is and fails validation as before.
 */
function normalizeDecision(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  let d = { ...(raw as Record<string, unknown>) };
  // Wrapped ({"decision": {...}}) or a differently named routing key (seen live: no "next" at all).
  if (d.next === undefined && d.decision && typeof d.decision === "object" && !Array.isArray(d.decision))
    d = { ...d, ...(d.decision as Record<string, unknown>) };
  if (d.next === undefined)
    for (const k of ["next_agent", "nextAgent", "agent", "action", "route", "delegate_to", "delegate", "next_step", "target"])
      if (d[k] !== undefined && typeof d[k] !== "object") {
        d.next = d[k];
        break;
      }
  const parts: unknown[] = Array.isArray(d.next) ? d.next : typeof d.next === "string" ? d.next.split(/\s*(?:,|\+|&|\/|\band\b)\s*/i) : [d.next];
  const valid = parts.map(route).filter((r): r is string => r !== null);
  if (!valid.length) return d;
  d.next = valid[0];
  const extra = valid.slice(1).filter((r) => r === "telemetry" || r === "environment" || r === "documentation");
  if (extra.length) {
    const also = Array.isArray(d.also) ? [...d.also] : [];
    for (const agent of extra) also.push({ agent, objective: String(d.objective ?? "") || `Investigate as part of: ${String(d.reason ?? "the plan")}` });
    d.also = also;
  }
  return d;
}
/** Supervisor routing decision (written by the Supervisor model). */
export const SupervisorDecision = z.preprocess(normalizeDecision, z.object({
  plan: z
    .string()
    .nullish()
    .transform((v) => (v ? v.slice(0, 1500) : undefined)),
  next: z.enum([...AgentName.options, "finish"]),
  objective: cappedOptText(600),
  reason: cappedOptText(600),
  /** Independent specialists to run IN PARALLEL with `next` (speed). Ignored unless `next` is a data specialist. */
  // Lenient by design: an entry naming another agent (seen live: "verification") is dropped instead of
  // invalidating the whole routing decision.
  also: z
    .array(z.unknown())
    .nullish()
    .transform((v) =>
      (v ?? [])
        .map((x) => ParallelTask.safeParse(x))
        .filter((r) => r.success)
        .map((r) => r.data!)
        .slice(0, 2),
    ),
}));
export type SupervisorDecision = z.infer<typeof SupervisorDecision>;

/** What a specialist model writes. */
export const SpecialistOutput = z.object({
  observations: capped(z.string(), 8),
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
  /** One plain-language sentence for the dashboard's main finding ("" when the model omits it). */
  headline: cappedOptText(240),
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

/** Verification quality, separate from processing completion (investigation_status). */
export const VERIFICATION_OUTCOMES = ["VERIFIED", "NOT_GROUNDED", "INCOMPLETE", "FAILED", "NOT_RUN", "NOT_REQUIRED"] as const;
export const VerificationOutcome = z.enum(VERIFICATION_OUTCOMES);
export type VerificationOutcome = z.infer<typeof VerificationOutcome>;

export const MultiAgentReport = DiagnosticReport.extend({
  /** Plain-language one-sentence main finding (AI-written; the summary holds the measured detail). */
  headline: z.string().default(""),
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
  /** Whether policy required independent verification (image supplied, non-normal severity or early-warning trend). */
  verification_required: z.boolean().default(false),
  verification_outcome: VerificationOutcome.default("NOT_RUN"),
  /** From the latest verification run; never upgraded by the synthesis. */
  unsupported_claims: z.array(z.string()).default([]),
  /** Why investigation_status is not COMPLETED (empty when COMPLETED). */
  incomplete_reasons: z.array(z.string()).default([]),
});
export type MultiAgentReport = z.infer<typeof MultiAgentReport>;
