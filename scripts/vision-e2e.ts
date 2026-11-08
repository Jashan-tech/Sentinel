// Feature 4 end-to-end check with LIVE Nemotron vision inference.
// Prerequisites: SpacetimeDB :3000 (sentinel published), agent :3001 (NVIDIA key), dashboard :5173.
// Uses Rack 01, local Google Chrome, and a real Wikimedia Commons photo from agent/test-assets/vision.
//   npx tsx scripts/vision-e2e.ts [image-file]
import { chromium, expect, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DASH = "http://127.0.0.1:5173";
const SQL = "http://127.0.0.1:3000/v1/database/sentinel/sql";
const OUT = process.env.E2E_OUT ?? "test-results";
const ASSETS = new URL("../agent/test-assets/vision/", import.meta.url);
const IMAGE = process.argv[2] ?? "rack-switches-patch-panels.jpg";
const TIMEOUT = 200_000; // agent: 130 s visual budget + synthesis; client gives up at 180 s

const manifest = JSON.parse(
  readFileSync(new URL("manifest.json", ASSETS), "utf8"),
);
const meta = manifest.images.find((m: any) => m.file === IMAGE);
if (!meta) throw new Error(`${IMAGE} not in manifest`);
const imagePath = fileURLToPath(new URL(IMAGE, ASSETS));
const sha = createHash("sha256").update(readFileSync(imagePath)).digest("hex");

async function sql(query: string): Promise<Record<string, any>[]> {
  const res = await fetch(SQL, { method: "POST", body: query });
  if (!res.ok) throw new Error(`SQL ${res.status}: ${await res.text()}`);
  const [{ schema, rows }] = (await res.json()) as any[];
  const names = schema.elements.map((e: any) => e.name.some);
  return rows.map((r: unknown[]) =>
    Object.fromEntries(names.map((n: string, i: number) => [n, r[i]])),
  );
}
const log = (step: string, msg: string) => console.log(`[${step}] ${msg}`);

async function open(p: Page) {
  await p.goto(DASH);
  await expect(
    p.getByRole("status").filter({ hasText: /^Connected$/ }),
  ).toBeVisible();
  await p.getByTestId("rack-option-rack-1").click();
  await expect(p.getByTestId("rack-option-rack-1")).toHaveAttribute("aria-current", "true");
  await p.getByRole("button", { name: "Simulation", exact: true }).click();
  await p.locator(".simulation-editor .advanced-settings > summary").click();
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
const errors: string[] = [];
try {
  mkdirSync(OUT, { recursive: true });
  const [a, b] = await Promise.all(
    [1, 2].map(async () =>
      (
        await browser.newContext({ viewport: { width: 1440, height: 1600 } })
      ).newPage(),
    ),
  );
  for (const p of [a, b]) p.on("pageerror", (e) => errors.push(e.message));
  const before = new Set(
    (await sql("SELECT investigation_id FROM investigation")).map(
      (r) => r.investigation_id,
    ),
  );
  await Promise.all([open(a), open(b)]);

  // Critical telemetry on Rack 01 (Cisco UCS C220 M7: documented critical at 35 C) so the combined run has something to correlate.
  await a.getByLabel("Server profile").selectOption("cisco-ucs-c220-m7");

  await a.getByLabel("Source identifier").fill("vision-e2e-temp");
  await a.getByLabel("Ambient temperature", { exact: true }).fill("41.5");
  await a
    .locator("form")
    .filter({ has: a.getByLabel("Ambient temperature", { exact: true }) })
    .getByRole("button", { name: /^Apply / })
    .click();
  await expect(a.getByText("Committed by SpacetimeDB.")).toBeVisible();
  log("setup", "Rack 01: 41.5 °C under Standard profile (CRITICAL)");

  // Invalid uploads are rejected in the browser with a visible reason and no run button.
  const tmp = tmpdir();
  writeFileSync(join(tmp, "fake.png"), "this is not an image");
  writeFileSync(
    join(tmp, "truncated.jpg"),
    readFileSync(imagePath).subarray(0, 4000),
  );
  await a.getByRole("button", { name: "Upload Photo", exact: true }).click();
  for (const [file, reason] of [
    ["fake.png", /only JPEG and PNG/],
    ["truncated.jpg", /could not be decoded/],
  ] as const) {
    await a.getByLabel("Inspection photo").setInputFiles(join(tmp, file));
    await expect(
      a.getByTestId("vision-upload").getByRole("alert"),
    ).toContainText(reason);
    await expect(
      a.getByRole("button", { name: "Run Visual Inspection" }),
    ).toHaveCount(0);
  }
  log(
    "validation",
    "Non-image and truncated JPEG rejected in the browser with clear messages",
  );

  // Upload the real reference photo with its provenance, combined with telemetry.
  await a.getByLabel("Image source").selectOption("ONLINE_REFERENCE");
  await a.getByLabel("Source page URL").fill(meta.source_page);
  await a.getByLabel("Attribution").fill(meta.creator);
  await a.getByLabel("License").fill(meta.license);
  await a.getByLabel("Inspection photo").setInputFiles(imagePath);
  await expect(a.getByTestId("vision-upload")).toContainText(sha.slice(0, 16));
  await expect(a.getByLabel("Include current rack telemetry")).toBeChecked();
  log(
    "upload",
    `${IMAGE} (${meta.license}, ${meta.creator}) previewed; browser sha256 ${sha.slice(0, 16)}… matches file`,
  );

  const t0 = Date.now();
  await a.getByRole("button", { name: "Run Visual Inspection" }).click();
  const recA = a.getByTestId("investigation-record");
  await expect
    .poll(async () => {
      const id = await recA.getAttribute("data-id");
      return id && !before.has(id) ? id : null;
    })
    .not.toBeNull();
  const id = (await recA.getAttribute("data-id"))!;
  await expect(
    b.locator(`[data-testid="investigation-record"][data-id="${id}"]`),
  ).toHaveAttribute("data-status", "RUNNING");
  log("run", `Investigation ${id} started; session B sees RUNNING`);
  await expect(recA).not.toHaveAttribute("data-status", "RUNNING", {
    timeout: TIMEOUT,
  });
  const status = await recA.getAttribute("data-status");
  log(
    "run",
    `Finished in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${status}, ${await recA.getAttribute("data-severity")}`,
  );
  expect(["COMPLETED", "INCOMPLETE"]).toContain(status);

  // 1-4. Real image reached Nemotron; structured findings; Supervisor + Verification used them.
  const [row] = await sql(
    `SELECT * FROM investigation WHERE investigation_id = '${id}'`,
  );
  const rep = JSON.parse(row.report_json);
  const events = JSON.parse(row.events_json);
  const agents = rep.agents_invoked.map((x: any) => x.agent);
  log(
    "1",
    `Vision event: ${events.find((e: any) => e.agent === "vision" && /started on/.test(e.description))?.description.slice(0, 140)}`,
  );
  expect(rep.evidence.images[0].sha256).toBe(sha); // the server hashed exactly the bytes we uploaded
  log(
    "1",
    `Agent-computed sha256 of received bytes matches the file (${sha.slice(0, 16)}…), ${rep.evidence.images[0].width}x${rep.evidence.images[0].height}`,
  );
  expect(agents).toContain("vision");
  expect(rep.visual_findings.length).toBeGreaterThan(0);
  for (const v of rep.visual_findings)
    expect(["CERTAIN", "UNCERTAIN"]).toContain(v.certainty);
  log(
    "2",
    `Vision returned ${rep.visual_findings.length} structured findings (${rep.visual_findings.filter((v: any) => v.certainty === "CERTAIN").length} certain)`,
  );
  for (const v of rep.visual_findings.slice(0, 4))
    log("2", `  [${v.certainty}/${v.category}] ${v.observation.slice(0, 120)}`);
  log(
    "3",
    `Agents: ${agents.join(" -> ")}; mode ${rep.inspection_mode}; plan: ${rep.supervisor_plan.slice(0, 120)}`,
  );
  expect(agents).toContain("verification");
  log(
    "4",
    `Verification: grounded=${rep.verification.grounded}, verified ${rep.verification.verified_findings.length}, unsupported ${rep.verification.unsupported_claims.length}`,
  );
  for (const u of rep.verification.unsupported_claims.slice(0, 3))
    log("4", `  unsupported: ${u.slice(0, 140)}`);

  // 5. Report visible in the dashboard.
  await recA.getByText("View Investigation Details", { exact: true }).click();
  await expect(recA.getByTestId("visual-findings")).toBeVisible();
  await expect(recA.getByTestId("image-provenance")).toContainText(
    "Online reference — not captured by SENTINEL",
  );
  await expect(recA.getByTestId("image-provenance")).toContainText(
    "Captured: unknown",
  );
  log("5", "Visual findings, provenance and preview shown in session A");

  // 6. Persisted in SpacetimeDB: provenance + thumbnail, never image bytes.
  const [imgRow] = await sql(
    `SELECT * FROM investigation_image WHERE investigation_id = '${id}'`,
  );
  expect(imgRow.sha_256).toBe(sha); // SpacetimeDB column name for `sha256`
  expect(imgRow.source_type).toBe("ONLINE_REFERENCE");
  expect(imgRow.source_url).toBe(meta.source_page);
  expect(imgRow.license).toBe(meta.license);
  expect(imgRow.thumbnail_data_url.length).toBeLessThanOrEqual(60_000);
  for (const col of ["snapshot_json", "report_json", "events_json"])
    expect(row[col]).not.toMatch(/data_base64|;base64,/);
  log(
    "6",
    `investigation_image row: sha256 ok, ${imgRow.source_type}, license ${imgRow.license}, thumbnail ${imgRow.thumbnail_data_url.length} chars; no image bytes in investigation row`,
  );

  // 7. Second browser shows the same report and provenance.
  const recB = b.locator(
    `[data-testid="investigation-record"][data-id="${id}"]`,
  );
  await expect(recB).toHaveAttribute("data-status", status!);
  await recB.getByText("View Investigation Details", { exact: true }).click();
  await expect(recB.getByTestId("visual-findings")).toBeVisible();
  expect(await recB.getByTestId("visual-findings").locator("li").count()).toBe(
    rep.visual_findings.length,
  );
  await expect(recB.getByTestId("image-provenance")).toContainText(
    sha.slice(0, 16),
  );
  await expect(
    recB.getByTestId("image-provenance").locator("img"),
  ).toBeVisible();
  await a.screenshot({ path: `${OUT}/vision-a.png`, fullPage: true });
  await b.screenshot({ path: `${OUT}/vision-b.png`, fullPage: true });
  log(
    "7",
    "Session B shows identical visual findings, provenance and stored preview",
  );

  // Failure path with an image: never shown as a success.
  await a.route("**/api/agent/investigate", (r) =>
    r.fulfill({
      status: 503,
      contentType: "application/json",
      body: '{"error":"simulated outage"}',
    }),
  );
  await a.getByRole("button", { name: "Run Visual Inspection" }).click();
  await expect.poll(async () => recA.getAttribute("data-id")).not.toBe(id);
  await expect(recA).toHaveAttribute("data-status", "FAILED", {
    timeout: 30_000,
  });
  await expect(recA).toHaveAttribute("data-severity", "UNKNOWN");
  await a.unroute("**/api/agent/investigate");
  log(
    "failure",
    "Agent outage during visual inspection recorded as FAILED / UNKNOWN",
  );

  expect(errors).toEqual([]);
  console.log(
    "\nVISION END-TO-END CHECKS PASSED (step 8, telemetry-only regression, is scripts/agent-e2e.ts)",
  );
} catch (e) {
  console.error("\nVISION END-TO-END CHECK FAILED:", (e as Error).message);
  if (errors.length) console.error("Page errors:", errors);
  process.exitCode = 1;
} finally {
  await browser.close();
}
