import { test, expect } from "./fixtures";
import { seedHousehold } from "./helpers";

test.beforeEach(async ({ backend, request, context }) => {
  await backend.freshDb();
  await seedHousehold(request, context, backend.apiURL);
});

test("sidebar navigates between dashboard, projections, and settings", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("networth-hero")).toBeVisible();

  // The sidebar nav links are present and drive navigation.
  await page.getByRole("link", { name: "Projections" }).click();
  await expect(page.getByRole("heading", { name: "Projections" })).toBeVisible();

  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  await page.getByRole("link", { name: "Dashboard" }).click();
  await expect(page.getByTestId("networth-hero")).toBeVisible();
});

test("sidebar is absent on the login page", async ({ page, context }) => {
  // Drop the seeded session so the app routes us to /login.
  await context.clearCookies();
  await page.goto("/login");
  await expect(page.getByRole("link", { name: "Dashboard" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Projections" })).toHaveCount(0);
});
