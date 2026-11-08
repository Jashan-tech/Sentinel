// Pure helpers for the Rack Monitor's installed-equipment card. Reference comparisons only:
// documented ranges describe server inlet air; the rover measures ambient air near the rack.
import type { CatalogEntry } from "../../spacetimedb/src/equipmentCatalog";

export type RangePosition = "below" | "within" | "extended" | "above";

/** Where a reading sits relative to the documented operating ranges. */
export function temperaturePosition(value: number, e: CatalogEntry): RangePosition {
  const std = e.standardTemperatureC;
  if (value < std.min) return "below";
  if (value <= std.max) return "within";
  const max = e.maxDocumentedTemperatureC?.value;
  if (max !== undefined && value <= max) return "extended";
  return "above";
}

export function humidityPosition(value: number, e: CatalogEntry): RangePosition {
  const r = e.operatingHumidityPercent;
  return value < r.min ? "below" : value <= r.max ? "within" : "above";
}

export const POSITION_TEXT: Record<RangePosition, string> = {
  below: "Below the documented operating range",
  within: "Within the documented standard range",
  extended: "Above the standard range; documented only for approved/extended configurations",
  above: "Above every documented operating limit",
};

/** Identity sent to the agent when a server is assigned to the rack. */
export function assignedIdentity(e: CatalogEntry) {
  return {
    manufacturer: e.manufacturer,
    model: e.model,
    provenance: "OPERATOR_PROVIDED" as const,
    assertion:
      "Operator assigned this server to the rack in SENTINEL's installed-equipment setting; not inferred from a photograph or generic profile.",
  };
}
