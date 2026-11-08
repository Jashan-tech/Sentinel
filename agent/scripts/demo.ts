/**
 * Live demo: POSTs scenarios to the real /investigate endpoint (real Nemotron calls, no mocks).
 * Starts the server in-process on a random port unless AGENT_URL is set.
 *   npm run demo                      # multi-agent: A normal, C critical, D stale, E contradictory
 *   npm run demo -- c-critical b      # pick scenarios by fixture prefix (b2-profile = profile demo)
 *   npm run demo -- --single          # original single-agent engine
 */
import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/model.js";

const fixturesDir = new URL("../src/fixtures/", import.meta.url);
const load = (key: string) => JSON.parse(readFileSync(new URL(`${key}.json`, fixturesDir), "utf8"));

const scenarios: { key: string; name: string; body: any }[] = readdirSync(fixturesDir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => {
    const key = f.replace(/\.json$/, "");
    const body = load(key);
    return { key, name: body._scenario ?? key, body };
  });
const b = load("b-elevated");
scenarios.push({
  key: "b2-profile",
  name: "B2 - Same readings as B, Standard Network profile (SIMULATED)",
  body: { ...b, rack_id: "rack-net-02", rack_name: "Network Rack B2", equipment_type: "Network", active_alerts: [], profile: { name: "Standard Network Rack (demo)", temperature_warning_c: 32, temperature_critical_c: 38, humidity_warning_percent: 65 } },
});

const args = process.argv.slice(2);
const single = args.includes("--single");
// --image <file in test-assets/vision> attaches a real reference photo (with manifest provenance).
const imageArg = args.includes("--image") ? args[args.indexOf("--image") + 1] : undefined;
const visualOnly = args.includes("--visual-only");
const filter = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--image").map((a) => a.toLowerCase());
let imagePayload: any;
if (imageArg) {
  const manifest = JSON.parse(readFileSync(new URL("../test-assets/vision/manifest.json", import.meta.url), "utf8"));
  const m = manifest.images.find((x: any) => x.file === imageArg);
  if (!m) throw new Error(`${imageArg} is not in test-assets/vision/manifest.json`);
  imagePayload = {
    image_id: m.image_id,
    filename: m.file,
    mime_type: "image/jpeg",
    data_base64: readFileSync(new URL(`../test-assets/vision/${m.file}`, import.meta.url)).toString("base64"),
    source_type: "ONLINE_REFERENCE",
    capture_timestamp: null,
    source_url: m.source_page,
    attribution: m.creator,
    license: m.license,
  };
}
const defaults = ["a-normal", "c-critical", "d-stale", "e-contradictory"];
const selected = scenarios.filter((s) => (filter.length ? filter.some((f) => s.key.startsWith(f)) : defaults.includes(s.key)));

try {
  loadConfig();
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
const list = (label: string, items: string[] | undefined, indent = "  ") => {
  if (items?.length) {
    console.log(`${indent}${label}:`);
    for (const i of items) console.log(`${indent}  - ${i}`);
  }
};

for (const s of selected) {
  console.log(`\n${line}\nSCENARIO: ${s.name}  [${single ? "single-agent" : "multi-agent"}]\n${line}`);
  const t0 = Date.now();
  const res = await fetch(`${baseUrl}/investigate${single ? "?mode=single" : ""}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      imagePayload
        ? { ...s.body, images: [imagePayload], inspection_mode: visualOnly ? "VISUAL" : "COMBINED", ...(visualOnly ? { current_telemetry: [], recent_telemetry: [], active_alerts: [] } : {}) }
        : s.body,
    ),
  });
  const data: any = await res.json();
  if (!data.report) {
    console.log(`HTTP ${res.status}:`, data);
    continue;
  }
  const r = data.report;
  console.log(`HTTP ${res.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s\n\nTimeline:`);
  for (const e of data.events) console.log(`  [${e.type}]${e.status === "ERROR" ? " (error)" : ""} ${e.description}`);

  if (r.agents_invoked) {
    console.log(`\nSupervisor plan: ${r.supervisor_plan}`);
    console.log(`Agents invoked: ${r.agents_invoked.map((a: any) => `${a.agent}[${a.status}]`).join(" -> ") || "none"}`);
    for (const f of r.specialist_findings) {
      console.log(`\n  ${f.agent.toUpperCase()} findings (${f.tools_executed.length} tool calls, ${f.status}):`);
      list("observations", f.observations, "    ");
      list("hypotheses", f.hypotheses.map((h: any) => h.description), "    ");
      list("missing", f.missing_information, "    ");
    }
    for (const img of r.evidence?.images ?? [])
      console.log(`\n  IMAGE ${img.image_id}: ${img.filename} ${img.width}x${img.height} ${img.source_type} sha256=${img.sha256.slice(0, 16)}… license=${img.license} by ${img.attribution} capture=${img.capture_timestamp ?? "unknown"}`);
    for (const v of r.visual_findings ?? [])
      console.log(`    [${v.certainty}/${v.category}] ${v.observation} @ ${v.image_location}${v.potential_concern ? ` | concern: ${v.potential_concern}` : ""}${v.limitations ? ` | limits: ${v.limitations}` : ""}`);
    if (r.verification) {
      const v = r.verification;
      console.log(`\n  VERIFICATION (grounded=${v.grounded}, ${v.tools_executed.length} tool calls):`);
      list("verified", v.verified_findings, "    ");
      list("unsupported", v.unsupported_claims, "    ");
      list("contradictions", v.contradictions, "    ");
      if (v.request_more_investigation) console.log(`    follow-up requested: ${v.follow_up_agent}: ${v.follow_up_objective}`);
    }
  }
  console.log(`\nTools executed (${r.tool_calls.length}):`);
  for (const c of r.tool_calls) console.log(`  ${c.agent ? `${c.agent}/` : ""}r${c.round}: ${c.tool}(${JSON.stringify(c.args)}) -> ${c.result_summary}`);
  console.log(`\nSEVERITY: ${r.severity}   STATUS: ${r.investigation_status}${r.limits_reached?.length ? `   LIMITS: ${r.limits_reached.join(", ")}` : ""}`);
  console.log(`Model: ${r.model}\nSummary: ${r.summary}`);
  console.log("Hypotheses:");
  for (const h of r.hypotheses) {
    console.log(`  - ${h.description}`);
    for (const e of h.supporting_evidence) console.log(`      + ${e}`);
    for (const e of h.contradicting_evidence) console.log(`      - ${e}`);
    for (const e of h.missing_evidence) console.log(`      ? ${e}`);
  }
  list("Verified findings", r.verified_findings, "");
  list("Missing information", r.missing_information, "");
  list("Recommended next inspection", r.recommended_next_inspection, "");
}
server?.close();
