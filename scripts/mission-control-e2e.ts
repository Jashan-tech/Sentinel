/** Mission Control integration. Real SpacetimeDB + HTTP/LangGraph + independent Edge sessions.
 * Default: scripted models. --live: one real NVIDIA investigation, loading agent/.env locally.
 * All writes target sentinel-verification; state fixtures are explicitly labelled UI TEST FIXTURE.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, expect, type Page } from "@playwright/test";
import { Timestamp } from "spacetimedb";
import { createApp } from "../agent/src/app.js";
import { createModel, loadConfig } from "../agent/src/model.js";
import { createSpacetimeStore } from "../agent/src/persistence.js";
import { registerAgent } from "./register-agent.mjs";
import {
  fakeModel,
  testConfig,
  toolCall,
  jsonMessage as j,
} from "../agent/tests/helpers.js";
import { DbConnection } from "../dashboard/src/module_bindings/index.js";
import { VERIFICATION_LABEL } from "../dashboard/src/investigation.js";
const live = process.argv.includes("--live");
const replay = process.argv
  .find((arg) => arg.startsWith("--replay="))
  ?.slice(9);
if (replay && !/^[a-f0-9-]{36}$/.test(replay))
  throw new Error("Invalid replay investigation ID");
if (live)
  process.loadEnvFile(fileURLToPath(new URL("../agent/.env", import.meta.url)));
const database = process.env.MISSION_TEST_DATABASE ?? "sentinel-verification";
if (!/^sentinel-[a-z0-9-]*verification$/.test(database))
  throw new Error(
    "Mission-control tests require an isolated verification database",
  );
const base = "http://127.0.0.1:5176";
const agentIdentity = await registerAgent({
  database,
  label: "mission-control-e2e",
});
const store = createSpacetimeStore({
  url: "http://127.0.0.1:3000",
  database,
  token: agentIdentity.token,
});
let serviceCalls = 0;
const app = createApp({
  store,
  getModel: () => {
    serviceCalls++;
    if (live) {
      const config = loadConfig();
      return {
        config,
        model: createModel(config) as any,
        specialistModel: createModel(config, config.specialistModel) as any,
        visionModel: createModel(config, config.visionModel) as any,
      };
    }
    const supervisor = fakeModel([
      j({
        next: "telemetry",
        plan: "Inspect environmental observations, then verify.",
        objective: "Read current environment",
        reason: "Threshold breach",
      }),
      j({
        next: "verification",
        objective: "Review source evidence",
        reason: "Check grounding",
      }),
      j({ next: "finish", objective: "", reason: "Evidence reviewed" }),
      j({
        severity: "CRITICAL",
        summary:
          "SCRIPTED MODEL TEST: simulated ambient temperature exceeds this demonstration profile’s configured threshold. No equipment fault is established.",
        hypotheses: [],
        recommended_next_inspection: [
          "Inspect cooling and airflow conditions; confirm sensor placement.",
        ],
        verified_findings: [],
        missing_information: ["Physical equipment inspection"],
      }),
    ]);
    const invokeSupervisor = supervisor.model.invoke.bind(supervisor.model);
    supervisor.model.invoke = async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return invokeSupervisor(...args);
    };
    const specialist = fakeModel([
      toolCall("get_current_telemetry", { rack_id: "rack-1" }),
      j({
        observations: [
          "Explicitly simulated environmental observations were retrieved.",
        ],
        hypotheses: [],
        missing_information: ["Physical evidence"],
        recommended_next_action: "Review observations",
      }),
      toolCall("get_current_telemetry", { rack_id: "rack-1" }),
      j({
        grounded: false,
        verified_findings: [],
        unsupported_claims: ["A confirmed equipment fault is not established"],
        contradictions: [],
        missing_evidence: ["Physical inspection"],
        request_more_investigation: false,
      }),
    ]);
    return {
      model: supervisor.model,
      specialistModel: specialist.model,
      config: testConfig,
    };
  },
});
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.on("listening", r));
const vite = spawn(
  process.execPath,
  [
    fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url)),
    "--host",
    "127.0.0.1",
    "--port",
    "5176",
    "--strictPort",
  ],
  {
    cwd: fileURLToPath(new URL("../dashboard/", import.meta.url)),
    env: {
      ...process.env,
      VITE_SPACETIME_DATABASE: database,
      AGENT_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    },
    stdio: "pipe",
    windowsHide: true,
  },
);
let viteLogs = "";
vite.stdout?.on("data", (b) => (viteLogs += b));
vite.stderr?.on("data", (b) => (viteLogs += b));
let db: DbConnection | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let activePage: Page | undefined;
let activeInvestigation: string | undefined;
const source = `mission-control-test-${Date.now()}`;
const output = fileURLToPath(
  new URL("../test-results/mission-control/", import.meta.url),
);
mkdirSync(output, { recursive: true });
async function sql(query: string) {
  const response = await fetch(
    `http://127.0.0.1:3000/v1/database/${database}/sql`,
    { method: "POST", body: query },
  );
  assert(response.ok, `Database SQL returned ${response.status}`);
  return (await response.json()) as { rows: any[][] }[];
}
try {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(base)).ok) break;
    } catch {}
    if (i === 49) throw Error(`Vite startup failed: ${viteLogs}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  db = await new Promise<DbConnection>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(Error("Database connection timed out")),
      10000,
    );
    DbConnection.builder()
      .withUri("ws://127.0.0.1:3000")
      .withDatabaseName(database)
      .onConnect((c) => {
        clearTimeout(timeout);
        resolve(c);
      })
      .onConnectError((_c, e) => {
        clearTimeout(timeout);
        reject(e);
      })
      .build();
  });
  await db.reducers.changeRackProfile({
    rackId: "rack-1",
    profileId: "standard",
  });
  for (const [metricType, numericValue, unit] of [
    ["AMBIENT_TEMPERATURE_C", 20, "°C"],
    ["RELATIVE_HUMIDITY_PERCENT", 45, "%RH"],
    ["SOUND_RAW", 100, "raw"],
    ["ULTRASONIC_DISTANCE_CM", 42, "cm"],
  ] as const)
    await db.reducers.ingestSimulatedObservation({
      rackId: "rack-1",
      metricType,
      numericValue,
      unit,
      sourceType: "SIMULATOR",
      sourceIdentifier: source,
      observedAt: new Timestamp(BigInt(Date.now()) * 1000n),
    });
  browser = await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL ?? "msedge", headless: true });
  const [ca, cb] = await Promise.all([
    browser.newContext({ viewport: { width: 1440, height: 1000 } }),
    browser.newContext({ viewport: { width: 1440, height: 1000 } }),
  ]);
  const [a, b] = await Promise.all([ca.newPage(), cb.newPage()]);
  activePage = a;
  const errors: string[] = [];
  for (const p of [a, b]) {
    p.on("pageerror", (e) => errors.push(e.message));
    await p.addInitScript(() => {
      const Native = window.WebSocket;
      const sockets: WebSocket[] = [];
      Object.defineProperty(window, "__testSockets", { value: sockets });
      window.WebSocket = class extends Native {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          sockets.push(this);
        }
      };
    });
  }
  await Promise.all([a.goto(base), b.goto(base)]);
  for (const p of [a, b])
    await expect(p.locator(".connection")).toHaveText("Connected");
  await expect(a.locator(".telemetry-row")).toHaveCount(3);
  await expect(a.getByTestId("AMBIENT_TEMPERATURE_C")).toContainText(
    "Simulated",
  );
  await expect(
    a.getByRole("button", { name: "Live", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(a.locator(".simulation-editor")).toHaveCount(0);
  await a.getByTestId("rack-option-rack-3").click();
  await expect(a.getByTestId("AMBIENT_TEMPERATURE_C")).toContainText(
    "Unavailable",
  );
  await expect(a.getByTestId("investigation-panel")).toContainText(
    "No investigation has been recorded",
  );
  await a.screenshot({
    path: output + "mission-control-empty.png",
    fullPage: true,
  });
  await a.getByTestId("rack-option-rack-1").click();
  await a.getByRole("button", { name: "Simulation", exact: true }).click();
  await a
    .getByLabel("Ambient temperature slider", { exact: true })
    .fill("41.5");
  await expect(b.getByTestId("AMBIENT_TEMPERATURE_C")).toContainText("20");
  await a
    .getByRole("button", { name: "Apply Ambient temperature", exact: true })
    .click();
  await expect(
    a.getByRole("status").filter({ hasText: "Committed by SpacetimeDB" }),
  ).toBeVisible();
  await expect(b.getByTestId("AMBIENT_TEMPERATURE_C")).toContainText("41.5");
  await expect(b.getByTestId("rack-status")).toHaveClass(/critical/);
  await a.getByLabel("Server profile").selectOption("dell-poweredge-r760");
  await expect(b.getByLabel("Server profile")).toHaveValue(
    "dell-poweredge-r760",
  );
  await expect(b.getByTestId("rack-status")).toHaveClass(/warning/);
  await a.getByLabel("Server profile").selectOption("cisco-ucs-c220-m7");
  await expect(b.getByTestId("rack-status")).toHaveClass(/critical/);
  await a.getByLabel("Relative humidity", { exact: true }).fill("85");
  await a
    .getByRole("button", { name: "Apply Relative humidity", exact: true })
    .click();
  await expect(b.getByTestId("RELATIVE_HUMIDITY_PERCENT")).toContainText("85");
  await a.getByLabel("Sound intensity", { exact: true }).fill("-1");
  assert.equal(
    await a
      .getByLabel("Sound intensity", { exact: true })
      .evaluate((el: HTMLInputElement) => el.checkValidity()),
    false,
  );
  await a
    .getByRole("button", { name: "Apply Sound intensity", exact: true })
    .click();
  await expect(b.getByTestId("SOUND_RAW")).toContainText("100");
  await a.getByLabel("Sound intensity", { exact: true }).fill("250");
  await a
    .getByRole("button", { name: "Apply Sound intensity", exact: true })
    .click();
  await expect(b.getByTestId("SOUND_RAW")).toContainText("250");
  await b.clock.install();
  await b.clock.setSystemTime(new Date(Date.now() + 61000));
  await expect(b.getByTestId("AMBIENT_TEMPERATURE_C")).toContainText("Stale", {
    timeout: 5000,
  });
  await b.clock.setSystemTime(new Date());
  await db.reducers.ingestSimulatedObservation({
    rackId: "rack-1",
    metricType: "ULTRASONIC_DISTANCE_CM",
    numericValue: 3,
    unit: "cm",
    sourceType: "SIMULATOR",
    sourceIdentifier: source,
    observedAt: new Timestamp(BigInt(Date.now()) * 1000n),
  });
  await expect(b.getByTestId("rover-safety")).toContainText("3");
  await expect(b.getByTestId("rover-safety")).toContainText(
    "Controller not connected",
  );
  await expect(b.getByTestId("rack-status")).toHaveClass(/critical/);
  await a.getByLabel("Issues only").check();
  await expect(a.getByTestId("rack-option-rack-1")).toHaveAttribute("aria-current", "true");
  await a.getByLabel("Issues only").uncheck();
  assert.equal(
    serviceCalls,
    0,
    "No inference on sliders or profile dropdown changes",
  );
  console.log(
    "PASS subscribed values, explicit simulation edits, invalid input, profiles/alerts, missing telemetry, safety isolation, freshness and issue filter",
  );
  if (live) {
    const manifest = JSON.parse(
      readFileSync(
        new URL("../agent/test-assets/vision/manifest.json", import.meta.url),
        "utf8",
      ),
    );
    const photo = manifest.images.find(
      (p: any) => p.file === "switch-5port-led-closeup.jpg",
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
    await expect(a.getByTestId("vision-upload")).toContainText(
      photo.sha256.slice(0, 16),
    );
  }
  const record = a.getByTestId("investigation-record");
  let id: string;
  if (replay) {
    id = replay;
    await expect(record).toHaveAttribute("data-id", id);
    console.log(
      "Replaying a persisted report; no model inference is being requested",
    );
  } else {
    console.log(
      live
        ? "Starting one LIVE NVIDIA combined investigation"
        : "Starting SCRIPTED MODEL HTTP/LangGraph investigation",
    );
    const previous = await record.getAttribute("data-id").catch(() => null);
    await a
      .getByRole("button", { name: "Run Investigation", exact: true })
      .click();
    await expect(record).not.toHaveAttribute("data-id", previous ?? "");
    id = (await record.getAttribute("data-id"))!;
    activeInvestigation = id;
    await expect(record).toHaveAttribute("data-status", "RUNNING");
    await expect(
      a.locator(".investigation-actions .primary-button"),
    ).toBeDisabled();
    await expect(b.getByTestId("investigation-record")).toHaveAttribute(
      "data-id",
      id,
    );
    await expect(record).not.toHaveAttribute("data-status", "RUNNING", {
      timeout: 170000,
    });
  }
  activeInvestigation = undefined;
  const status = await record.getAttribute("data-status");
  assert(
    ["COMPLETED", "INCOMPLETE"].includes(status ?? ""),
    `Investigation ended as ${status}: ${await record.innerText()}`,
  );
  await expect(b.getByTestId("investigation-record")).toHaveAttribute(
    "data-status",
    status!,
  );
  await expect(record.getByTestId("recorded-by")).toHaveAttribute(
    "data-kind",
    "AGENT",
  );
  const stored = await sql(
    `SELECT snapshot_json, report_json FROM investigation WHERE investigation_id = '${id}'`,
  );
  const snapshot = JSON.parse(stored[0].rows[0][0]);
  const report = JSON.parse(stored[0].rows[0][1]);
  assert(
    !snapshot.current_telemetry.some(
      (r: any) => r.metric_type === "ULTRASONIC_DISTANCE_CM",
    ),
  );
  assert(
    !snapshot.recent_telemetry.some(
      (r: any) => r.metric_type === "ULTRASONIC_DISTANCE_CM",
    ),
  );
  assert(
    !report.evidence.trends.some(
      (r: any) => r.metric_type === "ULTRASONIC_DISTANCE_CM",
    ),
  );
  assert(
    !report.evidence.early_warning_indicators.some(
      (r: any) => r.metric === "ULTRASONIC_DISTANCE_CM",
    ),
  );
  assert.equal(report.severity, "CRITICAL");
  if (!live && !replay)
    await expect(record.getByTestId("verification-status")).toHaveText(
      VERIFICATION_LABEL.NOT_GROUNDED,
    );
  if (live || replay) {
    assert(
      report.agents_invoked.some((r: any) => r.agent === "vision"),
      "Live Vision was invoked",
    );
    const vision = report.agents_invoked.find((r: any) => r.agent === "vision");
    if (!report.visual_findings.length) {
      assert(["INCOMPLETE", "FAILED"].includes(vision.status));
      await expect(record.getByTestId("partial-agent-warning")).toBeVisible();
      await expect(record.locator(".review-passed")).toHaveCount(0);
      console.log(
        "DEGRADED VISION: model returned no valid visual findings; UI exposes incomplete agent evidence",
      );
    }
    console.log(
      JSON.stringify({
        investigation: id,
        status,
        visionStatus: vision.status,
        visualFindings: report.visual_findings.length,
        verificationStatus: report.verification?.status,
      }),
    );
    assert(report.evidence.images[0].sha256);
  }
  await expect(record.locator(".report-details-content")).not.toBeVisible();
  await record.getByText("View Investigation Details", { exact: true }).click();
  await expect(record.locator(".agent-roster")).toContainText("Supervisor");
  await record.getByText("View Investigation Details", { exact: true }).click();
  await a.getByRole("button", { name: "Live", exact: true }).click();
  if (live)
    await a.getByRole("button", { name: "Upload Photo", exact: true }).click();
  await a.screenshot({
    path: output + "mission-control-desktop.png",
    fullPage: true,
  });
  for (const width of [320, 390, 768]) {
    await a.setViewportSize({ width, height: 900 });
    assert(
      await a.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      `Rack view overflow at ${width}`,
    );
    if (width === 390)
      await a.screenshot({
        path: output + "mission-control-mobile.png",
        fullPage: true,
      });
  }
  await a
    .getByRole("button", { name: "Fleet Simulation", exact: true })
    .click();
  await expect(
    a.getByRole("heading", { name: "Fleet Simulation", exact: true }),
  ).toBeVisible();
  // Fleet benchmark contract: the target is configuration, never a measurement; the achieved
  // rate is "Not measured" unless a run is active (measured results come from benchmark rows).
  await a.getByRole("radio", { name: "Fixed Load" }).click();
  await a.getByLabel("Rover count", { exact: true }).selectOption("5000");
  await a.getByLabel("Events per rover per second", { exact: true }).selectOption("5");
  await expect(a.getByTestId("target-rate")).toContainText("25,000");
  if ((await a.getByTestId("bench-state").getAttribute("data-state")) !== "Running")
    await expect(a.getByTestId("achieved-rate")).toHaveText("Not measured");
  await expect(a.getByRole("button", { name: /Start Fixed Load/ })).toBeVisible();
  await expect(a.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await expect(a.getByTestId("bench-metrics").locator("[data-metric]")).toHaveCount(6);
  await expect(a.locator(".telemetry-card")).toHaveCount(0);
  await a.setViewportSize({ width: 1440, height: 1000 });
  await a.screenshot({ path: output + "fleet-desktop.png", fullPage: true });
  await a.setViewportSize({ width: 390, height: 844 });
  assert(
    await a.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await a.screenshot({ path: output + "fleet-mobile.png", fullPage: true });
  await a.getByRole("button", { name: "Rack Monitor", exact: true }).click();
  await expect(a.getByTestId("investigation-record")).toHaveAttribute(
    "data-id",
    id,
  );
  await a.getByTestId("rack-option-rack-3").click();
  await expect(a.getByTestId("investigation-record")).toHaveCount(0);
  await a.getByTestId("rack-option-rack-1").click();
  await b.reload();
  await expect(b.getByTestId("investigation-record")).toHaveAttribute(
    "data-id",
    id,
  );
  console.log(
    `PASS ${replay ? "persisted report replay (no inference)" : live ? "LIVE NVIDIA" : "scripted model"} investigation ${id}: ${status}, persisted result, safety exclusion, browser synchronization, reload, rack switching, mobile and fleet contract`,
  );
  // Explicit synthetic UI-state fixtures are isolated to the verification database.
  for (const v of [
    { status: "INCOMPLETE", grounded: true, label: "Verification incomplete" },
    {
      status: "COMPLETED",
      grounded: false,
      label: VERIFICATION_LABEL.NOT_GROUNDED,
    },
  ]) {
    const fixtureId = randomUUID();
    await db.reducers.startInvestigation({
      investigationId: fixtureId,
      rackId: "rack-1",
      snapshotJson: JSON.stringify({
        rack_id: "rack-1",
        note: "UI TEST FIXTURE",
      }),
    });
    const fixtureReport = {
      ...report,
      summary: "UI TEST FIXTURE: review state rendering only.",
      verification: {
        ...report.verification,
        status: v.status,
        grounded: v.grounded,
        unsupported_claims: [],
        contradictions: [],
        request_more_investigation: false,
      },
      investigation_status: "INCOMPLETE",
      verification_outcome:
        v.status === "INCOMPLETE" ? "INCOMPLETE" : "NOT_GROUNDED",
      incomplete_reasons: [
        "UI TEST FIXTURE: review is incomplete or ungrounded",
      ],
      verified_findings: [],
    };
    await store.complete(
      fixtureId,
      "INCOMPLETE",
      fixtureReport.severity,
      JSON.stringify(fixtureReport),
      "[]",
    );
    await expect(a.getByTestId("investigation-record")).toHaveAttribute(
      "data-id",
      fixtureId,
    );
    await expect(a.getByTestId("verification-status")).toHaveText(v.label);
    await expect(a.locator(".review-passed")).toHaveCount(0);
  }
  await a.route("**/api/agent/investigate", (r) =>
    r.abort("connectionrefused"),
  );
  await a
    .getByRole("button", { name: "Run Investigation", exact: true })
    .click();
  await expect(a.getByTestId("investigation-record")).toHaveAttribute(
    "data-status",
    "FAILED",
    { timeout: 15000 },
  );
  await expect(a.getByTestId("investigation-record")).toHaveAttribute(
    "data-severity",
    "UNKNOWN",
  );
  await expect(a.getByTestId("investigation-record")).toContainText(
    "Investigation failed",
  );
  await expect(b.getByTestId("investigation-record")).toHaveAttribute(
    "data-status",
    "FAILED",
  );
  await cb.setOffline(true);
  await b.evaluate(() =>
    (window as unknown as { __testSockets: WebSocket[] }).__testSockets.forEach(
      (s) => s.close(),
    ),
  );
  await expect(b.locator(".connection")).toHaveText(/Disconnected|Error/, {
    timeout: 15000,
  });
  await expect(
    b.getByRole("button", { name: "Run Investigation", exact: true }),
  ).toBeDisabled();
  await cb.setOffline(false);
  await b.reload();
  await expect(b.locator(".connection")).toHaveText("Connected");
  assert.equal(
    serviceCalls,
    replay ? 0 : 1,
    "Only the explicit successful investigation reached the model service",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS incomplete/ungrounded review display, failed-request persistence, duplicate guard, disconnected controls, reconnect and no browser exceptions",
  );
} finally {
  // Keep the creator browser alive long enough to persist an in-flight real result,
  // even when a later test assertion fails. Never retry inference automatically.
  if (live && activePage && activeInvestigation)
    await expect(activePage.locator(`[data-id="${activeInvestigation}"]`))
      .not.toHaveAttribute("data-status", "RUNNING", { timeout: 170000 })
      .catch(() => {});
  db?.disconnect();
  await browser?.close();
  vite.kill();
  server.close();
  server.closeAllConnections();
}
