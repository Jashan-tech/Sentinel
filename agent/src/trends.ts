import { createHash } from "node:crypto";
import {
  METRIC_TYPES,
  type InvestigationRequest,
  type MetricType,
  type RackProfile,
  type TelemetryReading,
} from "./schemas.js";

/** Demonstration heuristics, NOT sensor calibration or manufacturer limits. */
export const TREND_POLICY = {
  version: "sentinel-trends-v1",
  maximum_source_series: 8,
  minimum_samples: 3,
  minimum_window_seconds: 60,
  maximum_gap_seconds: 120,
  threshold_repetitions: 3,
  tolerance: {
    AMBIENT_TEMPERATURE_C: 0.5,
    RELATIVE_HUMIDITY_PERCENT: 2,
    SOUND_RAW: 10,
    ULTRASONIC_DISTANCE_CM: 2,
  },
  significant_change: { SOUND_RAW: 100, ULTRASONIC_DISTANCE_CM: 10 },
} as const;
const units: Record<MetricType, readonly string[]> = {
  AMBIENT_TEMPERATURE_C: ["°C", "C"],
  RELATIVE_HUMIDITY_PERCENT: ["%RH", "%"],
  SOUND_RAW: ["raw"],
  ULTRASONIC_DISTANCE_CM: ["cm"],
};
export function validReading(r: TelemetryReading, asOf: number): boolean {
  const value = r.numeric_value;
  const observed = Date.parse(r.observed_at),
    ingested = Date.parse(r.ingested_at);
  return (
    METRIC_TYPES.includes(r.metric_type) &&
    units[r.metric_type].includes(r.unit) &&
    Number.isFinite(value) &&
    (r.metric_type === "AMBIENT_TEMPERATURE_C"
      ? value >= -50 && value <= 100
      : value >= 0 &&
        value <=
          (r.metric_type === "RELATIVE_HUMIDITY_PERCENT"
            ? 100
            : Number.MAX_SAFE_INTEGER)) &&
    Number.isFinite(observed) &&
    observed > 0 &&
    observed <= asOf &&
    Number.isFinite(ingested) &&
    ingested > 0 &&
    Boolean(r.source_identifier.trim()) &&
    Boolean(r.source_type.trim()) &&
    (r.source_type === "SIMULATOR" ? r.simulated : !r.simulated)
  );
}
export function metricThreshold(metric: MetricType, p: RackProfile) {
  return metric === "AMBIENT_TEMPERATURE_C"
    ? { warning: p.temperature_warning_c, critical: p.temperature_critical_c }
    : metric === "RELATIVE_HUMIDITY_PERCENT"
      ? {
          warning: p.humidity_warning_percent ?? null,
          critical: p.humidity_critical_percent ?? null,
        }
      : { warning: null, critical: null };
}
const sourceKey = (r: TelemetryReading) =>
  JSON.stringify([r.source_type, r.source_identifier, r.simulated]);
export function analyzeTrends(
  req: InvestigationRequest,
  staleAfterMinutes: number,
) {
  const asOf = Date.parse(req.as_of ?? new Date().toISOString());
  if (
    !Number.isFinite(asOf) ||
    !Number.isFinite(staleAfterMinutes) ||
    staleAfterMinutes <= 0
  )
    throw new Error("Invalid trend reference time or freshness window");
  return METRIC_TYPES.map((metric) => {
    const all = req.recent_telemetry.filter((r) => r.metric_type === metric);
    const rejected = all.filter((r) => !validReading(r, asOf));
    const groups = new Map<string, TelemetryReading[]>();
    for (const r of all.filter((r) => validReading(r, asOf))) {
      const key = sourceKey(r);
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    const threshold = metricThreshold(metric, req.profile);
    const omittedSources = Math.max(
      0,
      groups.size - TREND_POLICY.maximum_source_series,
    );
    const series = [...groups.entries()]
      .sort(
        ([a, ar], [b, br]) =>
          Math.max(...br.map((r) => Date.parse(r.observed_at))) -
            Math.max(...ar.map((r) => Date.parse(r.observed_at))) ||
          a.localeCompare(b),
      )
      .slice(0, TREND_POLICY.maximum_source_series)
      .map(([key, input]) => {
        const times = new Map<number, TelemetryReading[]>();
        for (const r of input) {
          const t = Date.parse(r.observed_at);
          times.set(t, [...(times.get(t) ?? []), r]);
        }
        let duplicates = 0,
          conflicts = 0;
        const samples: TelemetryReading[] = [];
        for (const [, rows] of [...times.entries()].sort(([a], [b]) => a - b)) {
          if (new Set(rows.map((r) => r.numeric_value)).size > 1) {
            conflicts += rows.length;
            continue;
          }
          duplicates += rows.length - 1;
          // Identical timestamp/value: earliest ingestion, then stable complete-row representation.
          samples.push(
            [...rows].sort(
              (a, b) =>
                Date.parse(a.ingested_at) - Date.parse(b.ingested_at) ||
                JSON.stringify(a).localeCompare(JSON.stringify(b)),
            )[0],
          );
        }
        const first = samples[0],
          last = samples.at(-1),
          values = samples.map((r) => r.numeric_value);
        const elapsed =
          first && last
            ? (Date.parse(last.observed_at) - Date.parse(first.observed_at)) /
              1000
            : 0;
        const delta =
          samples.length >= 2
            ? last!.numeric_value - first!.numeric_value
            : null;
        const steps = samples
          .slice(1)
          .map((r, i) => r.numeric_value - samples[i].numeric_value);
        const maxGap = Math.max(
          0,
          ...samples
            .slice(1)
            .map(
              (r, i) =>
                (Date.parse(r.observed_at) -
                  Date.parse(samples[i].observed_at)) /
                1000,
            ),
        );
        const tolerance = TREND_POLICY.tolerance[metric];
        const quality: string[] = [];
        if (samples.length < TREND_POLICY.minimum_samples)
          quality.push("insufficient_samples");
        if (elapsed < TREND_POLICY.minimum_window_seconds)
          quality.push("short_observation_window");
        if (maxGap > TREND_POLICY.maximum_gap_seconds)
          quality.push("sparse_history");
        if (conflicts) quality.push("conflicting_duplicate_timestamps");
        if (rejected.length) quality.push("invalid_observations_excluded");
        const stale = last
          ? (asOf - Date.parse(last.observed_at)) / 60000 > staleAfterMinutes
          : true;
        if (stale) quality.push("stale_or_missing_history");
        let direction:
          "increasing" | "decreasing" | "stable" | "insufficient_data" =
          "insufficient_data";
        const eligible =
          samples.length >= TREND_POLICY.minimum_samples &&
          elapsed >= TREND_POLICY.minimum_window_seconds &&
          maxGap <= TREND_POLICY.maximum_gap_seconds &&
          conflicts === 0 &&
          rejected.length === 0;
        if (eligible) {
          if (Math.max(...values) - Math.min(...values) <= tolerance)
            direction = "stable";
          else if (
            delta! >= tolerance &&
            steps.every((d) => d >= -tolerance / 10) &&
            steps.filter((d) => d > tolerance / 10).length >= 2
          )
            direction = "increasing";
          else if (
            delta! <= -tolerance &&
            steps.every((d) => d <= tolerance / 10) &&
            steps.filter((d) => d < -tolerance / 10).length >= 2
          )
            direction = "decreasing";
          else quality.push("inconsistent_direction");
        }
        // Sampled abnormal spans only: never integrate across a missing interval or extrapolate to now.
        let duration = 0,
          longest = 0,
          run = 0,
          abnormalPairs = 0;
        const breached = (r: TelemetryReading) =>
          threshold.warning !== null && r.numeric_value >= threshold.warning;
        for (let i = 1; i < samples.length; i++) {
          const seconds =
            (Date.parse(samples[i].observed_at) -
              Date.parse(samples[i - 1].observed_at)) /
            1000;
          const invalidBetween = rejected.some(
            (r) =>
              Date.parse(r.observed_at) >
                Date.parse(samples[i - 1].observed_at) &&
              Date.parse(r.observed_at) < Date.parse(samples[i].observed_at),
          );
          const conflictBetween = [...times.entries()].some(
            ([t, rows]) =>
              t > Date.parse(samples[i - 1].observed_at) &&
              t < Date.parse(samples[i].observed_at) &&
              new Set(rows.map((r) => r.numeric_value)).size > 1,
          );
          if (
            breached(samples[i - 1]) &&
            breached(samples[i]) &&
            seconds <= TREND_POLICY.maximum_gap_seconds &&
            !conflictBetween &&
            !invalidBetween
          ) {
            duration += seconds;
            run += seconds;
            longest = Math.max(longest, run);
            abnormalPairs++;
          } else run = 0;
        }
        const provenance = input[0];
        const window = {
          first_observed_at: first?.observed_at ?? null,
          last_observed_at: last?.observed_at ?? null,
          as_of: new Date(asOf).toISOString(),
          observation_ids: samples.flatMap((r) =>
            r.observation_id ? [r.observation_id] : [],
          ),
          sha256: createHash("sha256")
            .update(JSON.stringify(samples))
            .digest("hex"),
        };
        return {
          series_id: createHash("sha256")
            .update(key)
            .digest("hex")
            .slice(0, 16),
          source_type: provenance.source_type,
          source_identifier: provenance.source_identifier,
          simulated: provenance.simulated,
          provenance: provenance.simulated
            ? "SIMULATED"
            : "NON_SIMULATED_INPUT_NOT_DEVICE_VERIFIED",
          unit: units[metric][0],
          observation_window: window,
          observation_count: samples.length,
          first_value: first?.numeric_value ?? null,
          last_value: last?.numeric_value ?? null,
          absolute_change: delta,
          elapsed_seconds: elapsed,
          change_per_minute:
            delta !== null && elapsed > 0 ? delta / (elapsed / 60) : null,
          minimum: values.length ? Math.min(...values) : null,
          maximum: values.length ? Math.max(...values) : null,
          average: values.length
            ? values.reduce((a, b) => a + b, 0) / values.length
            : null,
          direction,
          stale,
          maximum_gap_seconds: maxGap,
          duplicate_observations_removed: duplicates,
          conflicting_observations_excluded: conflicts,
          threshold_violations:
            threshold.warning === null ? null : samples.filter(breached).length,
          critical_violations:
            threshold.critical === null
              ? null
              : samples.filter((r) => r.numeric_value >= threshold.critical!)
                  .length,
          observed_abnormal_span_seconds: abnormalPairs ? duration : null,
          longest_abnormal_span_seconds: abnormalPairs ? longest : null,
          data_quality: quality,
        };
      });
    return {
      rack_id: req.rack_id,
      metric_type: metric,
      policy_version: TREND_POLICY.version,
      thresholds: { ...threshold, provenance: "FICTIONAL_DEMO_CONFIGURATION" },
      input_observations: all.length,
      rejected_observations: rejected.length,
      omitted_source_series: omittedSources,
      series,
      note: "Separate source/provenance series. Endpoint rates describe only the observed window. Sampled abnormal spans do not prove continuous abnormality between readings. No interpolation or extrapolation.",
    };
  });
}
export type MetricTrend = ReturnType<typeof analyzeTrends>[number];
export type TrendSeries = MetricTrend["series"][number];
export interface EarlyWarningIndicator {
  indicator_id: string;
  rack_id: string;
  metric: MetricType;
  severity: "WARNING" | "CRITICAL" | "UNKNOWN";
  classification:
    "OBSERVED_ABNORMAL_CONDITION" | "EARLY_WARNING_TREND" | "DATA_QUALITY";
  observed_evidence: Record<string, unknown>;
  observation_window: TrendSeries["observation_window"] | null;
  triggering_rule: string;
  explanation: string;
  missing_information: string[];
  recommended_next_inspection: string;
}
export function earlyWarnings(
  req: InvestigationRequest,
  trends: MetricTrend[],
  staleAfterMinutes: number,
): EarlyWarningIndicator[] {
  const asOf = Date.parse(req.as_of ?? new Date().toISOString()),
    output: EarlyWarningIndicator[] = [];
  for (const t of trends) {
    const current = req.current_telemetry.filter(
      (r) => r.metric_type === t.metric_type && validReading(r, asOf),
    );
    const add = (
      rule: string,
      s: TrendSeries | null,
      classification: EarlyWarningIndicator["classification"],
      severity: EarlyWarningIndicator["severity"],
      explanation: string,
      missing: string[],
      next: string,
      extra: Record<string, unknown> = {},
    ) => {
      output.push({
        indicator_id: `${req.rack_id}:${t.metric_type}:${
          s?.series_id ??
          (extra.source_identifier
            ? createHash("sha256")
                .update(
                  JSON.stringify([
                    extra.source_type,
                    extra.source_identifier,
                    extra.simulated,
                  ]),
                )
                .digest("hex")
                .slice(0, 16)
            : "metric")
        }:${rule}`,
        rack_id: req.rack_id,
        metric: t.metric_type,
        severity,
        classification,
        observed_evidence: {
          source_type: s?.source_type ?? null,
          source_identifier: s?.source_identifier ?? null,
          simulated: s?.simulated ?? null,
          observation_count: s?.observation_count ?? 0,
          absolute_change: s?.absolute_change ?? null,
          change_per_minute: s?.change_per_minute ?? null,
          threshold_violations: s?.threshold_violations ?? null,
          ...extra,
        },
        observation_window:
          s?.observation_window ??
          (typeof extra.current_observed_at === "string"
            ? {
                first_observed_at: extra.current_observed_at,
                last_observed_at: extra.current_observed_at,
                as_of: new Date(asOf).toISOString(),
                observation_ids: [],
                sha256: createHash("sha256")
                  .update(JSON.stringify(extra))
                  .digest("hex"),
              }
            : null),
        triggering_rule: `${TREND_POLICY.version}/${rule}`,
        explanation,
        missing_information: missing,
        recommended_next_inspection: next,
      });
    };
    if (t.omitted_source_series)
      add(
        "SOURCE_LIMIT",
        null,
        "DATA_QUALITY",
        "UNKNOWN",
        "Only the 8 most recently observed source series are analyzed for this metric; coverage is incomplete.",
        ["Omitted source histories"],
        "Investigate a narrower sensor snapshot.",
        { omitted_source_series: t.omitted_source_series },
      );
    if (!current.length)
      add(
        "MISSING_CURRENT",
        null,
        "DATA_QUALITY",
        "UNKNOWN",
        "No valid current measurement is available; absence does not establish health.",
        ["Current observation and provenance"],
        "Obtain an explicit reading with a known source.",
        {
          rejected_current_observations: req.current_telemetry.filter(
            (r) => r.metric_type === t.metric_type,
          ).length,
        },
      );
    for (const r of current) {
      const stale =
        (asOf - Date.parse(r.observed_at)) / 60000 > staleAfterMinutes;
      const series =
        t.series.find(
          (s) =>
            s.source_type === r.source_type &&
            s.source_identifier === r.source_identifier &&
            s.simulated === r.simulated,
        ) ?? null;
      const details = {
        current_value: r.numeric_value,
        unit: r.unit,
        source_type: r.source_type,
        source_identifier: r.source_identifier,
        simulated: r.simulated,
        current_observed_at: r.observed_at,
        current_ingested_at: r.ingested_at,
      };
      if (stale)
        add(
          "STALE_CURRENT",
          series,
          "DATA_QUALITY",
          "UNKNOWN",
          "The last current observation exceeds the configured freshness window.",
          ["Fresh measurement"],
          "Collect a new independent observation.",
          details,
        );
      else if (
        t.thresholds.warning !== null &&
        r.numeric_value >= t.thresholds.warning
      )
        add(
          "CURRENT_THRESHOLD",
          series,
          "OBSERVED_ABNORMAL_CONDITION",
          t.thresholds.critical !== null &&
            r.numeric_value >= t.thresholds.critical
            ? "CRITICAL"
            : "WARNING",
          "A fresh supplied observation meets a fictional rack-profile threshold; this is not an equipment fault.",
          ["Equipment condition and sensor placement verification"],
          "Verify sensor placement and repeat the environmental measurement.",
          { ...details, thresholds: t.thresholds },
        );
    }
    if (!t.series.length)
      add(
        "MISSING_HISTORY",
        null,
        "DATA_QUALITY",
        "UNKNOWN",
        "No valid historical samples are available.",
        ["At least 3 valid samples spanning 60 seconds"],
        "Collect independent timestamped observations; never fill gaps.",
      );
    for (const s of t.series) {
      const matching = current.filter(
        (r) =>
          sourceKey(r) ===
          JSON.stringify([s.source_type, s.source_identifier, s.simulated]),
      );
      const fresh =
        matching.some(
          (r) =>
            (asOf - Date.parse(r.observed_at)) / 60000 <= staleAfterMinutes,
        ) && !s.stale;
      if (s.direction === "insufficient_data" || s.stale)
        add(
          "INSUFFICIENT_OR_STALE_HISTORY",
          s,
          "DATA_QUALITY",
          "UNKNOWN",
          "This historical series cannot establish a current sustained trend.",
          s.data_quality,
          "Gather consistent readings from the same sensor over a sufficient window.",
        );
      if ((s.threshold_violations ?? 0) >= TREND_POLICY.threshold_repetitions)
        add(
          "REPEATED_THRESHOLD",
          s,
          "OBSERVED_ABNORMAL_CONDITION",
          "WARNING",
          "At least three distinct sampled timestamps meet the selected profile warning threshold. Historical breaches do not establish a current fault.",
          [
            "Condition between observations",
            "Manufacturer applicability and sensor placement",
          ],
          "Inspect the environment and repeat measurements at the same known position.",
          {
            thresholds: t.thresholds,
            sampled_abnormal_span_seconds: s.observed_abnormal_span_seconds,
            history_stale: s.stale,
          },
        );
      const latestConsistent = matching.some(
        (r) =>
          Date.parse(r.observed_at) >=
            Date.parse(s.observation_window.last_observed_at ?? "") &&
          Math.abs(r.numeric_value - s.last_value!) <=
            TREND_POLICY.tolerance[t.metric_type],
      );
      if (!fresh || !latestConsistent) continue; // Don't warn about a recovered, missing, contradictory, or stale current source.
      if (
        (t.metric_type === "AMBIENT_TEMPERATURE_C" ||
          t.metric_type === "RELATIVE_HUMIDITY_PERCENT") &&
        s.direction === "increasing"
      )
        add(
          "SUSTAINED_INCREASE",
          s,
          "EARLY_WARNING_TREND",
          "WARNING",
          "A consistent increase is observed across at least 3 samples over 60 seconds. No failure timing or probability is inferred.",
          ["Cause of change", "Sensor calibration and location"],
          "Repeat environmental measurements and inspect airflow or humidity sources without assuming a cause.",
        );
      if (
        (t.metric_type === "SOUND_RAW" ||
          t.metric_type === "ULTRASONIC_DISTANCE_CM") &&
        s.absolute_change !== null &&
        s.observation_count >= 2 &&
        s.maximum_gap_seconds <= TREND_POLICY.maximum_gap_seconds &&
        s.conflicting_observations_excluded === 0 &&
        t.rejected_observations === 0
      ) {
        const threshold =
          t.metric_type === "SOUND_RAW"
            ? Math.max(
                TREND_POLICY.significant_change.SOUND_RAW,
                Math.abs(s.first_value!) * 0.25,
              )
            : TREND_POLICY.significant_change.ULTRASONIC_DISTANCE_CM;
        if (Math.abs(s.absolute_change) >= threshold)
          add(
            "SIGNIFICANT_OBSERVED_CHANGE",
            s,
            "EARLY_WARNING_TREND",
            "WARNING",
            t.metric_type === "SOUND_RAW"
              ? "Uncalibrated raw intensity changed significantly under a demonstration heuristic; no dB conversion or mechanical diagnosis."
              : "Distance changed under a demonstration heuristic; this alone does not establish motion, obstruction, or collision.",
            [
              "Sensor position and acquisition context",
              t.metric_type === "SOUND_RAW"
                ? "Sensor gain and calibration"
                : "Target geometry",
            ],
            "Repeat from a fixed sensor position and document the acquisition context.",
            {
              significance_threshold: threshold,
              sustained_trend: s.direction !== "insufficient_data",
            },
          );
      }
    }
  }
  return [
    ...new Map(
      output.map((i) => [
        i.indicator_id +
          ":" +
          String(i.observed_evidence.source_identifier) +
          ":" +
          String(i.observed_evidence.source_type) +
          ":" +
          String(i.observed_evidence.simulated),
        i,
      ]),
    ).values(),
  ];
}
