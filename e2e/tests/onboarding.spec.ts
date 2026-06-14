import { test, expect } from "./fixtures";
import { ADMIN, selectCurrency } from "./helpers";

test.beforeEach(async ({ backend }) => {
  await backend.freshDb(); // unseeded: a fresh, empty (migrated) DB
});

test("first-run onboarding creates a household and lands on the dashboard", async ({ page }) => {
  await test.step("fill and submit the onboarding form", async () => {
    await page.goto("/onboarding");
    await page.getByTestId("onboarding-household").fill("The E2E Household");
    await selectCurrency(page, page, "onboarding-currency", "USD");
    await page.getByTestId("onboarding-name").fill(ADMIN.name);
    await page.getByTestId("onboarding-email").fill(ADMIN.email);
    await page.getByTestId("onboarding-password").fill(ADMIN.password);
    await page.getByRole("button", { name: "Create household" }).click();
  });

  await test.step("lands authenticated on the dashboard with a zero net worth", async () => {
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("networth-hero")).toContainText("0.00");
  });
});
