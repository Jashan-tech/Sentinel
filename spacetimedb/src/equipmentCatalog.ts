// Installed-equipment catalog: five rack servers whose environmental ranges were read from the
// manufacturers' own documentation on 2026-11-08 (see `source`). Numbers are copied from those
// documents, never estimated. Shared by the SpacetimeDB module (validation, documented threshold
// profiles), the dashboard (Rack Monitor reference card) and tests. The agent's documentation
// knowledge base (agent/src/fixtures/docs/equipment-docs.json) carries the matching sourced facts;
// a parity test keeps the two consistent.

export interface DocumentedRange {
  min: number;
  max: number;
  /** Exact conditions from the source. */
  note: string;
}

export interface CatalogEntry {
  modelId: string;
  manufacturer: string;
  model: string;
  equipmentType: "Compute";
  docId: string;
  source: {
    title: string;
    url: string;
    section: string;
    /** Revision/date as printed on the source; null when the source shows none. */
    revision: string | null;
    accessDate: string;
  };
  /** Standard continuous operating temperature (°C) at the stated altitude. */
  standardTemperatureC: DocumentedRange;
  /** Highest documented operating temperature (°C) for any supported class/configuration, or null if none beyond standard. */
  maxDocumentedTemperatureC: { value: number; note: string } | null;
  /** Standard operating relative humidity (%RH, non-condensing). */
  operatingHumidityPercent: DocumentedRange;
  altitudeDerating: string;
}

export const EQUIPMENT_CATALOG: readonly CatalogEntry[] = [
  {
    modelId: "dell-poweredge-r760",
    manufacturer: "Dell",
    model: "PowerEdge R760",
    equipmentType: "Compute",
    docId: "DELL-R760-ENV",
    source: {
      title: "Dell PowerEdge R760 Installation and Service Manual — Environmental specifications",
      url: "https://www.dell.com/support/manuals/en-us/poweredge-r760/per760_ism_pub/environmental-specifications?guid=guid-11193b30-1caa-4e7b-900f-bc79a66398ad&lang=en-us",
      section: "Tables 1–4: Continuous Operation Specifications for ASHRAE A2, A3, A4; Common Environmental Specifications",
      revision: null,
      accessDate: "2026-11-08",
    },
    standardTemperatureC: { min: 10, max: 35, note: "ASHRAE A2 continuous operation, altitude ≤ 900 m, no direct sunlight on the equipment" },
    maxDocumentedTemperatureC: { value: 45, note: "ASHRAE A4: 40–45 °C limited to 1% annual runtime (35–40 °C to 10%); applies only where the configuration supports A4" },
    operatingHumidityPercent: { min: 8, max: 80, note: "ASHRAE A2: 8% RH with −12 °C minimum dew point to 80% RH with 21 °C maximum dew point, non-condensing" },
    altitudeDerating: "A2: maximum temperature reduced by 1 °C per 300 m above 900 m",
  },
  {
    modelId: "hpe-proliant-dl360-gen11",
    manufacturer: "HPE",
    model: "ProLiant DL360 Gen11",
    equipmentType: "Compute",
    docId: "HPE-DL360-G11-ENV",
    source: {
      title: "HPE ProLiant DL360 Gen11 Server User Guide — Environmental specifications",
      url: "https://support.hpe.com/hpesc/public/docDisplay?docId=sd00002444en_us&page=GUID-F3AAB60A-8A77-40E2-8DB6-B4D1B52ABFB9.html",
      section: "Environmental specifications (temperature range, relative humidity, footnote 1)",
      revision: null,
      accessDate: "2026-11-08",
    },
    standardTemperatureC: { min: 10, max: 35, note: "Operating, at sea level; no direct sunlight; maximum rate of change 20 °C per hour" },
    maxDocumentedTemperatureC: { value: 45, note: "Extended system inlet range 40–45 °C for certain approved hardware configurations only (35–40 °C also extended)" },
    operatingHumidityPercent: { min: 8, max: 90, note: "Minimum: higher of −12 °C dew point or 8% RH; maximum: 24 °C dew point or 90% RH; non-condensing" },
    altitudeDerating: "1.0 °C per 304.8 m to 3048 m; the upper limit may be lowered by installed options",
  },
  {
    modelId: "lenovo-thinksystem-sr650-v3",
    manufacturer: "Lenovo",
    model: "ThinkSystem SR650 V3",
    equipmentType: "Compute",
    docId: "LENOVO-SR650-V3-ENV",
    source: {
      title: "ThinkSystem SR650 V3 — Environmental specifications (Lenovo Docs)",
      url: "https://pubs.lenovo.com/sr650-v3/server_specifications_environmental",
      section: "Environment: Air temperature; Relative humidity (non-condensing)",
      revision: null,
      accessDate: "2026-11-08",
    },
    standardTemperatureC: { min: 10, max: 35, note: "ASHRAE class A2 operating; maximum decreases 1 °C per 300 m above 900 m" },
    maxDocumentedTemperatureC: { value: 45, note: "ASHRAE A4: 5–45 °C where the configuration supports it; the server shuts down above the supported maximum (A4 45 °C)" },
    operatingHumidityPercent: { min: 20, max: 80, note: "ASHRAE class A2: 20%–80%; maximum dew point 21 °C; non-condensing" },
    altitudeDerating: "A2: maximum ambient decreases 1 °C per 300 m above 900 m",
  },
  {
    modelId: "cisco-ucs-c220-m7",
    manufacturer: "Cisco",
    model: "UCS C220 M7",
    equipmentType: "Compute",
    docId: "CISCO-C220-M7-ENV",
    source: {
      title: "Cisco UCS C220 M7 Server Installation and Service Guide — Server Specifications",
      url: "https://www.cisco.com/c/en/us/td/docs/unified_computing/ucs/c/hw/C220M7/install/b-c220-m7-installation-guide/m-specifications.html",
      section: "Environmental Specifications (Table 2)",
      revision: "Updated April 13, 2026",
      accessDate: "2026-11-08",
    },
    standardTemperatureC: { min: 10, max: 35, note: "Class A2 product: dry bulb 10–35 °C; maximum temperature change 20 °C per hour" },
    maxDocumentedTemperatureC: null,
    operatingHumidityPercent: { min: 10, max: 90, note: "10% to 90% and 28 °C maximum dew point, non-condensing (the same table also states a maximum of 24 °C dew point or 90% RH)" },
    altitudeDerating: "Derate maximum temperature 1 °C per 305 m above 900 m",
  },
  {
    modelId: "supermicro-sys-621c-tn12r",
    manufacturer: "Supermicro",
    model: "SYS-621C-TN12R",
    equipmentType: "Compute",
    docId: "SUPERMICRO-SYS-621C-TN12R-ENV",
    source: {
      title: "Supermicro CloudDC SuperServer SYS-621C-TN12R datasheet",
      url: "https://www.supermicro.com/en/products/system/datasheet/sys-621c-tn12r",
      section: "Operating Environment (page 3)",
      revision: "Datasheet PDF generated 2026-11-05",
      accessDate: "2026-11-08",
    },
    standardTemperatureC: { min: 10, max: 35, note: "Operating environment class A2" },
    maxDocumentedTemperatureC: null,
    operatingHumidityPercent: { min: 8, max: 80, note: "8% to 80% (max 21 °C dew point; non-condensing)" },
    altitudeDerating: "Not stated in the datasheet",
  },
];

export function catalogEntry(modelId: string): CatalogEntry | undefined {
  return EQUIPMENT_CATALOG.find((e) => e.modelId === modelId);
}

export interface DocumentedThresholds {
  profileId: string;
  name: string;
  temperatureWarningC: number;
  temperatureCriticalC: number;
  humidityWarningPercent: number;
  /** Plain statement of how each threshold maps to the source (shown in the UI and given to the agent). */
  mapping: string;
}

/**
 * Opt-in mapping from documented ranges to alert thresholds. Every number comes from the source:
 *  - WARNING  at the standard continuous upper limit (leaving the documented standard range);
 *  - CRITICAL at the highest documented operating limit. Where the manufacturer documents nothing
 *    above the standard limit, the standard limit is CRITICAL and no separate warning tier exists.
 *  - Humidity WARNING at the documented operating maximum.
 */
export function documentedThresholds(e: CatalogEntry): DocumentedThresholds {
  const hi = e.standardTemperatureC.max;
  const max = e.maxDocumentedTemperatureC?.value ?? null;
  return {
    profileId: `doc-${e.modelId}`,
    name: `${e.manufacturer} ${e.model} · documented range`,
    temperatureWarningC: hi,
    temperatureCriticalC: max ?? hi,
    humidityWarningPercent: e.operatingHumidityPercent.max,
    mapping:
      max !== null
        ? `Warning at ${hi} °C (documented standard upper limit); critical at ${max} °C (highest documented limit, for supported configurations only); humidity warning at ${e.operatingHumidityPercent.max}% RH (documented operating maximum).`
        : `Critical at ${hi} °C (the only documented operating upper limit; no separate warning tier is documented); humidity warning at ${e.operatingHumidityPercent.max}% RH (documented operating maximum).`,
  };
}
