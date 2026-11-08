import { chromium, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
const browser = await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL ?? "msedge", headless: true });
const errors: string[] = [];
try {
  const contexts = await Promise.all([
    browser.newContext({ viewport: { width: 1440, height: 1100 } }),
    browser.newContext({ viewport: { width: 1440, height: 1100 } }),
  ]);
  const pages = await Promise.all(contexts.map((c) => c.newPage()));
  for (const p of pages) {
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
  const [a, b] = pages;
  await Promise.all(pages.map((p) => p.goto("http://127.0.0.1:5173")));
  await Promise.all(
    pages.map((p) =>
      expect(
        p.getByRole("status").filter({ hasText: /^Connected$/ }),
      ).toBeVisible(),
    ),
  );
  // The production demo starts empty; rack 3 stays untouched by integration tests.
  for (const p of pages) {
    await expect(p.getByLabel("Rack selector").locator("option")).toHaveCount(
      3,
    );
    await p.getByLabel("Rack selector").selectOption("rack-3");
    await expect(p.getByTestId("AMBIENT_TEMPERATURE_C")).toContainText(
      "Unavailable",
    );
  }
  mkdirSync("test-results", { recursive: true });
  await a.screenshot({
    path: "test-results/dashboard-empty.png",
    fullPage: true,
  });
  // Use verification database through a separate Vite server configured for that database.
  await Promise.all(pages.map((p) => p.goto("http://127.0.0.1:5174")));
  await Promise.all(
    pages.map((p) =>
      expect(
        p.getByRole("status").filter({ hasText: /^Connected$/ }),
      ).toBeVisible(),
    ),
  );
  await a.getByRole("button", { name: "Simulation", exact: true }).click();
  await a.locator(".simulation-editor .advanced-settings > summary").click();
  await b.locator(".observation-details > summary").click();
  await a.getByLabel("Server simulation profile").selectOption("standard");
  await expect(b.getByLabel("Server simulation profile")).toHaveValue(
    "standard",
  );
  // Establish a repeatable baseline even after another suite left humidity high.
  await a.getByLabel("Relative humidity", { exact: true }).fill("45");
  await a
    .getByRole("button", { name: "Apply Relative humidity", exact: true })
    .click();
  await expect(b.getByTestId("RELATIVE_HUMIDITY_PERCENT")).toContainText("45");
  await a.getByLabel("Ambient temperature", { exact: true }).fill("41");
  await a
    .locator("form")
    .filter({ has: a.getByLabel("Ambient temperature", { exact: true }) })
    .getByRole("button", { name: /^Apply / })
    .click();
  await expect(
    a.getByRole("status").filter({ hasText: "Committed by SpacetimeDB" }),
  ).toBeVisible();
  await expect(b.getByTestId("AMBIENT_TEMPERATURE_C")).toContainText("41");
  await expect(b.locator(".alert-item.critical")).toContainText(
    "Ambient temperature",
  );
  await expect(b.locator(".history tbody")).toContainText("dashboard-demo");
  await a.getByLabel("Server simulation profile").selectOption("industrial");
  await expect(b.getByLabel("Server simulation profile")).toHaveValue(
    "industrial",
  );
  await expect(b.locator(".alert-item.warning")).toContainText(
    "Ambient temperature",
  );
  await a.getByLabel("Ambient temperature", { exact: true }).fill("20");
  await a
    .locator("form")
    .filter({ has: a.getByLabel("Ambient temperature", { exact: true }) })
    .getByRole("button", { name: /^Apply / })
    .click();
  await expect(b.getByTestId("AMBIENT_TEMPERATURE_C")).toContainText("20");
  await expect(b.locator(".alert-item")).toHaveCount(0);
  await b.reload();
  await expect(b.getByTestId("AMBIENT_TEMPERATURE_C")).toContainText("20");
  for (let i = 0; i < 4; i++) {
    await b.getByLabel("Rack selector").selectOption("rack-2");
    await expect(b.getByTestId("AMBIENT_TEMPERATURE_C")).toContainText(
      "Unavailable",
    );
    await b.getByLabel("Rack selector").selectOption("rack-1");
    await expect(b.getByTestId("AMBIENT_TEMPERATURE_C")).toContainText("20");
  }
  await a.screenshot({
    path: "test-results/dashboard-desktop.png",
    fullPage: true,
  });
  await a.setViewportSize({ width: 390, height: 844 });
  await a.screenshot({
    path: "test-results/dashboard-mobile.png",
    fullPage: true,
  });
  expect(
    await a.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  // Local age display updates without polling or replacing a newer observation.
  await b.clock.install();
  await b.clock.setSystemTime(new Date(Date.now() + 61000));
  await expect(b.getByTestId("AMBIENT_TEMPERATURE_C")).toContainText("Stale");
  await b.clock.setSystemTime(new Date());
  // Switch online state to exercise disconnected display and disable writes.
  await contexts[1].setOffline(true);
  await b.evaluate(() =>
    (window as unknown as { __testSockets: WebSocket[] }).__testSockets.forEach(
      (s) => s.close(),
    ),
  );
  await expect(
    b.getByRole("status").filter({ hasText: /Disconnected|Error/ }),
  ).toBeVisible({ timeout: 15000 });
  await expect(
    b.locator(".investigation-actions .primary-button"),
  ).toBeDisabled();
  await contexts[1].setOffline(false);
  await expect(
    b.getByRole("status").filter({ hasText: /^Connected$/ }),
  ).toBeVisible({ timeout: 30000 });
  await expect(b.getByTestId("AMBIENT_TEMPERATURE_C")).toContainText("20");
  expect(errors).toEqual([]);
  console.log(
    "PASS two independent browser contexts: empty state, telemetry, alerts, profiles, history, reload persistence, rack switching, stale status, offline/reconnect, mobile layout; no browser errors",
  );
} finally {
  await browser.close();
}
