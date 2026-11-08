import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EQUIPMENT_CATALOG, catalogEntry, documentedThresholds } from "../../spacetimedb/src/equipmentCatalog";
import { evaluate } from "../../spacetimedb/src/rules";
import { assignedIdentity, humidityPosition, temperaturePosition } from "../src/equipmentView";

const docs = JSON.parse(readFileSync(new URL("../../agent/src/fixtures/docs/equipment-docs.json", import.meta.url), "utf8")).documents;

test("catalog: five servers, each matching a verified, sourced agent knowledge-base record", () => {
  assert.equal(EQUIPMENT_CATALOG.length, 5);
  assert.equal(new Set(EQUIPMENT_CATALOG.map((e) => e.manufacturer)).size, 5);
  for (const e of EQUIPMENT_CATALOG) {
    const d = docs.find((x: any) => x.doc_id === e.docId);
    assert.ok(d, e.docId);
    assert.equal(d.verified, true);
    assert.equal(d.source_type, "MANUFACTURER_SPECIFICATION");
    assert.equal(d.manufacturer, e.manufacturer);
    assert.deepEqual(d.supported_models, [e.model]);
    assert.equal(d.source_url, e.source.url);
    assert.match(e.source.url, /^https:\/\/(www\.dell\.com|support\.hpe\.com|pubs\.lenovo\.com|www\.cisco\.com|www\.supermicro\.com)\//);
    // The documented numbers in the catalog appear in the knowledge-base facts the agent will read.
    const facts = d.technical_facts.map((f: any) => f.statement).join(" ");
    assert.match(facts, new RegExp(`${e.standardTemperatureC.min}(?: °C)?\\D{1,6}${e.standardTemperatureC.max} °C`));
    assert.ok(facts.includes(`${e.operatingHumidityPercent.max}%`), `${e.docId} humidity max`);
    if (e.maxDocumentedTemperatureC) assert.ok(facts.includes(`${e.maxDocumentedTemperatureC.value} °C`), `${e.docId} max`);
  }
});
test("knowledge base: no corrupted characters remain", () => {
  const text = JSON.stringify(docs.map((d: any) => ({ ...d, source_url: "" })));
  assert.doesNotMatch(text, /\d\?\d|\?C\b| \? /);
});
test("documented thresholds: warning at the standard limit, critical at the highest documented limit", () => {
  const dell = documentedThresholds(catalogEntry("dell-poweredge-r760")!);
  assert.deepEqual([dell.temperatureWarningC, dell.temperatureCriticalC, dell.humidityWarningPercent], [35, 45, 80]);
  const cisco = documentedThresholds(catalogEntry("cisco-ucs-c220-m7")!);
  assert.deepEqual([cisco.temperatureWarningC, cisco.temperatureCriticalC, cisco.humidityWarningPercent], [35, 35, 90]);
  assert.match(cisco.mapping, /no separate warning tier/);
  // With no separate warning tier, reaching the only documented limit is CRITICAL.
  assert.equal(evaluate("AMBIENT_TEMPERATURE_C", 35, cisco, "manufacturer-documented")?.severity, "CRITICAL");
  assert.equal(evaluate("AMBIENT_TEMPERATURE_C", 34.9, cisco, "manufacturer-documented"), undefined);
  assert.equal(evaluate("AMBIENT_TEMPERATURE_C", 36, dell, "manufacturer-documented")?.severity, "WARNING");
  assert.match(evaluate("AMBIENT_TEMPERATURE_C", 46, dell, "manufacturer-documented")!.message, /manufacturer-documented critical .* not the server inlet/);
  assert.match(evaluate("AMBIENT_TEMPERATURE_C", 46, dell)!.message, /demonstration critical/);
});
test("range position: reference comparison against the documented ranges", () => {
  const hpe = catalogEntry("hpe-proliant-dl360-gen11")!;
  const smc = catalogEntry("supermicro-sys-621c-tn12r")!;
  assert.equal(temperaturePosition(9, hpe), "below");
  assert.equal(temperaturePosition(35, hpe), "within");
  assert.equal(temperaturePosition(41.5, hpe), "extended");
  assert.equal(temperaturePosition(46, hpe), "above");
  assert.equal(temperaturePosition(36, smc), "above"); // nothing documented above 35 °C
  assert.equal(humidityPosition(85, smc), "above");
  assert.equal(humidityPosition(45, smc), "within");
});
test("assigned identity is an explicit operator assignment", () => {
  const id = assignedIdentity(catalogEntry("lenovo-thinksystem-sr650-v3")!);
  assert.deepEqual([id.manufacturer, id.model, id.provenance], ["Lenovo", "ThinkSystem SR650 V3", "OPERATOR_PROVIDED"]);
});
