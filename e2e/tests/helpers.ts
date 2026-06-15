import type { APIRequestContext, BrowserContext, Locator, Page } from "@playwright/test";
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
  await request.post(`${apiURL}/api/onboarding/init`, {
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

// Configure a (dummy) AI provider so the "Import statement" entry point is enabled.
// The import journeys don't actually call the model — they map manually or use a saved
// parser — so a non-reachable base URL is fine; it just flips the aiEnabled gate on.
export async function enableAiProvider(request: APIRequestContext, apiURL: string) {
  await request.patch(`${apiURL}/api/settings`, {
    data: { aiBaseUrl: "http://127.0.0.1:1/v1", aiModel: "test-model" },
  });
}

// Pick a currency in a CurrencySelect (base-ui Select: click the trigger, then
// the option). Options render in a portal at the page root, so they're queried
// from `page`. Options are labelled "CODE (symbol)", so match by the code prefix.
export async function selectCurrency(
  page: Page,
  scope: Page | Locator,
  testId: string,
  code: string,
) {
  await scope.getByTestId(testId).click();
  await page.getByRole("option", { name: new RegExp(`^${code} `) }).click();
}

// Open the "Add account" dialog from the dashboard and create an account.
export async function createAccount(
  page: Page,
  opts: { name: string; currency?: string },
) {
  await page.getByRole("button", { name: "Assets actions" }).click();
  await page.getByRole("menuitem", { name: "Add account" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByTestId("account-name").fill(opts.name);
  await selectCurrency(page, dialog, "account-currency", opts.currency ?? "USD");
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(dialog).toBeHidden();
}

// On an account detail page, add a cash deposit using the auto-seeded currency
// instrument for `currency` (option label looks like "USD — US Dollar (cash)").
export async function addCashDeposit(
  page: Page,
  opts: { amount: string; currency?: string },
) {
  const code = opts.currency ?? "USD";
  // Reload first so the instruments live-query refetches the account's freshly
  // seeded currency instrument before we open the Select (avoids a load race).
  await page.reload();
  await page.getByRole("button", { name: "Add transaction" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByTestId("tx-instrument").click();
  await page.getByRole("option", { name: new RegExp(`${code} .* \\(cash\\)`) }).click();
  await dialog.getByTestId("tx-amount").fill(opts.amount);
  await dialog.getByRole("button", { name: "Add" }).click();
  await expect(dialog).toBeHidden();
}
