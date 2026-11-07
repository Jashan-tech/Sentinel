/**
 * Live demo: POSTs each fixture to the real /investigate endpoint (real Nemotron calls).
 * Starts the server in-process on a random port unless AGENT_URL is set.
 *   npm run demo                 # all scenarios
 *   npm run demo -- c-critical   # one scenario
 */
import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/model.js";
import type { DiagnosticReport, InvestigationEvent } from "../src/schemas.js";

const fixturesDir = new URL("../src/fixtures/", import.meta.url);
const load = (name: string) => JSON.parse(readFileSync(new URL(`${name}.json`, fixturesDir), "utf8"));

const scenarios: { name: string; key: string; body: any }[] = readdirSync(fixturesDir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => {
    const body = load(f.replace(/\.json$/, ""));
    return { name: body._scenario ?? f, key: f.replace(/\.json$/, ""), body };
  });

// Profile-sensitivity demo: Scenario B's exact readings under a more tolerant profile.
const b = load("b-elevated");
scenarios.push({
  name: "B2 - Same readings as B, Standard Network profile (SIMULATED)",
  key: "b2-profile",
  body: {
    ...b,
    rack_id: "rack-net-02",
    rack_name: "Network Rack B2",
    equipment_type: "Network",
    profile: { name: "Standard Network Rack (demo)", temperature_warning_c: 32, temperature_critical_c: 38, humidity_warning_percent: 65 },
    active_alerts: [],
  },
});

const filter = process.argv.slice(2);
const selected = filter.length
  ? scenarios.filter((s) => filter.some((f) => s.key.startsWith(f.toLowerCase()) || s.name.startsWith(`${f.toUpperCase()} `)))
  : scenarios;

try {
  loadConfig(); // fail fast with a clear message if NVIDIA_API_KEY is missing
} catch (err) {
  console.error(`Cannot run live demo: ${(err as Error).message}`);
  process.exit(1);
}

let baseUrl = process.env.AGENT_URL;
let server: ReturnType<ReturnType<typeof createApp>["listen"]> | undefined;
if (!baseUrl) {
  server = createApp().listen(0);
  await new Promise((r) => server!.once("listening", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const line = "=".repeat(78);
for (const s of selected) {
  console.log(`\n${line}\nSCENARIO: ${s.name}\n${line}`);
  const t0 = Date.now();
  const res = await fetch(`${baseUrl}/investigate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(s.body),
  });
  const data = (await res.json()) as { report: DiagnosticReport; events: InvestigationEvent[]; error?: string; message?: string };
  if (!data.report) {
    console.log(`HTTP ${res.status}:`, data);
    continue;
  }
  console.log(`HTTP ${res.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s\n\nTimeline:`);
  for (const e of data.events) console.log(`  [${e.type}]${e.status === "ERROR" ? " (error)" : ""} ${e.description}`);
  const r = data.report;
  console.log(`\nTools executed (${r.tool_calls.length}):`);
  for (const c of r.tool_calls) console.log(`  round ${c.round}: ${c.tool}(${JSON.stringify(c.args)}) -> ${c.result_summary}`);
  console.log(`\nSeverity: ${r.severity}   Status: ${r.investigation_status}   Model: ${r.model}`);
  console.log(`Summary: ${r.summary}`);
  console.log(`\nHypotheses:`);
  for (const h of r.hypotheses) {
    console.log(`  - ${h.description}`);
    for (const e of h.supporting_evidence) console.log(`      + ${e}`);
    for (const e of h.contradicting_evidence) console.log(`      - ${e}`);
    for (const e of h.missing_evidence) console.log(`      ? ${e}`);
  }
  console.log(`\nRecommended next inspection:`);
  for (const n of r.recommended_next_inspection) console.log(`  * ${n}`);
}

server?.close();
