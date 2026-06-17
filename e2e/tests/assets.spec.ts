import { test, expect } from "./fixtures";
import { seedHousehold, createAccount, addCashDeposit } from "./helpers";

test.beforeEach(async ({ backend, request, context }) => {
  await backend.freshDb();
  await seedHousehold(request, context, backend.apiURL);
});

test("assets page: holdings is the default tab; accounts tab lists assets", async ({ page }) => {
  await test.step("create and fund a savings account", async () => {
    await page.goto("/");
    await createAccount(page, { name: "Savings", currency: "USD" });
    // reload so the optimistic insert settles before clicking the row.
    await page.reload();
    await page.getByTestId("account-row").filter({ hasText: "Savings" }).click();
    await expect(page).toHaveURL(/\/accounts\//);
    await addCashDeposit(page, { amount: "1000", currency: "USD" });
  });

  await test.step("holdings is the default tab and rolls the cash up by currency", async () => {
    await page.getByRole("link", { name: "Assets" }).click();
    await expect(page.getByRole("heading", { name: "Assets" })).toBeVisible();
    // Default tab is Holdings — no ?tab in the URL.
    await expect(page).not.toHaveURL(/tab=/);
    await expect(page.getByTestId("assets-total")).toContainText("1,000.00");
    const cashRow = page.getByTestId("cash-row").filter({ hasText: "USD" });
    await expect(cashRow).toBeVisible();
    await expect(cashRow).toContainText("1,000.00");
  });

  await test.step("switching to Accounts persists tab=accounts and lists the asset", async () => {
    await page.getByRole("tab", { name: "Accounts" }).click();
    await expect(page).toHaveURL(/tab=accounts/);
    await expect(page.getByTestId("account-row").filter({ hasText: "Savings" })).toBeVisible();
  });
});
