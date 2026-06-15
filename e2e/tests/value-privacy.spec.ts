import { test, expect } from "./fixtures";
import { seedHousehold, createAccount, addCashDeposit } from "./helpers";

test.beforeEach(async ({ backend, request, context }) => {
  await backend.freshDb();
  await seedHousehold(request, context, backend.apiURL);
});

test("eye toggle masks all values and persists across reload", async ({ page }) => {
  await page.goto("/");
  await createAccount(page, { name: "Checking", currency: "USD" });

  await page.reload();
  await page.getByTestId("account-row").filter({ hasText: "Checking" }).click();
  await expect(page).toHaveURL(/\/accounts\//);
  await addCashDeposit(page, { amount: "1000", currency: "USD" });
  await page.goto("/");
  await page.reload(); // read server truth, not the optimistic insert's refetch race

  const hero = page.getByTestId("networth-hero");
  await expect(hero).toContainText("1,000.00");
  await expect(hero).not.toHaveText("••••••");

  // Hiding masks every visible amount (the hero is the canary).
  await page.getByRole("button", { name: "Hide values" }).click();
  await expect(hero).toHaveText("••••••");

  // The preference is persisted per-device in localStorage, so it survives a reload.
  await page.reload();
  await expect(page.getByTestId("networth-hero")).toHaveText("••••••");

  // And it can be toggled back off.
  await page.getByRole("button", { name: "Show values" }).click();
  await expect(page.getByTestId("networth-hero")).toContainText("1,000.00");
});
