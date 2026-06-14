import { test, expect } from "./fixtures";
import { seedHousehold, createAccount } from "./helpers";

test.beforeEach(async ({ backend, request, context }) => {
  await backend.freshDb();
  await seedHousehold(request, context, backend.apiURL);
});

test("create a cash account and add a currency transaction", async ({ page }) => {
  await page.goto("/");

  await test.step("create the account", async () => {
    await createAccount(page, { name: "Checking", currency: "USD" });
  });

  await test.step("open it and add a cash deposit", async () => {
    await page.reload();
    await page.getByTestId("account-row").filter({ hasText: "Checking" }).click();
    await expect(page).toHaveURL(/\/accounts\//);
    await page.getByRole("button", { name: "Add transaction" }).click();
    const dialog = page.getByRole("dialog");
    // Pick the auto-seeded USD currency instrument.
    await dialog.getByTestId("tx-instrument").click();
    await page.getByRole("option", { name: /USD .* \(cash\)/ }).click();
    await dialog.getByTestId("tx-amount").fill("1000");
    await dialog.getByRole("button", { name: "Add" }).click();
    await expect(dialog).toBeHidden();
  });

  await test.step("the position and account total reflect the deposit", async () => {
    await page.reload();
    await expect(page.getByTestId("account-total")).toContainText("1,000.00");
    await expect(page.getByTestId("position-row").filter({ hasText: "USD" })).toBeVisible();
  });

  await test.step("it rolls into the dashboard net worth", async () => {
    await page.goto("/");
    await expect(page.getByTestId("networth-hero")).toContainText("1,000.00");
  });
});
