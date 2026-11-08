// LIVE browser end-to-end check of the Fleet Simulation benchmark.
// Prerequisites: SpacetimeDB :3000 (sentinel published), dashboard :5173, `npm run bench:runner`.
// Every number asserted on screen is compared with the rows the load generator stored in SpacetimeDB.
//   npx tsx scripts/benchmark-e2e.ts
import { chromium, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

const DASH = process.env.DASH_URL ?? "http://127.0.0.1:5173";
const SQL = "http://127.0.0.1:3000/v1/database/sentinel/sql";
const OUT = process.env.E2E_OUT ?? "test-results";
const log = (step: string, msg: string) => console.log(`[${step}] ${msg}`);

async function sql(query: string): Promise<Record<string, any>[]> {
  const res = await fetch(SQL, { method: "POST", body: query });
  if (!res.ok) throw new Error(`SQL ${res.status}: ${await res.text()}`);
  const [{ schema, rows }] = (await res.json()) as any[];
  const names = schema.elements.map((e: any) => e.name.some);
  return rows.map((r: unknown[]) => Object.fromEntries(names.map((n: string, i: number) => [n, r[i]])));
}
// SpacetimeDB SQL renders option<T> as a sum: [0, value] = some, [1, []] = none.
// Column names split digits: deliveryP95 -> delivery_p_95.
const some = (v: any): number | null => (Array.isArray(v) ? (v[0] === 0 ? Number(v[1]) : null) : v);
const fmt = (v: number, d = 0) => v.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
const metric = (p: Page, label: string) => p.locator(`[data-metric="${label}"] strong`);

const browser = await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL ?? "chrome", headless: true });
const errors: string[] = [];
try {
  mkdirSync(OUT, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1800 } });
  const [a, b] = [await ctx.newPage(), await (await browser.newContext({ viewport: { width: 390, height: 1600 } })).newPage()];
  for (const p of [a, b]) p.on("pageerror", (e) => errors.push(e.message));
  for (const p of [a, b]) {
    await p.goto(DASH);
    await expect(p.getByRole("status").filter({ hasText: /^Connected$/ })).toBeVisible();
    await p.getByRole("button", { name: "Fleet Simulation" }).click();
  }
  await expect(a.getByTestId("runner-status")).toContainText("Load generator connected");
  log("1", "Fleet Simulation open in two sessions (desktop + phone width); load generator connected");

  // Before starting: the target is labelled as configuration, achieved says Not measured.
  await a.getByRole("radio", { name: "Ramp Test" }).click();
  await a.getByLabel("Rover count").selectOption("500");
  await a.getByLabel("Events per rover per second").selectOption("2");
  await a.getByLabel("Duration").selectOption("5");
  if ((await a.getByTestId("bench-state").getAttribute("data-state")) === "Running") throw new Error("A run is already active");
  await expect(a.getByTestId("achieved-rate")).toHaveText("Not measured");
  log("2", `Configured target shown as configuration: "${(await a.getByTestId("target-rate").textContent())?.trim()}"; achieved = Not measured`);

  const before = new Set((await sql("SELECT run_id FROM benchmark_run")).map((r) => r.run_id));
  await a.getByRole("button", { name: /Start Ramp Test/ }).click();
  await expect(a.getByTestId("bench-state")).toHaveAttribute("data-state", "Running", { timeout: 10_000 });
  await expect(b.getByTestId("bench-state")).toHaveAttribute("data-state", "Running");
  log("3", "Ramp Test started from the dashboard; both sessions show Running");

  // While running: live numbers appear, and they come from stored windows.
  await expect(metric(a, "Active simulated rovers")).not.toHaveText(/None/, { timeout: 10_000 });
  await expect.poll(async () => Number(await a.getByTestId("latency-chart").getAttribute("data-points")), { timeout: 20_000 }).toBeGreaterThan(2);
  await expect(metric(a, "Delivery success")).toContainText(/Pending|%/);
  log("4", `Live: rovers ${await metric(a, "Active simulated rovers").textContent()}, subscribers ${await metric(a, "Active benchmark subscribers").textContent()}, chart points ${await a.getByTestId("latency-chart").getAttribute("data-points")}`);

  await expect(a.getByTestId("bench-state")).toHaveAttribute("data-state", "Completed", { timeout: 90_000 });
  const [run] = (await sql("SELECT * FROM benchmark_run")).filter((r) => !before.has(r.run_id));
  const stages = (await sql(`SELECT * FROM benchmark_stage WHERE run_id = ${run.run_id}`)).sort((x, y) => x.stage_index - y.stage_index);
  const server = await sql(`SELECT * FROM benchmark_stage_server WHERE run_id = ${run.run_id}`);
  const samples = await sql(`SELECT * FROM benchmark_sample WHERE run_id = ${run.run_id}`);
  log("5", `Run #${run.run_id} COMPLETED: ${stages.length} stages (${stages.map((s) => s.rover_count).join(" → ")} rovers), ${samples.length} windows`);
  if (stages.map((s) => s.rover_count).join() !== "1,100,500") throw new Error("unexpected ramp stages");

  // Every headline number equals what the database holds.
  const last = stages.at(-1)!;
  const acked = stages.reduce((t, s) => t + Number(s.acknowledged), 0);
  const obs = stages.reduce((t, s) => t + Number(s.observed_pairs), 0);
  const exp = stages.reduce((t, s) => t + Number(s.expected_pairs), 0);
  await expect(metric(a, "Actual throughput")).toContainText(fmt(some(last.achieved_rate)!));
  await expect(metric(a, "Delivery latency P95")).toContainText(fmt(some(last.delivery_p_95)!, 1));
  await expect(metric(a, "Delivery success")).toContainText(fmt((obs / exp) * 100, 2));
  await expect(metric(a, "Successfully processed")).toContainText(fmt(acked));
  await expect(metric(a, "Active simulated rovers")).toHaveText("None");
  for (const s of stages) {
    const srv = server.find((x) => x.stage_key === s.stage_key);
    if (Number(some(srv?.committed_txns)) !== Number(s.acknowledged)) throw new Error(`stage ${s.stage_index}: server committed ${JSON.stringify(srv?.committed_txns)} ≠ acked ${s.acknowledged}`);
  }
  log("6", `Headline = DB: throughput ${fmt(some(last.achieved_rate)!)} /s, P95 ${fmt(some(last.delivery_p_95)!, 1)} ms, delivery ${fmt((obs / exp) * 100, 2)}%, processed ${fmt(acked)}; server-committed = acked for every stage`);

  // Chart points = stored windows with a P95; nothing else.
  const withP95 = samples.filter((s) => some(s.delivery_p_95) !== null).length;
  await expect(a.getByTestId("latency-chart")).toHaveAttribute("data-points", String(withP95));
  await expect(a.getByTestId("latency-chart")).toContainText(/Single rover \(measured\)|Single-rover stage P95 \(this run\): [\d.]+ ms/);
  log("7", `Chart draws exactly the ${withP95} stored windows that have a measured P95 (of ${samples.length})`);

  await a.getByTestId("bench-details").locator("summary").click();
  const rows = a.locator(".bench-table tbody tr");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(2)).toContainText(fmt(Number(last.acknowledged)));
  await expect(b.getByTestId("bench-state")).toHaveAttribute("data-state", "Completed");
  await expect(metric(b, "Successfully processed")).toContainText(fmt(acked));
  await a.screenshot({ path: `${OUT}/benchmark-ramp-desktop.png`, fullPage: true });
  await b.screenshot({ path: `${OUT}/benchmark-ramp-mobile.png`, fullPage: true });
  log("8", "Details table shows all 3 stages; phone-width session shows the same totals");

  // Fixed Load + Stop from the dashboard.
  await a.getByRole("radio", { name: "Fixed Load" }).click();
  await a.getByLabel("Rover count").selectOption("1000");
  await a.getByLabel("Events per rover per second").selectOption("1");
  await a.getByLabel("Duration").selectOption("60");
  await a.getByRole("button", { name: /Start Fixed Load/ }).click();
  await expect(a.getByTestId("bench-state")).toHaveAttribute("data-state", "Running", { timeout: 10_000 });
  await expect(a.getByTestId("achieved-rate")).not.toHaveText("Not measured", { timeout: 10_000 });
  log("9", `Fixed Load running: target ${(await a.getByTestId("target-rate").textContent())?.trim()}, achieved ${(await a.getByTestId("achieved-rate").textContent())?.trim()}`);
  await expect(a.getByTestId("latency-chart")).toContainText(/previously measured \(run #\d+\)/);
  log("9", "Fixed Load chart shows the single-rover baseline labelled as previously measured");
  await a.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(a.getByTestId("bench-state")).toHaveAttribute("data-state", "Stopped", { timeout: 20_000 });
  const [stopped] = (await sql("SELECT * FROM benchmark_run")).sort((x, y) => y.run_id - x.run_id);
  if (stopped.state !== "STOPPED") throw new Error(`expected STOPPED, got ${stopped.state}`);
  const partial = await sql(`SELECT * FROM benchmark_stage WHERE run_id = ${stopped.run_id}`);
  log("10", `Stop pressed: run #${stopped.run_id} STOPPED, partial stage stored (${partial[0]?.acknowledged ?? 0} acknowledged)`);
  await expect(b.getByTestId("bench-state")).toHaveAttribute("data-state", "Stopped");

  // Rack Monitor unaffected.
  await a.getByRole("button", { name: "Rack Monitor" }).click();
  await expect(a.getByRole("heading", { level: 1 })).toBeVisible();
  log("11", "Rack Monitor still renders after the benchmark");

  if (errors.length) throw new Error(`page errors: ${errors.join("; ")}`);
  console.log("\nFLEET BENCHMARK BROWSER CHECKS PASSED");
} catch (e) {
  console.error("\nFLEET BENCHMARK BROWSER CHECK FAILED:", (e as Error).message);
  if (errors.length) console.error("Page errors:", errors);
  process.exitCode = 1;
} finally {
  await browser.close();
}
