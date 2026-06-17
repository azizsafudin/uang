import { test, expect } from "./fixtures";
import { seedHousehold, ADMIN } from "./helpers";

test.beforeEach(async ({ backend, request, context }) => {
  await backend.freshDb();
  await seedHousehold(request, context, backend.apiURL);
});

test("sidebar navigates between dashboard and goals", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("networth-hero")).toBeVisible();

  await page.getByRole("link", { name: "Goals" }).click();
  await expect(page.getByRole("heading", { name: "Projection" })).toBeVisible();

  await page.getByRole("link", { name: "Dashboard" }).click();
  await expect(page.getByTestId("networth-hero")).toBeVisible();
});

test("sidebar navigates to Settings", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("networth-hero")).toBeVisible();

  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
});

test("user menu opens and signs out", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("networth-hero")).toBeVisible();

  // Scope by email — the name alone also matches the net-worth owner toggle.
  await page.getByRole("button", { name: new RegExp(ADMIN.email) }).click();
  const signOut = page.getByRole("menuitem", { name: "Sign out" });
  await expect(signOut).toBeVisible();
  await signOut.click();
  await expect(page).toHaveURL(/\/login/);
});

test("sidebar is absent on the login page", async ({ page, context }) => {
  // Drop the seeded session so the app routes us to /login.
  await context.clearCookies();
  await page.goto("/login");
  await expect(page.getByRole("link", { name: "Dashboard" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Goals" })).toHaveCount(0);
});
