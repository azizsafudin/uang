import { test, expect } from "./fixtures";
import { seedHousehold, createAccount } from "./helpers";

test.beforeEach(async ({ backend, request, context }) => {
  await backend.freshDb();
  await seedHousehold(request, context, backend.apiURL);
});

test("plan page: projection chart, create a goal, and goal card appears", async ({ page }) => {
  await page.goto("/");

  await test.step("create a cash asset account", async () => {
    await createAccount(page, { name: "Savings", currency: "USD" });
  });

  await test.step("navigate to /goals via sidebar", async () => {
    await page.getByRole("link", { name: "Goals" }).click();
    await expect(page.getByRole("heading", { name: "Projection" })).toBeVisible();
  });

  await test.step("projection chart is visible", async () => {
    await expect(page.getByTestId("projection-chart")).toBeVisible();
  });

  await test.step("open New goal dialog and fill it in", async () => {
    await page.getByRole("button", { name: "New goal" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Name: react-hook-form register("name") attaches name="name" to the input.
    await dialog.locator('input[name="name"]').fill("Retirement Fund");

    // Target amount: MoneyInput is a Controller without a forwarded name attribute.
    // It has inputMode="decimal". The first such input in the dialog is the Target field.
    await dialog.locator('input[inputmode="decimal"]').first().fill("100000");

    // Target date: register("targetDate") → name="targetDate" on the date input.
    await dialog.locator('input[name="targetDate"]').fill("2040-01-01");

    // Check the "Savings" account in the Funded by list.
    // Each account label has data-testid="assign-<id>". Click the first checkbox.
    await dialog.locator('[data-testid^="assign-"] input[type="checkbox"]').first().check();
  });

  await test.step("submit the form", async () => {
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Create" }).click();
    await expect(dialog).toBeHidden();
  });

  await test.step("goal card is visible in the goals list", async () => {
    await expect(page.getByTestId("goal-card").first()).toBeVisible();
    await expect(page.getByTestId("goal-card").first()).toContainText("Retirement Fund");
  });
});
