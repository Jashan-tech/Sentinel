// Display-only cleanup of AI-written text for the compact "Main finding" card. It rewrites notation,
// never meaning: metric codes become everyday names, ISO timestamps become local clock times, and
// source-identifier asides are dropped. The untouched text stays in the investigation details.

const METRIC_NAMES: Record<string, string> = {
  AMBIENT_TEMPERATURE_C: "ambient temperature",
  RELATIVE_HUMIDITY_PERCENT: "humidity",
  SOUND_RAW: "sound level",
  ULTRASONIC_DISTANCE_CM: "ultrasonic distance",
};
const ISO = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})\b/g;

export function localTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === now.toDateString()
    ? time
    : `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
}

/** Rewrite codes, timestamps and source asides into readable text. */
export function plainText(text: string, now = new Date()): string {
  let s = text;
  s = s.replace(/\s*\((?:source|source_identifier|sources?)[: ][^)]*\)/gi, "");
  s = s.replace(/\s*\b(?:from\s+)?source(?:_identifier)?\s+(?=[\w.-]*[-\d])[\w.-]+/gi, "");
  s = s.replace(ISO, (m) => localTime(m, now));
  s = s.replace(/\b[A-Z][A-Z_]+_(?:C|PERCENT|RAW|CM)\b/g, (m) => METRIC_NAMES[m] ?? m.toLowerCase().replace(/_/g, " "));
  s = s.replace(/(^|[.!?]\s+)([a-z])/g, (_, p, c) => p + c.toUpperCase()); // re-capitalise sentence starts
  return s.replace(/\s{2,}/g, " ").replace(/\s+([,.])/g, "$1").trim();
}

/** The first `max` sentences of a text (for summaries without a headline). */
export function firstSentences(text: string, max = 2): string {
  // A sentence ends at . ! or ? followed by whitespace and a capital letter (so "41.5 °C" never splits).
  const parts = text.split(/(?<=[.!?])\s+(?=[A-Z])/);
  return parts.slice(0, max).join(" ").trim();
}

/** The compact main finding: the AI headline when present, otherwise the start of the summary. */
export function mainFinding(report: { headline?: string; summary?: string } | null | undefined, now = new Date()): string {
  const h = report?.headline?.trim();
  if (h) return plainText(h, now);
  const s = report?.summary?.trim();
  return s ? plainText(firstSentences(s), now) : "";
}
