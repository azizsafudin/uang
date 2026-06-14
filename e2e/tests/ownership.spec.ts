import { test, expect } from "./fixtures";
import { seedHousehold, createLedgerAccount, ADMIN } from "./helpers";

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
    await createLedgerAccount(page, { name: "Mine", currency: "USD", opening: "500" });
  });

  await test.step("create a shared account (admin + partner)", async () => {
    await page.getByRole("button", { name: "Add account" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByTestId("account-name").fill("Joint");
    await dialog.getByTestId("account-currency").fill("USD");
    await dialog.getByTestId("account-opening").fill("2000");
    // Admin is pre-checked; also check the partner to make it shared.
    await dialog.getByTestId("owner-option").filter({ hasText: PARTNER.name }).click();
    await dialog.getByRole("button", { name: "Create" }).click();
    await expect(dialog).toBeHidden();
  });

  await test.step("household headline = 2500; both accounts listed", async () => {
    await page.reload(); // read server truth, not the optimistic insert's refetch race
    await expect(page.getByTestId("account-row").filter({ hasText: "Mine" })).toBeVisible();
    await expect(page.getByTestId("account-row").filter({ hasText: "Joint" })).toBeVisible();
    await expect(page.getByTestId("networth-hero")).toContainText("2,500.00");
  });

  await test.step("admin view = 500 (shared excluded); list unchanged", async () => {
    await page.getByRole("button", { name: ADMIN.name }).click();
    await expect(page.getByTestId("networth-hero")).toContainText("500.00");
    await expect(page.getByTestId("networth-hero")).not.toContainText("2,500.00");
    // The account list still shows everything regardless of the toggle.
    await expect(page.getByTestId("account-row").filter({ hasText: "Joint" })).toBeVisible();
  });
});
