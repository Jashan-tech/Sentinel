/** Real SpacetimeDB + two browsers + actual agent HTTP/LangGraph, with explicitly SCRIPTED model responses.
 * No NVIDIA calls or fake database. Writes only to sentinel-verification / rack-1.
 * Run from root: npm run test:equipment-e2e
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync, mkdirSync } from "node:fs";
import { chromium, expect } from "@playwright/test";
import { Timestamp } from "spacetimedb";
import { createApp } from "../agent/src/app.js";
import { createSpacetimeStore } from "../agent/src/persistence.js";
import { registerAgent } from "./register-agent.mjs";
import {
  fakeModel,
  testConfig,
  toolCall,
  jsonMessage as j,
} from "../agent/tests/helpers.js";
import { DbConnection } from "../dashboard/src/module_bindings/index.js";
const root = fileURLToPath(new URL("../", import.meta.url));
const base = "http://127.0.0.1:5175";
const source = `feature5-e2e-${Date.now()}`;
const decision = (next: string) =>
  j({
    plan: "Use deterministic trends and exact documentation, inspect the reference photograph, then verify.",
    next,
    objective: `${next} evidence`,
    reason: "Investigate observed early warning",
  });
const finding = j({
  observations: [
    "Simulated readings only; deterministic trends describe the observed period.",
  ],
  hypotheses: [],
  missing_information: ["Physical context"],
  recommended_next_action: "Repeat environmental inspection",
});
const verdict = j({
  grounded: true,
  verified_findings: ["Tool-calculated evidence only"],
  unsupported_claims: ["Reference image identifies the selected rack"],
  contradictions: [],
  missing_evidence: ["Actual rack image"],
  request_more_investigation: false,
});
let serviceCalls = 0;
// Reports are recorded by the agent service under its own authorized identity (issue 5).
const agentIdentity = await registerAgent({ database: "sentinel-verification", label: "equipment-e2e" });
const app = createApp({
  store: createSpacetimeStore({ url: "http://127.0.0.1:3000", database: "sentinel-verification", token: agentIdentity.token }),
  getModel: () => {
    serviceCalls++;
    const supervisor = fakeModel([
      decision("telemetry"),
      decision("documentation"),
      decision("vision"),
      decision("verification"),
      decision("finish"),
      j({
        severity: "NORMAL",
        summary:
          "SCRIPTED MODEL TEST: simulated readings increased during the observed window. No equipment fault is established; reference imagery does not identify the selected rack.",
        hypotheses: [],
        recommended_next_inspection: ["Verify sensor placement"],
        verified_findings: ["Tool-calculated evidence only"],
        missing_information: ["Physical verification"],
      }),
    ]);
    const tools = fakeModel([
      toolCall("analyze_telemetry_trends", {
        rack_id: "rack-1",
        metric_type: "AMBIENT_TEMPERATURE_C",
        source_identifier: source,
      }),
      toolCall("get_early_warning_indicators", {
        rack_id: "rack-1",
        metric_type: "AMBIENT_TEMPERATURE_C",
        source_identifier: source,
      }),
      finding,
      toolCall("lookup_equipment_documentation", { equipment_type: "Network" }),
      finding,
    ]);
    const vision = fakeModel([
      j({
        visual_findings: [
          {
            observation:
              "Reference equipment is visible; it does not identify the installed rack equipment.",
            component: "switch",
            image_location: "center",
            category: "EQUIPMENT",
            visual_evidence: "Online reference photograph",
            certainty: "UNCERTAIN",
            potential_concern: null,
            limitations: "Online reference, not captured by SENTINEL",
            recommended_follow_up: "Get an actual rack photograph",
          },
        ],
        unreadable_regions: [],
        additional_photos_needed: ["Actual rack"],
        hypotheses: [],
        missing_information: ["Actual rack appearance"],
        recommended_next_action: "Verify",
      }),
      toolCall("lookup_equipment_documentation", { equipment_type: "Network" }),
      verdict,
    ]);
    return {
      model: supervisor.model,
      specialistModel: tools.model,
      visionModel: vision.model,
      config: { ...testConfig, maxOutputTokens: 2048 },
    };
  },
});
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.on("listening", resolve));
const address = server.address() as { port: number };
const vite = spawn(
  process.execPath,
  [
    fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url)),
    "--host",
    "127.0.0.1",
    "--port",
    "5175",
    "--strictPort",
  ],
  {
    cwd: fileURLToPath(new URL("../dashboard/", import.meta.url)),
    env: {
      ...process.env,
      VITE_SPACETIME_DATABASE: "sentinel-verification",
      AGENT_URL: `http://127.0.0.1:${address.port}`,
    },
    stdio: "pipe",
    windowsHide: true,
  },
);
let logs = "";
vite.stdout?.on("data", (b) => (logs += b));
vite.stderr?.on("data", (b) => (logs += b));
let db: DbConnection | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  for (let n = 0; n < 40; n++) {
    try {
      if ((await fetch(base)).ok) break;
    } catch {}
    if (n === 39) throw new Error(`Vite did not start: ${logs}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  db = await new Promise<DbConnection>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Spacetime connection timeout")),
      10000,
    );
    DbConnection.builder()
      .withUri("ws://127.0.0.1:3000")
      .withDatabaseName("sentinel-verification")
      .onConnect((c) => {
        clearTimeout(timer);
        resolve(c);
      })
      .onConnectError((_c, e) => {
        clearTimeout(timer);
        reject(e);
      })
      .build();
  });
  await db.reducers.changeRackProfile({
    rackId: "rack-1",
    profileId: "standard",
  });
  const now = Date.now();
  for (const [offset, value] of [
    [-120000, 25],
    [-60000, 26],
    [0, 27],
  ])
    await db.reducers.ingestSimulatedObservation({
      rackId: "rack-1",
      metricType: "AMBIENT_TEMPERATURE_C",
      numericValue: value,
      unit: "°C",
      sourceType: "SIMULATOR",
      sourceIdentifier: source,
      observedAt: new Timestamp(BigInt(now + offset) * 1000n),
    });
  browser = await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL ?? "msedge", headless: true });
  const [ca, cb] = await Promise.all([
    browser.newContext({ viewport: { width: 1440, height: 1100 } }),
    browser.newContext(),
  ]);
  const [a, b] = await Promise.all([ca.newPage(), cb.newPage()]);
  const errors: string[] = [];
  for (const p of [a, b]) p.on("pageerror", (e) => errors.push(e.message));
  await Promise.all([a.goto(base), b.goto(base)]);
  for (const p of [a, b])
    await expect(p.locator(".connection")).toHaveText("Connected");
  const manifest = JSON.parse(
    readFileSync(
      new URL("../agent/test-assets/vision/manifest.json", import.meta.url),
      "utf8",
    ),
  );
  const photo = manifest.images.find(
    (i: any) => i.file === "switch-5port-led-closeup.jpg",
  );
  await a.getByRole("button", { name: "Upload Photo", exact: true }).click();
  await a
    .getByLabel("Image source", { exact: true })
    .selectOption("ONLINE_REFERENCE");
  await a.getByLabel("Source page URL").fill(photo.source_page);
  await a.getByLabel("Attribution", { exact: true }).fill(photo.creator);
  await a.getByLabel("License", { exact: true }).fill(photo.license);
  await a
    .getByLabel("Inspection photo")
    .setInputFiles(
      fileURLToPath(
        new URL(`../agent/test-assets/vision/${photo.file}`, import.meta.url),
      ),
    );
  // Unknown identity: an actual reference photo cannot silently turn into rack identity.
  await a.getByRole("button", { name: "Run Visual Inspection" }).click();
  await expect(a.getByTestId("investigation-record")).toHaveAttribute(
    "data-status",
    "COMPLETED",
    { timeout: 30000 },
  );
  let record = a.getByTestId("investigation-record");
  await record.getByText("View Investigation Details", { exact: true }).click();
  await b
    .getByTestId("investigation-record")
    .getByText("View Investigation Details", { exact: true })
    .click();
  const firstId = (await record.getAttribute("data-id"))!;
  await expect(record.getByTestId("equipment-evidence")).toContainText(
    "NO_MATCH",
  );
  await expect(record.getByTestId("equipment-evidence")).toContainText(
    "Equipment identity unknown",
  );
  await expect(record.getByTestId("early-warning-indicators")).toContainText(
    "EARLY_WARNING_TREND",
  );
  await expect(
    b.locator(`[data-id="${firstId}"]`).getByTestId("equipment-evidence"),
  ).toContainText("NO_MATCH");
  // Explicit installed identity gates the next investigation's references.
  await a.locator(".identity-settings > summary").click();
  await a.getByLabel("Equipment manufacturer").fill("Cisco");
  await a.getByLabel("Equipment model").fill("C9300-24T");
  await expect(
    a.getByRole("button", { name: "Run Visual Inspection" }),
  ).toBeDisabled();
  await a.getByLabel("Confirm installed equipment identity").check();
  await a.getByRole("button", { name: "Run Visual Inspection" }).click();
  await expect(record).not.toHaveAttribute("data-id", firstId);
  await expect(record).toHaveAttribute("data-status", "COMPLETED", {
    timeout: 30000,
  });
  const id = (await record.getAttribute("data-id"))!;
  await expect(record.getByTestId("equipment-evidence")).toContainText(
    "CISCO-C9300-LED",
  );
  await expect(
    b.locator(`[data-id="${id}"]`).getByTestId("equipment-evidence"),
  ).toContainText("CISCO-C9300-LED");
  await b.reload();
  await b
    .getByTestId("investigation-record")
    .getByText("View Investigation Details", { exact: true })
    .click();
  await expect(
    b.locator(`[data-id="${id}"]`).getByTestId("equipment-evidence"),
  ).toContainText("OPERATOR PROVIDED");
  const sql = await fetch(
    "http://127.0.0.1:3000/v1/database/sentinel-verification/sql",
    {
      method: "POST",
      body: `SELECT snapshot_json, report_json FROM investigation WHERE investigation_id = '${id}'`,
    },
  );
  assert(sql.ok);
  const data = (await sql.json()) as { rows: string[][] }[];
  const snapshot = JSON.parse(data[0].rows[0][0]),
    report = JSON.parse(data[0].rows[0][1]);
  assert.equal(snapshot.equipment_identity.provenance, "OPERATOR_PROVIDED");
  assert.equal(report.evidence.documentation_match.match_status, "MATCH");
  const trend = report.evidence.trends[0].series.find(
    (s: any) => s.source_identifier === source,
  );
  assert.equal(trend.change_per_minute, 1);
  assert.equal(trend.observation_count, 3);
  assert.equal(trend.simulated, true);
  assert.equal(trend.observation_window.observation_ids.length, 3);
  assert.equal(report.evidence.images[0].sha256, photo.sha256);
  assert(!JSON.stringify(report).includes("data:image/"));
  assert.equal(report.verification.status, "COMPLETED");
  mkdirSync(new URL("../test-results", import.meta.url), { recursive: true });
  await a.screenshot({
    path: `${root}/test-results/equipment-desktop.png`,
    fullPage: true,
  });
  await a.setViewportSize({ width: 390, height: 844 });
  assert(
    await a.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await a.screenshot({
    path: `${root}/test-results/equipment-mobile.png`,
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  assert.equal(serviceCalls, 2);
  console.log(
    "PASS Feature 5: actual SpacetimeDB ingestion, agent HTTP/LangGraph tools, real reference image, NO_MATCH and exact operator match, report/snapshot persistence, 2-browser subscription sync, reload, mobile, no browser errors. Model responses were SCRIPTED; NVIDIA inference was not tested.",
  );
} finally {
  db?.disconnect();
  await browser?.close();
  vite.kill();
  server.close();
  server.closeAllConnections();
}
