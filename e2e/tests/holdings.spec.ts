import { test, expect } from "./fixtures";
import { seedHousehold } from "./helpers";

test.beforeEach(async ({ backend, request, context }) => {
  await backend.freshDb();
  await seedHousehold(request, context, backend.apiURL);
});

test("holdings account: add a lot with a new instrument, set price, see gain", async ({ page }) => {
  await page.goto("/");

  await test.step("create a holdings (investment) account", async () => {
    await page.getByRole("button", { name: "Add account" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByTestId("account-name").fill("Brokerage");
    // Set valuation to Holdings directly (base-ui Select: click the trigger, then the option).
    await dialog.getByTestId("account-valuation").click();
    await page.getByRole("option", { name: "Holdings (investments)" }).click();
    await dialog.getByTestId("account-currency").fill("USD");
    await dialog.getByRole("button", { name: "Create" }).click();
    await expect(dialog).toBeHidden();
  });

  await test.step("open the holdings detail and add a lot with a new instrument", async () => {
    await page.reload();
    await page.getByTestId("account-row").filter({ hasText: "Brokerage" }).click();
    await expect(page.getByText("Investments · holdings")).toBeVisible();
    await page.getByRole("button", { name: "Add lot" }).click();
    const dialog = page.getByRole("dialog");
    // Instrument select defaults to "New instrument…", so the new-instrument fields are visible.
    await dialog.getByTestId("lot-instrument-name").fill("Acme Corp");
    await dialog.getByTestId("lot-instrument-symbol").fill("ACME");
    await dialog.getByTestId("lot-instrument-currency").fill("USD");
    await dialog.getByTestId("lot-units").fill("10");
    await dialog.getByTestId("lot-unit-cost").fill("100");
    await dialog.getByTestId("lot-fees").fill("5");
    await dialog.getByRole("button", { name: "Add" }).click();
    await expect(dialog).toBeHidden();
    await page.reload();
    // No price yet → the lot shows the "no price" flag.
    await expect(page.getByTestId("lot-row").filter({ hasText: "Acme Corp" })).toContainText("no price");
  });

  await test.step("set a price → market value and per-lot gain appear", async () => {
    const lot = page.getByTestId("lot-row").filter({ hasText: "Acme Corp" });
    await lot.getByRole("button", { name: "Price" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByTestId("price-amount").fill("120");
    await dialog.getByRole("button", { name: "Save price" }).click();
    await expect(dialog).toBeHidden();
    await page.reload();
    // 10 units × $120 = $1,200.00 market value; cost 10×100 + 5 = $1,005; gain = $195.00.
    const pricedLot = page.getByTestId("lot-row").filter({ hasText: "Acme Corp" });
    await expect(pricedLot).toContainText("1,200.00");
    await expect(pricedLot).toContainText("195.00");
    await expect(page.getByTestId("holdings-total")).toContainText("1,200.00");
  });

  await test.step("it rolls into the dashboard net worth", async () => {
    await page.getByRole("link", { name: "← Back" }).click();
    await expect(page.getByTestId("networth-hero")).toContainText("1,200.00");
  });
});
