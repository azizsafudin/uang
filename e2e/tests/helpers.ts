import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { expect } from "@playwright/test";

export const ADMIN = { name: "Avery Admin", email: "admin@e2e.test", password: "supersecret1" };

// Create the household + admin via the API and inject the session cookie into the browser
// context, so the test starts already authenticated. Call after backend.freshDb().
export async function seedHousehold(
  request: APIRequestContext,
  context: BrowserContext,
  apiURL: string,
  baseCurrency = "USD",
) {
  await request.post(`${apiURL}/onboarding/init`, {
    data: {
      householdName: "E2E Household",
      baseCurrency,
      email: ADMIN.email,
      name: ADMIN.name,
      password: ADMIN.password,
    },
  });
  await request.post(`${apiURL}/api/auth/sign-in/email`, {
    data: { email: ADMIN.email, password: ADMIN.password },
  });
  const state = await request.storageState();
  await context.addCookies(state.cookies);
}

// Open the "Add account" dialog from the dashboard and create a ledger account.
export async function createLedgerAccount(
  page: Page,
  opts: { name: string; currency?: string; opening?: string },
) {
  await page.getByRole("button", { name: "Add account" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByTestId("account-name").fill(opts.name);
  await dialog.getByTestId("account-currency").fill(opts.currency ?? "USD");
  if (opts.opening) await dialog.getByTestId("account-opening").fill(opts.opening);
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(dialog).toBeHidden();
}
