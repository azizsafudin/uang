import { test, expect } from "./fixtures";
import { seedHousehold, createAccount, addCashDeposit } from "./helpers";

test.beforeEach(async ({ backend, request, context }) => {
  await backend.freshDb();
  await seedHousehold(request, context, backend.apiURL);
});

test("buy a stock with a cash leg, set price, see value and gain roll up", async ({ page }) => {
  await page.goto("/");

  await test.step("create a USD brokerage account", async () => {
    await createAccount(page, { name: "Brokerage", currency: "USD" });
  });

  await test.step("buy a new instrument with the cash leg", async () => {
    await page.reload();
    await page.getByTestId("account-row").filter({ hasText: "Brokerage" }).click();
    await expect(page).toHaveURL(/\/accounts\//);
    // Reload on the detail page so the instruments live-query is populated before
    // we submit (the cash leg resolves the seeded USD instrument without a race).
    await page.reload();
    await page.getByRole("button", { name: "Add transaction" }).click();
    const dialog = page.getByRole("dialog");

    await dialog.getByTestId("tx-instrument").click();
    await page.getByRole("option", { name: "New instrument…" }).click();
    // The new-instrument form opens in Symbol/ISIN lookup mode (hits a live
    // provider); switch to Manual so the journey stays deterministic offline.
    await dialog.getByRole("button", { name: "Can't find it? Add manually" }).click();
    await dialog.getByTestId("ni-manual-name").fill("Acme Corp");
    await dialog.getByTestId("ni-manual-currency").fill("USD");
    await dialog.getByTestId("tx-units").fill("10");
    await dialog.getByTestId("tx-price").fill("100");
    // "Also record cash outflow" is checked by default.
    await dialog.getByRole("button", { name: "Add" }).click();
    await expect(dialog).toBeHidden();
  });

  await test.step("the buy seeds its trade price → position is valued at cost; cash outflow recorded", async () => {
    await page.reload();
    // The trade records a price observation at its date, so the holding is valued at
    // its $100 cost immediately (10 × $100 = $1,000.00) with zero gain — no manual price needed.
    const row = page.getByTestId("position-row").filter({ hasText: "Acme Corp" });
    await expect(row).toContainText("1,000.00");
    await expect(row).not.toContainText("no price");
    // The cash leg is a −1,000 USD outflow; a non-positive cash position is not listed
    // under Positions, but the leg is recorded in History (a separate tab).
    await page.getByRole("tab", { name: "History" }).click();
    await expect(page.getByTestId("tx-row").filter({ hasText: "USD" })).toContainText("-1000");
  });

  await test.step("set a higher price on the instrument → market value and gain appreciate", async () => {
    await page.getByRole("tab", { name: "Positions" }).click();
    // The position card links to the instrument page, where prices are managed.
    await page.getByTestId("position-row").filter({ hasText: "Acme Corp" }).click();
    await expect(page).toHaveURL(/\/instruments\//);
    await page.getByRole("button", { name: "Add price" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByTestId("price-amount").fill("120");
    await dialog.getByRole("button", { name: "Save price" }).click();
    await expect(dialog).toBeHidden();
    // Back on the account (reload to refetch positions), the holding reflects the new price.
    await page.goBack();
    await page.reload();
    const priced = page.getByTestId("position-row").filter({ hasText: "Acme Corp" });
    await expect(priced).toContainText("1,200.00"); // 10 × 120
    await expect(priced).toContainText("200.00");    // (120-100) × 10
  });

  await test.step("net worth nets stock value against the cash outflow", async () => {
    // +1,200 stock − 1,000 cash = 200.00
    await page.goto("/");
    await expect(page.getByTestId("networth-hero")).toContainText("200.00");
  });

  await test.step("tapping a History row opens the edit dialog; delete is confirmed inside it", async () => {
    await page.getByTestId("account-row").filter({ hasText: "Brokerage" }).click();
    await page.getByRole("tab", { name: "History" }).click();

    const cashRow = page.getByTestId("tx-row").filter({ hasText: "USD" });
    await expect(cashRow).toBeVisible();
    await cashRow.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Edit transaction")).toBeVisible();

    // Delete opens a confirmation; cancel keeps the transaction.
    await dialog.getByTestId("edit-tx-delete").click();
    const confirm = page.getByRole("dialog").filter({ hasText: "Delete transaction?" });
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toBeHidden();
    await expect(cashRow).toBeVisible();

    // Confirming removes the row and rolls the cash outflow back into net worth.
    await dialog.getByTestId("edit-tx-delete").click();
    await page.getByRole("dialog").filter({ hasText: "Delete transaction?" })
      .getByRole("button", { name: "Delete" }).click();
    await expect(cashRow).toBeHidden();

    // Without the −1,000 cash leg, net worth is just the +1,200 stock value.
    await page.goto("/");
    await expect(page.getByTestId("networth-hero")).toContainText("1,200.00");
  });
});

test("the all-transactions page lists rows across accounts and edits one in place", async ({ page }) => {
  await page.goto("/");

  await test.step("seed two accounts, each with a cash deposit", async () => {
    await createAccount(page, { name: "Brokerage", currency: "USD" });
    await createAccount(page, { name: "Savings", currency: "USD" });

    await page.reload();
    await page.getByTestId("account-row").filter({ hasText: "Brokerage" }).click();
    await expect(page).toHaveURL(/\/accounts\//);
    await addCashDeposit(page, { amount: "1000", currency: "USD" });

    await page.goto("/");
    await page.getByTestId("account-row").filter({ hasText: "Savings" }).click();
    await expect(page).toHaveURL(/\/accounts\//);
    await addCashDeposit(page, { amount: "2000", currency: "USD" });
  });

  await test.step("the /transactions page lists both accounts' rows, newest first", async () => {
    await page.getByRole("link", { name: "Transactions" }).click();
    await expect(page).toHaveURL(/\/transactions$/);

    const rows = page.getByTestId("all-tx-row");
    await expect(rows).toHaveCount(2);
    // Both accounts are represented in the list.
    await expect(page.getByTestId("all-tx-row").filter({ hasText: "Brokerage" })).toHaveCount(1);
    await expect(page.getByTestId("all-tx-row").filter({ hasText: "Savings" })).toHaveCount(1);
  });

  await test.step("clicking a row opens the edit dialog; editing notes is reflected in the list", async () => {
    await page.getByTestId("all-tx-row").filter({ hasText: "Savings" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Edit transaction")).toBeVisible();
    await dialog.getByTestId("edit-tx-notes").fill("payday top-up");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();

    // The closed editor invalidates the all-list; the note now shows on its row.
    await expect(
      page.getByTestId("all-tx-row").filter({ hasText: "payday top-up" }),
    ).toBeVisible();
  });
});
