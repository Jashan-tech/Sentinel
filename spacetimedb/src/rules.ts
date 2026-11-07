export const METRICS = {
  AMBIENT_TEMPERATURE_C: { unit: '°C', min: -50, max: 100 },
  RELATIVE_HUMIDITY_PERCENT: { unit: '%RH', min: 0, max: 100 },
  SOUND_RAW: { unit: 'raw', min: 0, max: Number.MAX_SAFE_INTEGER },
  ULTRASONIC_DISTANCE_CM: { unit: 'cm', min: 0, max: Number.MAX_SAFE_INTEGER },
} as const;
export type Metric = keyof typeof METRICS;
export const RECENT_LIMIT = 50;
export function validateObservation(a: { metricType: string; numericValue: number; unit: string; sourceType: string; sourceIdentifier: string; observedMicros: bigint }, now: bigint) {
  if (a.sourceType !== 'SIMULATOR') throw new Error('Only SIMULATOR sources are authorized in this demonstration');
  if (!Object.prototype.hasOwnProperty.call(METRICS, a.metricType)) throw new Error('Unsupported metric type');
  const metric = METRICS[a.metricType as Metric];
  if (a.unit !== metric.unit) throw new Error('Unit does not match metric');
  if (!Number.isFinite(a.numericValue) || a.numericValue < metric.min || a.numericValue > metric.max) throw new Error('Measurement is nonfinite or outside accepted bounds');
  if (!a.sourceIdentifier.trim() || a.sourceIdentifier.length > 100) throw new Error('Source identifier must contain 1–100 characters');
  if (a.observedMicros <= 0n || a.observedMicros > now + 30_000_000n) throw new Error('Invalid observation timestamp (maximum future tolerance: 30 seconds)');
}
export function evaluate(metric: string, value: number, profile: { temperatureWarningC: number; temperatureCriticalC: number; humidityWarningPercent: number }) {
  if (metric === 'AMBIENT_TEMPERATURE_C') {
    if (value >= profile.temperatureCriticalC) return { severity: 'CRITICAL', message: `Ambient temperature ${value} °C is at or above the demonstration critical threshold ${profile.temperatureCriticalC} °C.` };
    if (value >= profile.temperatureWarningC) return { severity: 'WARNING', message: `Ambient temperature ${value} °C is at or above the demonstration warning threshold ${profile.temperatureWarningC} °C.` };
  }
  if (metric === 'RELATIVE_HUMIDITY_PERCENT' && value >= profile.humidityWarningPercent) return { severity: 'WARNING', message: `Relative humidity ${value} %RH is at or above the demonstration warning threshold ${profile.humidityWarningPercent} %RH.` };
  return undefined;
}

