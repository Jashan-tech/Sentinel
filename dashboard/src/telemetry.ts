import { Timestamp } from "spacetimedb";
export const metrics = [
  {
    id: "AMBIENT_TEMPERATURE_C",
    label: "Ambient temperature",
    unit: "°C",
    glyph: "◉",
    min: -50,
    max: 100,
    step: "0.1",
  },
  {
    id: "RELATIVE_HUMIDITY_PERCENT",
    label: "Relative humidity",
    unit: "%RH",
    glyph: "◈",
    min: 0,
    max: 100,
    step: "0.1",
  },
  {
    id: "SOUND_RAW",
    label: "Sound intensity",
    unit: "raw",
    glyph: "≋",
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    step: "any",
  },
  {
    id: "ULTRASONIC_DISTANCE_CM",
    label: "Ultrasonic distance",
    unit: "cm",
    glyph: "↔",
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    step: "0.1",
  },
];
export const date = (t: Timestamp) =>
  new Date(Number(t.microsSinceUnixEpoch / 1000n)).toLocaleString();
