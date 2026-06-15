import { test, expect } from "./fixtures";
import { seedHousehold, createAccount, addCashDeposit } from "./helpers";

test.beforeEach(async ({ backend, request, context }) => {
  await backend.freshDb();
  await seedHousehold(request, context, backend.apiURL);
});

test("dashboard shows hero + tiles, Add account in Assets header", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("dashboard-hero")).toBeVisible();
  await expect(page.getByTestId("dashboard-tiles")).toBeVisible();
  // Add account lives in the Assets section now (not top-right).
  await expect(page.getByRole("button", { name: "Add account" })).toBeVisible();

  // Fund an account so the Assets tile becomes available.
  await createAccount(page, { name: "Checking", currency: "USD" });
  await page.reload();
  await page.getByTestId("account-row").filter({ hasText: "Checking" }).click();
  await addCashDeposit(page, { amount: "1000" });
  await page.goto("/");
  await expect(page.getByTestId("dashboard-tiles")).toContainText("Assets");
});

test("tile edit mode swaps a tile within the 3-cap and persists across reload", async ({ page }) => {
  // Seed a liquid asset so the "Liquid assets" tile has data to render.
  await page.goto("/");
  await createAccount(page, { name: "Checking", currency: "USD" });
  await page.reload();
  await page.getByTestId("account-row").filter({ hasText: "Checking" }).click();
  await addCashDeposit(page, { amount: "1000" });
  await page.goto("/");

  await page.getByRole("button", { name: "Edit tiles" }).click();
  // The three default tiles fill the cap, so a fourth is blocked until a slot
  // is freed. Confirm the cap, then swap one out for "Liquid assets".
  await expect(page.getByRole("checkbox", { name: /Liquid assets/i })).toBeDisabled();
  await page.getByRole("checkbox", { name: /Goals on track/i }).click();
  await page.getByRole("checkbox", { name: /Liquid assets/i }).click();
  await page.getByRole("button", { name: "Done editing tiles" }).click();
  await expect(page.getByTestId("dashboard-tiles")).toContainText("Liquid assets");

  await page.reload();
  await expect(page.getByTestId("dashboard-tiles")).toContainText("Liquid assets");
});
