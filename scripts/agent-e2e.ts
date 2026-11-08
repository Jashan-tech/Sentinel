// End-to-end check of the Feature 1 + Feature 2 integration with LIVE Nemotron calls.
// Prerequisites: SpacetimeDB on :3000 with `sentinel` published, agent on :3001 (NVIDIA key set),
// dashboard on :5173. Uses Rack 01 and the local Google Chrome.
//   npx tsx scripts/agent-e2e.ts
import { chromium, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

const DASH = "http://127.0.0.1:5173";
const SQL = "http://127.0.0.1:3000/v1/database/sentinel/sql";
const OUT = process.env.E2E_OUT ?? "test-results";
const INVESTIGATION_TIMEOUT = 160_000;

type Row = Record<string, any>;
async function sql(query: string): Promise<Row[]> {
  const res = await fetch(SQL, { method: "POST", body: query });
  if (!res.ok) throw new Error(`SQL ${res.status}: ${await res.text()}`);
  const [{ schema, rows }] = (await res.json()) as any[];
  const names = schema.elements.map((e: any) => e.name.some);
  return rows.map((r: unknown[]) =>
    Object.fromEntries(names.map((n: string, i: number) => [n, r[i]])),
  );
}
const log = (step: string, msg: string) => console.log(`[${step}] ${msg}`);

async function connected(p: Page) {
  await p.goto(DASH);
  await expect(
    p.getByRole("status").filter({ hasText: /^Connected$/ }),
  ).toBeVisible();
  await p.getByLabel("Rack selector").selectOption("rack-1");
  await expect(p.getByLabel("Rack selector")).toHaveValue("rack-1");
  await p.getByRole("button", { name: "Simulation", exact: true }).click();
  await p.locator(".simulation-editor .advanced-settings > summary").click();
}
async function applyProfile(p: Page, profileId: string) {
  await p.getByLabel("Server profile").selectOption(profileId);
  await expect(p.getByLabel("Server profile")).toHaveValue(
    profileId,
  );
}
async function submit(p: Page, label: string, value: string) {
  await p.getByLabel(label, { exact: true }).fill(value);
  await p
    .locator("form")
    .filter({ has: p.getByLabel(label, { exact: true }) })
    .getByRole("button", { name: /^Apply / })
    .click();
  await expect(p.getByText("Committed by SpacetimeDB.")).toBeVisible();
}
async function runInvestigation(p: Page, known: Set<string>) {
  await expect(
    p.getByRole("button", { name: "Run Investigation" }),
  ).toBeEnabled();
  await p.getByRole("button", { name: "Run Investigation" }).click();
  const record = p.getByTestId("investigation-record");
  await expect(record).toHaveAttribute("data-id", /.+/);
  await expect
    .poll(async () =>
      known.has((await record.getAttribute("data-id"))!) ? "old" : "new",
    )
    .toBe("new");
  const id = (await record.getAttribute("data-id"))!;
  known.add(id);
  return id;
}
async function waitDone(p: Page, id: string) {
  const record = p.locator(
    `[data-testid="investigation-record"][data-id="${id}"]`,
  );
  await expect(record).not.toHaveAttribute("data-status", "RUNNING", {
    timeout: INVESTIGATION_TIMEOUT,
  });
  return record;
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
const errors: string[] = [];
try {
  mkdirSync(OUT, { recursive: true });
  const [ctxA, ctxB] = await Promise.all(
    [1, 2].map(() =>
      browser.newContext({ viewport: { width: 1440, height: 1400 } }),
    ),
  );
  const [a, b] = await Promise.all([ctxA.newPage(), ctxB.newPage()]);
  for (const p of [a, b]) p.on("pageerror", (e) => errors.push(e.message));
  const known = new Set<string>(
    (await sql("SELECT investigation_id FROM investigation")).map(
      (r) => r.investigation_id,
    ),
  );

  // 1. Services up, two independent sessions connected.
  await Promise.all([connected(a), connected(b)]);
  log(
    "1",
    "SpacetimeDB, dashboard and agent reachable; two browser sessions connected",
  );

  // 2-3. Critical simulated temperature on Rack 01 under the Standard profile (32/40 C) -> CRITICAL alert.
  await applyProfile(a, "cisco-ucs-c220-m7"); // documented critical at 35 °C
  await a.getByLabel("Source identifier").fill("e2e-temp-01");
  await submit(a, "Ambient temperature", "41.5");
  await submit(a, "Relative humidity", "45");
  await expect(b.locator(".alert-item.critical")).toContainText("CRITICAL");
  log(
    "2-3",
    "Submitted 41.5 °C + 45 %RH; CRITICAL alert visible in session B via subscription",
  );

  // 4-5. Run the multi-agent investigation from session A; session B sees it RUNNING, then the result.
  const id1 = await runInvestigation(a, known);
  await expect(
    b.locator(`[data-testid="investigation-record"][data-id="${id1}"]`),
  ).toHaveAttribute("data-status", "RUNNING");
  log("4", `Investigation ${id1} started; session B sees RUNNING`);
  // Live progress written by the agent to SpacetimeDB reaches BOTH sessions while it runs.
  const liveB = b.locator(`[data-testid="investigation-record"][data-id="${id1}"] [data-testid="live-progress"] li`);
  await expect(liveB.first()).toBeVisible({ timeout: 30_000 });
  log("4", `Live progress in session B: "${(await b.locator('[data-testid="live-progress"] .live-phase').first().textContent())?.trim()}" · ${await liveB.count()} step(s)`);
  const t0 = Date.now();
  const recA = await waitDone(a, id1);
  const status1 = await recA.getAttribute("data-status");
  const sev1 = await recA.getAttribute("data-severity");
  log(
    "5",
    `Finished in ${((Date.now() - t0) / 1000).toFixed(1)} s: status ${status1}, severity ${sev1}`,
  );
  expect(["COMPLETED", "INCOMPLETE"]).toContain(status1);
  expect(sev1).toBe("CRITICAL");

  // 6-8. Persisted record in SpacetimeDB: real agents, tools on rack-1 data, specialist findings, verification.
  const [row1] = await sql(
    `SELECT * FROM investigation WHERE investigation_id = '${id1}'`,
  );
  const rep1 = JSON.parse(row1.report_json);
  const ev1 = JSON.parse(row1.events_json);
  const agents = rep1.agents_invoked.map((x: any) => x.agent);
  log("5", `Agents invoked: ${agents.join(" -> ")}; model ${rep1.model}`);
  expect(agents.length).toBeGreaterThanOrEqual(2);
  expect(agents).toContain("verification");
  expect(rep1.tool_calls.length).toBeGreaterThan(0);
  for (const c of rep1.tool_calls)
    if (c.args.rack_id) expect(c.args.rack_id).toBe("rack-1");
  const temp = rep1.evidence.measurements.find(
    (m: any) => m.metric_type === "AMBIENT_TEMPERATURE_C",
  );
  expect(temp).toMatchObject({
    numeric_value: 41.5,
    unit: "°C",
    source_identifier: "e2e-temp-01",
    simulated: true,
  });
  log(
    "6",
    `${rep1.tool_calls.length} tool calls, all on rack-1; evidence shows 41.5 °C from e2e-temp-01 (simulated)`,
  );
  log(
    "6",
    `Tools: ${rep1.tool_calls.map((c: any) => `${c.agent}/${c.tool}`).join(", ")}`,
  );
  expect(rep1.specialist_findings.length).toBeGreaterThan(0);
  expect(rep1.verification).not.toBeNull();
  await recA.getByText("View Investigation Details", { exact: true }).click();
  // The main finding is plain language: no metric codes, ISO timestamps or source identifiers.
  const finding = (await recA.locator(".inv-summary").first().textContent()) ?? "";
  expect(finding).not.toMatch(/AMBIENT_TEMPERATURE_C|RELATIVE_HUMIDITY_PERCENT|\d{4}-\d{2}-\d{2}T\d{2}:|e2e-temp-01/);
  log("6", `Main finding (${rep1.headline ? "AI headline" : "summary start"}): ${finding.slice(0, 200)}`);
  expect(await recA.locator('[data-testid="live-progress"]').count()).toBe(0);
  await expect(recA).toContainText("Measured facts");
  await expect(recA).toContainText("AI hypotheses");
  await expect(recA.getByTestId("verification-status")).toBeVisible();
  await expect(recA).toContainText("Verification outcome");
  log(
    "7",
    `Specialist findings (${rep1.specialist_findings.length}) and verification (grounded=${rep1.verification.grounded}) displayed`,
  );
  expect(row1.status).toBe(status1);
  expect(row1.profile_name).toBe("Cisco UCS C220 M7 · documented range");
  expect(row1.telemetry_simulated).toBe(true);
  expect(ev1.length).toBeGreaterThan(5);
  log(
    "8",
    `Persisted in SpacetimeDB: status ${row1.status}, ${ev1.length} events, profile "${row1.profile_name}", simulated=${row1.telemetry_simulated}`,
  );

  // 9-10. Second session shows the identical record.
  const recB = b.locator(
    `[data-testid="investigation-record"][data-id="${id1}"]`,
  );
  await expect(recB).toHaveAttribute("data-status", status1!);
  await expect(recB).toHaveAttribute("data-severity", sev1!);
  expect(await recB.locator(".inv-summary").first().textContent()).toBe(
    await recA.locator(".inv-summary").first().textContent(),
  );
  await a.screenshot({
    path: `${OUT}/agent-investigation-a.png`,
    fullPage: true,
  });
  await b.screenshot({
    path: `${OUT}/agent-investigation-b.png`,
    fullPage: true,
  });
  log(
    "9-10",
    "Session B shows the same investigation (status, severity, summary) via subscription",
  );

  // 11-12. Change server to Dell PowerEdge R760 (documented 35 warning / 45 critical): 41.5 C is now WARNING.
  await applyProfile(a, "dell-poweredge-r760");
  await expect(b.locator(".alert-item")).toContainText("WARNING");
  const id2 = await runInvestigation(a, known);
  const rec2 = await waitDone(a, id2);
  const [row2] = await sql(
    `SELECT * FROM investigation WHERE investigation_id = '${id2}'`,
  );
  const rep2 = JSON.parse(row2.report_json);
  log(
    "11-12",
    `Profile -> ${row2.profile_name}: status ${row2.status}, severity ${row2.severity}; agents ${rep2.agents_invoked.map((x: any) => x.agent).join(" -> ")}`,
  );
  expect(row2.profile_name).toBe("Dell PowerEdge R760 · documented range");
  expect(row2.severity).toBe("WARNING");
  await expect(rec2).toHaveAttribute("data-severity", "WARNING");
  expect(
    (
      await sql(
        `SELECT investigation_id FROM investigation WHERE investigation_id = '${id1}'`,
      )
    ).length,
  ).toBe(1);
  log("11-12", "Earlier investigation preserved as history");

  // 13. Missing telemetry stays missing, and nothing is fabricated: every sound/distance measurement in the
  // evidence must be a reading that actually exists in SpacetimeDB for this rack (someone may have entered one).
  const stored = await sql("SELECT metric_type, numeric_value, source_identifier FROM current_telemetry WHERE rack_id = 'rack-1'");
  for (const rep of [rep1, rep2]) {
    for (const metric of ["SOUND_RAW", "ULTRASONIC_DISTANCE_CM"]) {
      const inDb = stored.find((r) => r.metric_type === metric);
      const inEvidence = rep.evidence.measurements.filter((m: any) => m.metric_type === metric);
      if (!inDb) expect(inEvidence).toEqual([]);
      else for (const m of inEvidence) expect([m.numeric_value, m.source_identifier]).toEqual([inDb.numeric_value, inDb.source_identifier]);
    }
  }
  const missingText = JSON.stringify([rep1.missing_information, rep1.specialist_findings.map((f: any) => f.missing_information)]);
  log("13", `Sound/distance evidence matches SpacetimeDB exactly (stored: ${stored.map((r) => r.metric_type).join(", ")}); missing info mentions sound: ${/SOUND/i.test(missingText)}, distance: ${/ULTRASONIC|distance/i.test(missingText)}`);

  // 14. Failure paths are never shown as successful.
  await a.route("**/api/agent/investigate", (r) =>
    r.fulfill({
      status: 503,
      contentType: "application/json",
      body: '{"error":"Agent misconfigured","message":"simulated outage"}',
    }),
  );
  const id3 = await runInvestigation(a, known);
  const rec3 = await waitDone(a, id3);
  await expect(rec3).toHaveAttribute("data-status", "FAILED");
  await expect(rec3).toHaveAttribute("data-severity", "UNKNOWN");
  await expect(rec3).toContainText("Investigation failed");
  await expect(
    b.locator(`[data-testid="investigation-record"][data-id="${id3}"]`),
  ).toHaveAttribute("data-status", "FAILED");
  await a.unroute("**/api/agent/investigate");
  log("14", "Agent outage recorded as FAILED / UNKNOWN in both sessions");

  await a.route("**/api/agent/investigate", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        report: { ...rep2, rack_id: "rack-2" },
        events: [],
      }),
    }),
  );
  const id4 = await runInvestigation(a, known);
  const rec4 = await waitDone(a, id4);
  await expect(rec4).toHaveAttribute("data-status", "FAILED");
  await a.unroute("**/api/agent/investigate");
  log(
    "14",
    "Response for the wrong rack rejected by validation and recorded as FAILED",
  );

  expect(errors).toEqual([]);
  console.log("\nALL END-TO-END CHECKS PASSED");
} catch (e) {
  console.error("\nEND-TO-END CHECK FAILED:", (e as Error).message);
  if (errors.length) console.error("Page errors:", errors);
  process.exitCode = 1;
} finally {
  await browser.close();
}
