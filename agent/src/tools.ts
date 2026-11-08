import { tool } from "@langchain/core/tools";
import {
  analyzeTrends,
  earlyWarnings,
  type MetricTrend,
  type EarlyWarningIndicator,
} from "./trends.js";
import { DOC_TOPICS, lookupDocumentation } from "./documentation.js";
export { DOC_TOPICS, lookupDocumentation } from "./documentation.js";
import { z } from "zod";
import {
  METRIC_TYPES,
  MetricType,
  RackId,
  type InvestigationRequest,
  type TelemetryReading,
} from "./schemas.js";

export const MAX_HISTORY_LIMIT = 50;
export const DEFAULT_HISTORY_LIMIT = 10;
export const MAX_TOOL_RESULT_CHARS = 8000;
// Collision avoidance has its own UI/controller boundary, outside equipment reasoning.
const EquipmentMetric = MetricType.exclude(["ULTRASONIC_DISTANCE_CM"]);
const equipmentMetric = (metric: string) => metric !== "ULTRASONIC_DISTANCE_CM";

/**
 * Read-only data access for one investigation. Implemented over the request snapshot
 * today; swap these three functions for SpacetimeDB queries later.
 */
export interface RackDataSource {
  getCurrentTelemetry(rackId: string, metricType?: MetricType): unknown;
  getTelemetryHistory(
    rackId: string,
    metricType: MetricType,
    limit?: number,
  ): unknown;
  getRackProfile(rackId: string): unknown;
  /** sourceIdentifier filters the input BEFORE the per-metric source-series cap. */
  getTelemetryTrends(rackId: string, metricType?: MetricType, sourceIdentifier?: string): MetricTrend[];
  getEarlyWarnings(
    rackId: string,
    metricType?: MetricType,
    sourceIdentifier?: string,
  ): EarlyWarningIndicator[];
  lookupDocumentation(
    equipmentType: string,
    topic?: (typeof DOC_TOPICS)[number],
  ): ReturnType<typeof lookupDocumentation>;
}

export class UnknownRackError extends Error {}

function annotate(r: TelemetryReading, asOf: Date, staleAfterMin: number) {
  const ageMin = (asOf.getTime() - new Date(r.observed_at).getTime()) / 60000;
  return {
    ...r,
    age_minutes: Math.round(ageMin * 10) / 10,
    stale: ageMin > staleAfterMin,
  };
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** History result whose statistics are computed from exactly the returned observations. */
function historyResult<O extends TelemetryReading & { age_minutes: number }>(
  rackId: string,
  metricType: MetricType,
  obs: O[],
  totalAvailable: number,
  requested: number,
) {
  const values = obs.map((o) => o.numeric_value);
  return {
    rack_id: rackId,
    metric_type: metricType,
    available: true,
    order: "oldest_to_newest",
    returned: obs.length,
    total_available: totalAvailable,
    truncated_oldest: requested - obs.length,
    window: { from: obs[0].observed_at, to: obs[obs.length - 1].observed_at },
    source_identifiers: [...new Set(obs.map((o) => o.source_identifier))],
    stats: {
      count: values.length,
      first: values[0],
      last: values[values.length - 1],
      min: Math.min(...values),
      max: Math.max(...values),
      average: round2(values.reduce((a, b) => a + b, 0) / values.length),
      change_first_to_last: round2(values[values.length - 1] - values[0]),
    },
    note: "Statistics describe exactly the returned observations (oldest to newest). Mixed sources are not a single series; use analyze_telemetry_trends for per-source trends.",
    observations: obs,
  };
}

export function createSnapshotDataSource(
  snapshot: InvestigationRequest,
  opts: { staleAfterMinutes: number },
): RackDataSource {
  // Deep copy so the investigation can never mutate (or be affected by) the caller's object.
  const snap: InvestigationRequest = structuredClone(snapshot);
  snap.current_telemetry = snap.current_telemetry.filter(r => equipmentMetric(r.metric_type));
  snap.recent_telemetry = snap.recent_telemetry.filter(r => equipmentMetric(r.metric_type));
  snap.active_alerts = snap.active_alerts.filter(a => !a.metric_type || equipmentMetric(a.metric_type));
  const asOf = new Date(snap.as_of ?? Date.now());
  snap.as_of = asOf.toISOString();
  const trends = analyzeTrends(snap, opts.staleAfterMinutes).filter(t => equipmentMetric(t.metric_type));
  const indicators = earlyWarnings(snap, trends, opts.staleAfterMinutes).filter(i => equipmentMetric(i.metric));
  // Per-source analysis on a source-filtered snapshot, so the 8-series cap never hides a requested source.
  const bySource = new Map<string, { trends: MetricTrend[]; indicators: EarlyWarningIndicator[] }>();
  const forSource = (sourceIdentifier: string) => {
    let hit = bySource.get(sourceIdentifier);
    if (!hit) {
      const only = (rs: TelemetryReading[]) => rs.filter((r) => r.source_identifier === sourceIdentifier);
      const sub: InvestigationRequest = { ...snap, current_telemetry: only(snap.current_telemetry), recent_telemetry: only(snap.recent_telemetry) };
      const t = analyzeTrends(sub, opts.staleAfterMinutes).filter(t => equipmentMetric(t.metric_type));
      hit = { trends: t, indicators: earlyWarnings(sub, t, opts.staleAfterMinutes).filter(i => equipmentMetric(i.metric)).filter(i => equipmentMetric(i.metric)) };
      bySource.set(sourceIdentifier, hit);
    }
    return hit;
  };
  const stale = opts.staleAfterMinutes;

  const checkRack = (rackId: string) => {
    if (rackId !== snap.rack_id) {
      throw new UnknownRackError(
        `Unknown rack_id "${rackId}". This investigation only has data for "${snap.rack_id}".`,
      );
    }
  };

  return {
    getTelemetryTrends(rackId, metricType, sourceIdentifier) {
      checkRack(rackId);
      const src = sourceIdentifier ? forSource(sourceIdentifier).trends : trends;
      return structuredClone(
        src.filter((t) => !metricType || t.metric_type === metricType),
      );
    },
    getEarlyWarnings(rackId, metricType, sourceIdentifier) {
      checkRack(rackId);
      const src = sourceIdentifier ? forSource(sourceIdentifier).indicators : indicators;
      return structuredClone(
        src.filter((i) => !metricType || i.metric === metricType),
      );
    },
    lookupDocumentation(equipmentType, topic) {
      if (equipmentType.toLowerCase() !== snap.equipment_type.toLowerCase())
        throw new Error(
          "Equipment type must match this investigation snapshot",
        );
      return lookupDocumentation(equipmentType, topic, snap.equipment_identity);
    },
    getCurrentTelemetry(rackId, metricType) {
      checkRack(rackId);
      const readings = snap.current_telemetry
        .filter((r) => !metricType || r.metric_type === metricType)
        .map((r) => annotate(r, asOf, stale));
      const requested = metricType ? [metricType] : METRIC_TYPES.filter(equipmentMetric);
      const present = new Set(readings.map((r) => r.metric_type));
      return {
        rack_id: rackId,
        as_of: asOf.toISOString(),
        stale_after_minutes: stale,
        readings,
        missing_metrics: requested.filter((m) => !present.has(m)),
        note: "Missing metrics have no current reading. Stale readings must not be treated as current evidence. SOUND_RAW is uncalibrated raw intensity, not decibels.",
      };
    },

    getTelemetryHistory(rackId, metricType, limit = DEFAULT_HISTORY_LIMIT) {
      checkRack(rackId);
      const n = Math.min(Math.max(1, Math.floor(limit)), MAX_HISTORY_LIMIT);
      // Deterministic chronological order: observed time, then ingestion time, then id.
      const all = snap.recent_telemetry
        .filter((r) => r.metric_type === metricType)
        .sort(
          (a, b) =>
            Date.parse(a.observed_at) - Date.parse(b.observed_at) ||
            Date.parse(a.ingested_at) - Date.parse(b.ingested_at) ||
            (a.observation_id ?? "").localeCompare(b.observation_id ?? ""),
        );
      if (all.length === 0) {
        return {
          rack_id: rackId,
          metric_type: metricType,
          available: false,
          observations: [],
          note: `No historical observations of ${metricType} are available for this rack.`,
        };
      }
      // History is old by definition: report age, but not a "stale" flag (that applies to current readings).
      const requested = all.slice(-n).map((r) => {
        const { stale: _ignored, ...rest } = annotate(r, asOf, stale);
        return rest;
      });
      // Bound the size FIRST (dropping oldest), THEN compute statistics, so every number
      // describes exactly the observations that are returned.
      let obs = requested;
      let result = historyResult(rackId, metricType, obs, all.length, requested.length);
      while (JSON.stringify(result).length > MAX_TOOL_RESULT_CHARS && obs.length > 1) {
        obs = obs.slice(1);
        result = historyResult(rackId, metricType, obs, all.length, requested.length);
      }
      return result;
    },

    getRackProfile(rackId) {
      checkRack(rackId);
      return {
        rack_id: snap.rack_id,
        rack_name: snap.rack_name,
        equipment_type: snap.equipment_type,
        equipment_identity: snap.equipment_identity ?? null,
        profile: snap.profile,
        note: "Thresholds are fictional demonstration settings, not manufacturer specifications.",
      };
    },
  };
}

/** Serialize a tool result within MAX_TOOL_RESULT_CHARS. Results are never truncated here
 *  (that would desynchronize statistics from evidence); oversize results become an error. */
function serialize(result: unknown): string {
  const out = JSON.stringify(result);
  if (out.length > MAX_TOOL_RESULT_CHARS) {
    return JSON.stringify({
      error: "Tool result too large; request fewer observations.",
    });
  }
  return out;
}

/** Errors are returned to the model as data (so it can adapt) rather than crashing the graph. */
function run(fn: () => unknown): string {
  try {
    return serialize(fn());
  } catch (err) {
    return JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function createTools(ds: RackDataSource) {
  return [
    tool(
      ({ rack_id, metric_type }) =>
        run(() => ds.getCurrentTelemetry(rack_id, metric_type)),
      {
        name: "get_current_telemetry",
        description:
          "Get the latest readings for a rack (optionally one metric), with units, timestamps, provenance, staleness, and a list of metrics with no current reading.",
        schema: z.object({
          rack_id: RackId,
          metric_type: EquipmentMetric.optional().describe(
            "Omit to get all available metrics",
          ),
        }),
      },
    ),
    tool(
      ({ rack_id, metric_type, limit }) =>
        run(() => ds.getTelemetryHistory(rack_id, metric_type, limit)),
      {
        name: "get_telemetry_history",
        description:
          "Get recent historical observations (oldest to newest) of one metric for a rack, with simple stats for trend analysis.",
        schema: z.object({
          rack_id: RackId,
          metric_type: EquipmentMetric,
          limit: z
            .number()
            .int()
            .min(1)
            .max(MAX_HISTORY_LIMIT)
            .optional()
            .describe(`Max observations (default ${DEFAULT_HISTORY_LIMIT})`),
        }),
      },
    ),
    tool(({ rack_id }) => run(() => ds.getRackProfile(rack_id)), {
      name: "get_rack_profile",
      description:
        "Get the rack's equipment type and configured (fictional demo) warning/critical thresholds.",
      schema: z.object({ rack_id: RackId }),
    }),
    tool(
      ({ rack_id, metric_type, source_identifier }) =>
        run(() => ({
          trends: ds.getTelemetryTrends(rack_id, metric_type, source_identifier),
          source_identifier_filter: source_identifier ?? null,
        })),
      {
        name: "analyze_telemetry_trends",
        description:
          "Deterministic per-source trend statistics, timestamps, data quality and fictional-profile threshold breaches for one metric. Never calculate numerical trends yourself.",
        schema: z.object({
          rack_id: RackId,
          metric_type: EquipmentMetric,
          source_identifier: z
            .string()
            .max(128)
            .optional()
            .describe("Narrow to a sensor if the result is too large"),
        }),
      },
    ),
    tool(
      ({ rack_id, metric_type, source_identifier }) =>
        run(() => ({
          indicators: ds
            .getEarlyWarnings(rack_id, metric_type, source_identifier)
            .filter(
              (i) =>
                !source_identifier ||
                i.observed_evidence.source_identifier == null ||
                i.observed_evidence.source_identifier === source_identifier,
            ),
          source_identifier_filter: source_identifier ?? null,
        })),
      {
        name: "get_early_warning_indicators",
        description:
          "Deterministic current conditions, early warnings and missing/stale evidence for one metric. Monitoring indicators, never confirmed faults or failure forecasts.",
        schema: z.object({
          rack_id: RackId,
          metric_type: EquipmentMetric,
          source_identifier: z
            .string()
            .max(128)
            .optional()
            .describe("Narrow to a sensor if the result is too large"),
        }),
      },
    ),
  ];
}

export type Severity = "NORMAL" | "WARNING" | "CRITICAL" | "UNKNOWN";

/**
 * Deterministic severity policy: profile thresholds applied to fresh readings only.
 * CRITICAL/WARNING if any fresh reading crosses a configured threshold; NORMAL only when a fresh
 * ambient temperature exists and nothing crosses; otherwise UNKNOWN.
 */
export function thresholdSeverity(
  snapshot: InvestigationRequest,
  staleAfterMinutes: number,
): Severity {
  const asOf = new Date(snapshot.as_of ?? Date.now());
  const p = snapshot.profile;
  const fresh = snapshot.current_telemetry.filter(
    (r) => !annotate(r, asOf, staleAfterMinutes).stale,
  );
  let level = 0; // 0 normal, 1 warning, 2 critical
  for (const r of fresh) {
    const v = r.numeric_value;
    if (r.metric_type === "AMBIENT_TEMPERATURE_C") {
      level = Math.max(
        level,
        v >= p.temperature_critical_c
          ? 2
          : v >= p.temperature_warning_c
            ? 1
            : 0,
      );
    } else if (r.metric_type === "RELATIVE_HUMIDITY_PERCENT") {
      if (
        p.humidity_critical_percent !== undefined &&
        v >= p.humidity_critical_percent
      )
        level = 2;
      else if (
        p.humidity_warning_percent !== undefined &&
        v >= p.humidity_warning_percent
      )
        level = Math.max(level, 1);
    }
  }
  if (level === 2) return "CRITICAL";
  if (level === 1) return "WARNING";
  return fresh.some((r) => r.metric_type === "AMBIENT_TEMPERATURE_C")
    ? "NORMAL"
    : "UNKNOWN";
}

// Documentation identity is bound to the snapshot; the model cannot supply or change it.
export function createDocumentationTool(ds?: RackDataSource) {
  return tool(
    ({ equipment_type, topic }) =>
      run(() =>
        ds
          ? ds.lookupDocumentation(equipment_type, topic)
          : lookupDocumentation(equipment_type, topic),
      ),
    {
      name: "lookup_equipment_documentation",
      description:
        "Retrieve only verified, exactly matched manufacturer/model records plus general project notes. Identity comes from explicit operator metadata, never the tool caller or image. NO_MATCH means no applicable manufacturer guidance. Cite doc_id, section and source_url.",
      schema: z.object({
        equipment_type: z.string().min(1).max(64),
        topic: z.enum(DOC_TOPICS).optional(),
      }),
    },
  );
}
