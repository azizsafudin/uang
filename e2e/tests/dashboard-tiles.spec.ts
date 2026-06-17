import { test, expect } from "./fixtures";
import { seedHousehold, createAccount, addCashDeposit } from "./helpers";

// The companion dashboard tiles are hidden pending a full refactor of that area
// (the tile registry/components are kept but no longer rendered on the
// dashboard). Skip these specs until the new tiles UX lands.
test.describe.skip("dashboard tiles (hidden pending refactor)", () => {

test.beforeEach(async ({ backend, request, context }) => {
  await backend.freshDb();
  await seedHousehold(request, context, backend.apiURL);
});

test("dashboard shows hero + tiles, Add account in Assets header", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("dashboard-hero")).toBeVisible();
  // With nothing seeded yet there are no numeric tiles to show, so the grid is
  // empty (collapsed); assert it's rendered. It gains content once funded below.
  await expect(page.getByTestId("dashboard-tiles")).toBeAttached();
  // Add account now lives behind the Assets section actions (dot) menu.
  await expect(page.getByRole("button", { name: "Assets actions" })).toBeVisible();
  await page.getByRole("button", { name: "Assets actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Add account" })).toBeVisible();
  // Close the menu so the createAccount helper opens it cleanly below.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem", { name: "Add account" })).toBeHidden();

  // Fund an account so the Assets tile becomes available.
  await createAccount(page, { name: "Checking", currency: "USD" });
  await page.reload();
  await page.getByTestId("account-row").filter({ hasText: "Checking" }).click();
  await addCashDeposit(page, { amount: "1000" });
  await page.goto("/");
  await expect(page.getByTestId("dashboard-tiles")).toContainText("Assets");
});

test("tile edit mode swaps a tile within the 3-cap and persists across reload", async ({ page }) => {
  // Fund an account so net worth is positive and the "Simple income" tile renders.
  await page.goto("/");
  await createAccount(page, { name: "Checking", currency: "USD" });
  await page.reload();
  await page.getByTestId("account-row").filter({ hasText: "Checking" }).click();
  await addCashDeposit(page, { amount: "1000" });
  await page.goto("/");

  await page.getByRole("button", { name: "Edit tiles" }).click();
  // The three default tiles fill the cap, so a fourth is blocked until a slot
  // is freed. Confirm the cap, then swap one out for "Simple income".
  await expect(page.getByRole("checkbox", { name: /Simple income/i })).toBeDisabled();
  await page.getByRole("checkbox", { name: /Goals on track/i }).click();
  await page.getByRole("checkbox", { name: /Simple income/i }).click();
  await page.getByRole("button", { name: "Done editing tiles" }).click();
  await expect(page.getByTestId("dashboard-tiles")).toContainText("Simple income");

  await page.reload();
  await expect(page.getByTestId("dashboard-tiles")).toContainText("Simple income");
});

});
