import { test, expect } from "./fixtures";
import { seedHousehold, createLedgerAccount } from "./helpers";

test.beforeEach(async ({ backend, request, context }) => {
  await backend.freshDb();
  await seedHousehold(request, context, backend.apiURL);
});

test("net-worth chart renders data and responds to preset changes", async ({ page }) => {
  await page.goto("/");

  await test.step("give the household a balance so the series has data", async () => {
    await createLedgerAccount(page, { name: "Savings", currency: "USD", opening: "5000" });
    await page.reload(); // ensure the chart's series query refetches with the new account
    await expect(page.getByTestId("networth-hero")).toContainText("5,000.00");
  });

  const chart = page.getByTestId("networth-chart");

  await test.step("default range (1Y) renders a chart, not the empty state", async () => {
    await expect(chart).toBeVisible();
    await expect(chart).not.toContainText("No data for this range.");
  });

  await test.step("switching the preset keeps a rendered chart", async () => {
    await chart.getByRole("button", { name: "YTD" }).click();
    await expect(chart).not.toContainText("No data for this range.");
    await chart.getByRole("button", { name: "1M" }).click();
    await expect(chart).not.toContainText("No data for this range.");
  });

  await test.step("a Custom range with from > to shows the empty state", async () => {
    await chart.getByRole("button", { name: "Custom" }).click();
    await chart.getByLabel("From").fill("2030-01-01");
    await chart.getByLabel("To").fill("2029-01-01");
    await expect(chart).toContainText("No data for this range.");
  });
});
