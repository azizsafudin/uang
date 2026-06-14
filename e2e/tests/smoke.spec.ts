import { test, expect } from "./fixtures";
import { seedHousehold } from "./helpers";

test.beforeEach(async ({ backend }) => {
  await backend.freshDb();
});

test("unseeded: onboarding screen renders", async ({ page }) => {
  await page.goto("/onboarding");
  await expect(page.getByText("Set up your household")).toBeVisible();
});

test("seeded: lands authenticated on the dashboard", async ({ page, context, request, backend }) => {
  await seedHousehold(request, context, backend.apiURL);
  await page.goto("/");
  await expect(page.getByText(/Net worth/i)).toBeVisible();
});
