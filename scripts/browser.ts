import { chromium, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
const browser = await chromium.launch({ channel: "msedge", headless: true });
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
    await expect(
      p.getByRole("navigation", { name: "Rack selector" }).getByRole("button"),
    ).toHaveCount(3);
    await p.getByRole("button", { name: /Rack 03/ }).click();
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
  await a.getByLabel("Selected rack profile").selectOption("standard");
  if (await a.getByRole("button", { name: "Apply profile" }).isEnabled())
    await a.getByRole("button", { name: "Apply profile" }).click();
  await expect(b.getByLabel("Selected rack profile")).toHaveValue("standard");
  await a.getByLabel("Ambient temperature", { exact: true }).fill("41");
  await a
    .locator("form")
    .filter({ has: a.getByLabel("Ambient temperature", { exact: true }) })
    .getByRole("button", { name: "Submit" })
    .click();
  await expect(
    a.getByRole("status").filter({ hasText: "Committed by SpacetimeDB" }),
  ).toBeVisible();
  await expect(b.getByTestId("AMBIENT_TEMPERATURE_C")).toContainText("41");
  await expect(b.locator(".alert-item.critical")).toContainText(
    "Ambient temperature",
  );
  await expect(b.locator(".history tbody")).toContainText("dashboard-demo");
  await a.getByLabel("Selected rack profile").selectOption("industrial");
  await a.getByRole("button", { name: "Apply profile" }).click();
  await expect(b.getByLabel("Selected rack profile")).toHaveValue("industrial");
  await expect(b.locator(".alert-item.warning")).toContainText(
    "Ambient temperature",
  );
  await a.getByLabel("Ambient temperature", { exact: true }).fill("20");
  await a
    .locator("form")
    .filter({ has: a.getByLabel("Ambient temperature", { exact: true }) })
    .getByRole("button", { name: "Submit" })
    .click();
  await expect(b.getByTestId("AMBIENT_TEMPERATURE_C")).toContainText("20");
  await expect(b.locator(".alert-item")).toHaveCount(0);
  await b.reload();
  await expect(b.getByTestId("AMBIENT_TEMPERATURE_C")).toContainText("20");
  for (let i = 0; i < 4; i++) {
    await b.getByRole("button", { name: /Rack 02/ }).click();
    await expect(b.getByTestId("AMBIENT_TEMPERATURE_C")).toContainText(
      "Unavailable",
    );
    await b.getByRole("button", { name: /Rack 01/ }).click();
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
  // Local freshness timer must mark old data stale without fetching readings.
  await a.getByLabel("Observation time").fill("2026-01-01T12:00:00");
  await a.getByLabel("Ultrasonic distance", { exact: true }).fill("42");
  await a
    .locator("form")
    .filter({ has: a.getByLabel("Ultrasonic distance", { exact: true }) })
    .getByRole("button", { name: "Submit" })
    .click();
  await expect(b.getByTestId("ULTRASONIC_DISTANCE_CM")).toContainText("Stale");
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
    b
      .locator("form")
      .filter({ has: b.getByLabel("Ambient temperature", { exact: true }) })
      .getByRole("button", { name: "Submit" }),
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
