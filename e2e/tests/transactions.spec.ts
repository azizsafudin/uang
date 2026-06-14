import { test, expect } from "./fixtures";
import { seedHousehold, createAccount } from "./helpers";

test.beforeEach(async ({ backend, request, context }) => {
  await backend.freshDb();
  await seedHousehold(request, context, backend.apiURL);
});

test("buy a stock with a cash leg, set price, see value and gain roll up", async ({ page }) => {
  await page.goto("/");

  await test.step("create a USD brokerage account", async () => {
    await createAccount(page, { name: "Brokerage", currency: "USD" });
  });

  await test.step("buy a new instrument with the cash leg", async () => {
    await page.reload();
    await page.getByTestId("account-row").filter({ hasText: "Brokerage" }).click();
    await expect(page).toHaveURL(/\/accounts\//);
    // Reload on the detail page so the instruments live-query is populated before
    // we submit (the cash leg resolves the seeded USD instrument without a race).
    await page.reload();
    await page.getByRole("button", { name: "Add transaction" }).click();
    const dialog = page.getByRole("dialog");

    await dialog.getByTestId("tx-instrument").click();
    await page.getByRole("option", { name: "New instrument…" }).click();
    await dialog.getByTestId("tx-instr-name").fill("Acme Corp");
    await dialog.getByTestId("tx-instr-symbol").fill("ACME");
    await dialog.getByTestId("tx-instr-currency").fill("USD");
    await dialog.getByTestId("tx-units").fill("10");
    await dialog.getByTestId("tx-price").fill("100");
    // "Also record cash outflow" is checked by default.
    await dialog.getByRole("button", { name: "Add" }).click();
    await expect(dialog).toBeHidden();
  });

  await test.step("the stock position appears with no price; the cash outflow is recorded", async () => {
    await page.reload();
    await expect(page.getByTestId("position-row").filter({ hasText: "Acme Corp" })).toContainText("no price");
    // The cash leg is a −1,000 USD outflow; a non-positive cash position is not listed
    // under Positions, but the leg is recorded in History (a separate tab).
    await page.getByRole("tab", { name: "History" }).click();
    await expect(page.getByTestId("tx-row").filter({ hasText: "USD" })).toContainText("-1000");
  });

  await test.step("set a price → market value and gain appear", async () => {
    await page.getByRole("tab", { name: "Positions" }).click();
    const row = page.getByTestId("position-row").filter({ hasText: "Acme Corp" });
    await row.getByRole("button", { name: "Price" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByTestId("price-amount").fill("120");
    await dialog.getByRole("button", { name: "Save price" }).click();
    await expect(dialog).toBeHidden();
    await page.reload();
    const priced = page.getByTestId("position-row").filter({ hasText: "Acme Corp" });
    await expect(priced).toContainText("1,200.00"); // 10 × 120
    await expect(priced).toContainText("200.00");    // (120-100) × 10
  });

  await test.step("net worth nets stock value against the cash outflow", async () => {
    // +1,200 stock − 1,000 cash = 200.00
    await page.goto("/");
    await expect(page.getByTestId("networth-hero")).toContainText("200.00");
  });
});
