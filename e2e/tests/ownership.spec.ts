import { test, expect } from "./fixtures";
import { seedHousehold, createAccount, selectCurrency, addCashDeposit, ADMIN } from "./helpers";

const PARTNER = { name: "Pat Partner", email: "partner@e2e.test", password: "supersecret2" };

test.beforeEach(async ({ backend, request, context }) => {
  await backend.freshDb();
  await seedHousehold(request, context, backend.apiURL);
});

test("shared vs personal accounts and the net-worth owner toggle", async ({ page }) => {
  await test.step("invite a second member", async () => {
    await page.goto("/settings");
    await page.getByTestId("invite-name").fill(PARTNER.name);
    await page.getByTestId("invite-email").fill(PARTNER.email);
    await page.getByTestId("invite-password").fill(PARTNER.password);
    await page.getByRole("button", { name: "Invite" }).click();
    await expect(page.getByText(PARTNER.email)).toBeVisible();
  });

  await test.step("create a personal account (admin only)", async () => {
    await page.goto("/");
    await createAccount(page, { name: "Mine", currency: "USD" });
  });

  await test.step("create a shared account (admin + partner)", async () => {
    await page.getByRole("button", { name: "Assets actions" }).click();
    await page.getByRole("menuitem", { name: "Add account" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByTestId("account-name").fill("Joint");
    await selectCurrency(page, dialog, "account-currency", "USD");
    // Admin is pre-checked; also check the partner to make it shared.
    await dialog.getByTestId("owner-option").filter({ hasText: PARTNER.name }).click();
    await dialog.getByRole("button", { name: "Create" }).click();
    await expect(dialog).toBeHidden();
  });

  await test.step("create a partner-only account (partner, not admin)", async () => {
    await page.getByRole("button", { name: "Assets actions" }).click();
    await page.getByRole("menuitem", { name: "Add account" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByTestId("account-name").fill("Theirs");
    await selectCurrency(page, dialog, "account-currency", "USD");
    // Drop admin (pre-checked) and add the partner, making it partner-only.
    await dialog.getByTestId("owner-option").filter({ hasText: ADMIN.name }).click();
    await dialog.getByTestId("owner-option").filter({ hasText: PARTNER.name }).click();
    await dialog.getByRole("button", { name: "Create" }).click();
    await expect(dialog).toBeHidden();
  });

  await test.step("fund the personal account with 500", async () => {
    await page.reload();
    await page.getByTestId("account-row").filter({ hasText: "Mine" }).click();
    await expect(page).toHaveURL(/\/accounts\//);
    await addCashDeposit(page, { amount: "500", currency: "USD" });
    await page.goto("/");
  });

  await test.step("fund the shared account with 2000", async () => {
    await page.getByTestId("account-row").filter({ hasText: "Joint" }).click();
    await expect(page).toHaveURL(/\/accounts\//);
    await addCashDeposit(page, { amount: "2000", currency: "USD" });
    await page.goto("/");
  });

  await test.step("household headline = 2500; all accounts listed", async () => {
    await page.reload(); // read server truth, not the optimistic insert's refetch race
    await expect(page.getByTestId("account-row").filter({ hasText: "Mine" })).toBeVisible();
    await expect(page.getByTestId("account-row").filter({ hasText: "Joint" })).toBeVisible();
    await expect(page.getByTestId("account-row").filter({ hasText: "Theirs" })).toBeVisible();
    await expect(page.getByTestId("networth-hero")).toContainText("2,500.00");
  });

  await test.step("admin view = 500; list shows admin's accounts incl. shared, hides partner-only", async () => {
    // Exact match targets the owner toggle button (whose label is exactly the
    // member name), not the account-list group headers that embed the name.
    await page.getByRole("button", { name: ADMIN.name, exact: true }).click();
    await expect(page.getByTestId("networth-hero")).toContainText("500.00");
    await expect(page.getByTestId("networth-hero")).not.toContainText("2,500.00");
    // Admin owns Mine (solo) and Joint (shared) — both shown; Theirs is hidden.
    await expect(page.getByTestId("account-row").filter({ hasText: "Mine" })).toBeVisible();
    await expect(page.getByTestId("account-row").filter({ hasText: "Joint" })).toBeVisible();
    await expect(page.getByTestId("account-row").filter({ hasText: "Theirs" })).toHaveCount(0);
  });

  await test.step("partner view: shows partner's accounts incl. shared, hides admin-only", async () => {
    await page.getByRole("button", { name: PARTNER.name, exact: true }).click();
    await expect(page.getByTestId("account-row").filter({ hasText: "Theirs" })).toBeVisible();
    await expect(page.getByTestId("account-row").filter({ hasText: "Joint" })).toBeVisible();
    await expect(page.getByTestId("account-row").filter({ hasText: "Mine" })).toHaveCount(0);
  });
});
