import { test, expect } from "./fixtures";
import { seedHousehold, createLedgerAccount } from "./helpers";

test.beforeEach(async ({ backend, request, context }) => {
  await backend.freshDb();
  await seedHousehold(request, context, backend.apiURL);
});

test("create a ledger account with an opening balance and update it", async ({ page }) => {
  await page.goto("/");

  await test.step("create the account", async () => {
    await createLedgerAccount(page, { name: "Checking", currency: "USD", opening: "1000" });
  });

  await test.step("it appears in the list and the headline reflects it", async () => {
    await expect(page.getByTestId("account-row").filter({ hasText: "Checking" })).toBeVisible();
    await expect(page.getByTestId("networth-hero")).toContainText("1,000.00");
  });

  await test.step("set a new balance on the detail page", async () => {
    await page.getByTestId("account-row").filter({ hasText: "Checking" }).click();
    await expect(page).toHaveURL(/\/accounts\//);
    await page.getByRole("button", { name: "Set balance…" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByTestId("set-balance-amount").fill("1500");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("heading", { name: "Checking" })).toBeVisible();
    await expect(page.getByText(/1,500\.00/)).toBeVisible();
  });
});
