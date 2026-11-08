import { test } from "node:test";
import assert from "node:assert/strict";
import { validateObservation, evaluate, METRICS } from "../src/rules";
const now = 1_800_000_000_000_000n;
const valid = {
  metricType: "AMBIENT_TEMPERATURE_C",
  numericValue: 25,
  unit: "°C",
  sourceType: "SIMULATOR",
  sourceIdentifier: "test",
  observedMicros: now,
};
for (const [metricType, definition] of Object.entries(METRICS))
  test(`accepts independently obtained ${metricType}`, () =>
    assert.doesNotThrow(() =>
      validateObservation(
        { ...valid, metricType, unit: definition.unit, numericValue: 10 },
        now,
      ),
    ));
for (const [label, change] of Object.entries({
  "unknown metric": { metricType: "FAN_RPM" },
  "wrong unit": { unit: "dB" },
  NaN: { numericValue: NaN },
  infinity: { numericValue: Infinity },
  "negative infinity": { numericValue: -Infinity },
  "unreasonable low temperature": { numericValue: -51 },
  "unreasonable high temperature": { numericValue: 101 },
  "humidity above 100": {
    metricType: "RELATIVE_HUMIDITY_PERCENT",
    unit: "%RH",
    numericValue: 101,
  },
  "humidity below zero": {
    metricType: "RELATIVE_HUMIDITY_PERCENT",
    unit: "%RH",
    numericValue: -1,
  },
  "negative distance": {
    metricType: "ULTRASONIC_DISTANCE_CM",
    unit: "cm",
    numericValue: -1,
  },
  "negative sound": { metricType: "SOUND_RAW", unit: "raw", numericValue: -1 },
  "future timestamp": { observedMicros: now + 30_000_001n },
  "invalid timestamp": { observedMicros: 0n },
  "empty source": { sourceIdentifier: " " },
  "oversized source": { sourceIdentifier: "x".repeat(101) },
  "hardware impersonation": { sourceType: "ROVER" },
  "infrastructure impersonation": { sourceType: "REDFISH" },
}))
  test(`rejects ${label}`, () =>
    assert.throws(() => validateObservation({ ...valid, ...change }, now)));
test("accepts ROVER only for an authorized agent identity", () => {
  assert.doesNotThrow(() => validateObservation({ ...valid, sourceType: "ROVER" }, now, true));
  assert.throws(() => validateObservation({ ...valid, sourceType: "ROVER" }, now, false));
  assert.throws(() => validateObservation({ ...valid, sourceType: "REDFISH" }, now, true));
});
test("accepts delayed observations and exact future tolerance", () => {
  assert.doesNotThrow(() =>
    validateObservation({ ...valid, observedMicros: now - 90_000_000n }, now),
  );
  assert.doesNotThrow(() =>
    validateObservation({ ...valid, observedMicros: now + 30_000_000n }, now),
  );
});
const profile = {
  temperatureWarningC: 32,
  temperatureCriticalC: 40,
  humidityWarningPercent: 70,
};
for (const [value, severity] of [
  [31.99, undefined],
  [32, "WARNING"],
  [39.99, "WARNING"],
  [40, "CRITICAL"],
] as const)
  test(`temperature boundary ${value}`, () =>
    assert.equal(
      evaluate("AMBIENT_TEMPERATURE_C", value, profile)?.severity,
      severity,
    ));
for (const [value, severity] of [
  [69.99, undefined],
  [70, "WARNING"],
] as const)
  test(`humidity boundary ${value}`, () =>
    assert.equal(
      evaluate("RELATIVE_HUMIDITY_PERCENT", value, profile)?.severity,
      severity,
    ));
test("sound and distance never produce diagnoses", () => {
  assert.equal(evaluate("SOUND_RAW", 99999, profile), undefined);
  assert.equal(evaluate("ULTRASONIC_DISTANCE_CM", 0, profile), undefined);
});
