import { tool } from "@langchain/core/tools";
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

/**
 * Read-only data access for one investigation. Implemented over the request snapshot
 * today; swap these three functions for SpacetimeDB queries later.
 */
export interface RackDataSource {
  getCurrentTelemetry(rackId: string, metricType?: MetricType): unknown;
  getTelemetryHistory(rackId: string, metricType: MetricType, limit?: number): unknown;
  getRackProfile(rackId: string): unknown;
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

export function createSnapshotDataSource(
  snapshot: InvestigationRequest,
  opts: { staleAfterMinutes: number },
): RackDataSource {
  // Deep copy so the investigation can never mutate (or be affected by) the caller's object.
  const snap: InvestigationRequest = structuredClone(snapshot);
  const asOf = new Date(snap.as_of ?? Date.now());
  const stale = opts.staleAfterMinutes;

  const checkRack = (rackId: string) => {
    if (rackId !== snap.rack_id) {
      throw new UnknownRackError(
        `Unknown rack_id "${rackId}". This investigation only has data for "${snap.rack_id}".`,
      );
    }
  };

  return {
    getCurrentTelemetry(rackId, metricType) {
      checkRack(rackId);
      const readings = snap.current_telemetry
        .filter((r) => !metricType || r.metric_type === metricType)
        .map((r) => annotate(r, asOf, stale));
      const requested = metricType ? [metricType] : [...METRIC_TYPES];
      const present = new Set(readings.map((r) => r.metric_type));
      return {
        rack_id: rackId,
        as_of: asOf.toISOString(),
        stale_after_minutes: stale,
        readings,
        missing_metrics: requested.filter((m) => !present.has(m)),
        note:
          "Missing metrics have no current reading. Stale readings must not be treated as current evidence. SOUND_RAW is uncalibrated raw intensity, not decibels.",
      };
    },

    getTelemetryHistory(rackId, metricType, limit = DEFAULT_HISTORY_LIMIT) {
      checkRack(rackId);
      const n = Math.min(Math.max(1, Math.floor(limit)), MAX_HISTORY_LIMIT);
      const all = snap.recent_telemetry
        .filter((r) => r.metric_type === metricType)
        .sort((a, b) => a.observed_at.localeCompare(b.observed_at));
      if (all.length === 0) {
        return {
          rack_id: rackId,
          metric_type: metricType,
          available: false,
          observations: [],
          note: `No historical observations of ${metricType} are available for this rack.`,
        };
      }
      const obs = all.slice(-n).map((r) => annotate(r, asOf, stale));
      const values = obs.map((o) => o.numeric_value);
      return {
        rack_id: rackId,
        metric_type: metricType,
        available: true,
        order: "oldest_to_newest",
        returned: obs.length,
        total_available: all.length,
        stats: {
          first: values[0],
          last: values[values.length - 1],
          min: Math.min(...values),
          max: Math.max(...values),
          change_first_to_last: Math.round((values[values.length - 1] - values[0]) * 100) / 100,
        },
        observations: obs,
      };
    },

    getRackProfile(rackId) {
      checkRack(rackId);
      return {
        rack_id: snap.rack_id,
        rack_name: snap.rack_name,
        equipment_type: snap.equipment_type,
        profile: snap.profile,
        note: "Thresholds are fictional demonstration settings, not manufacturer specifications.",
      };
    },
  };
}

/**
 * Serialize a tool result within MAX_TOOL_RESULT_CHARS while keeping valid JSON:
 * oldest history observations are dropped first; anything else is replaced by an error.
 */
function serialize(result: unknown): string {
  let out = JSON.stringify(result);
  const r = result as { observations?: unknown[]; returned?: number; truncated_oldest?: number };
  let dropped = 0;
  while (out.length > MAX_TOOL_RESULT_CHARS && Array.isArray(r?.observations) && r.observations.length > 1) {
    r.observations.shift();
    dropped++;
    r.returned = r.observations.length;
    r.truncated_oldest = dropped;
    out = JSON.stringify(r);
  }
  if (out.length > MAX_TOOL_RESULT_CHARS) {
    return JSON.stringify({ error: "Tool result too large; request fewer observations." });
  }
  return out;
}

/** Errors are returned to the model as data (so it can adapt) rather than crashing the graph. */
function run(fn: () => unknown): string {
  try {
    return serialize(fn());
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
}

export function createTools(ds: RackDataSource) {
  return [
    tool(({ rack_id, metric_type }) => run(() => ds.getCurrentTelemetry(rack_id, metric_type)), {
      name: "get_current_telemetry",
      description:
        "Get the latest readings for a rack (optionally one metric), with units, timestamps, provenance, staleness, and a list of metrics with no current reading.",
      schema: z.object({
        rack_id: RackId,
        metric_type: MetricType.optional().describe("Omit to get all available metrics"),
      }),
    }),
    tool(
      ({ rack_id, metric_type, limit }) =>
        run(() => ds.getTelemetryHistory(rack_id, metric_type, limit)),
      {
        name: "get_telemetry_history",
        description:
          "Get recent historical observations (oldest to newest) of one metric for a rack, with simple stats for trend analysis.",
        schema: z.object({
          rack_id: RackId,
          metric_type: MetricType,
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
  ];
}
