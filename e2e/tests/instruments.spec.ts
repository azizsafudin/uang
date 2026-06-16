import { test, expect } from "./fixtures";
import { seedHousehold, createAccount } from "./helpers";

test.beforeEach(async ({ backend, request, context }) => {
  await backend.freshDb();
  await seedHousehold(request, context, backend.apiURL);
});

test("manage an instrument: list, holders, price history, edit, delete", async ({ page }) => {
  await page.goto("/");

  await test.step("setup: create a brokerage account and buy a stock", async () => {
    await createAccount(page, { name: "Brokerage", currency: "USD" });

    await page.reload();
    await page.getByTestId("account-row").filter({ hasText: "Brokerage" }).click();
    await expect(page).toHaveURL(/\/accounts\//);
    // Reload so the instruments live-query is populated before we submit
    // (the cash leg resolves the seeded USD instrument without a race).
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

  await test.step("the Instruments list shows Acme with a holder + latest price", async () => {
    await page.getByRole("link", { name: "Instruments" }).click();
    await expect(page).toHaveURL(/\/instruments$/);
    // Reload to assert against server truth: holderCount + latest price are
    // server-derived fields the collection must refetch.
    await page.reload();
    const row = page.getByTestId("instrument-row").filter({ hasText: "Acme Corp" });
    await expect(row).toBeVisible();
    // Created implicitly by the buy: one holding account, and the trade seeds a price.
    await expect(row).toContainText("1 account");
    await expect(row).toContainText("100");
  });

  await test.step("the detail page lists the Brokerage account as a holder", async () => {
    await page.getByTestId("instrument-row").filter({ hasText: "Acme Corp" }).click();
    await expect(page).toHaveURL(/\/instruments\//);
    const heldBy = page.getByRole("link", { name: /Brokerage/ });
    await expect(heldBy).toBeVisible();
    await expect(heldBy).toContainText("10 units");
  });

  await test.step("add a manual price → it shows in the price history", async () => {
    await page.getByRole("button", { name: "Add price" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByTestId("price-amount").fill("130");
    await dialog.getByRole("button", { name: "Save price" }).click();
    await expect(dialog).toBeHidden();

    await page.reload();
    await expect(
      page.getByTestId("price-row").filter({ hasText: "130" }),
    ).toBeVisible();
  });

  await test.step("edit the instrument name via the Edit dialog", async () => {
    await page.getByRole("button", { name: "Edit" }).click();
    const dialog = page.getByRole("dialog");
    const nameField = dialog.getByRole("textbox").first();
    await nameField.fill("Acme Corporation");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();

    await page.reload();
    await expect(
      page.getByRole("heading", { name: /Acme Corporation/ }),
    ).toBeVisible();
  });

  await test.step("delete the instrument via the confirm dialog → gone from the list", async () => {
    await page.getByRole("button", { name: "Delete…" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: /Delete "Acme Corporation"/ })).toBeVisible();
    const confirm = dialog.getByRole("button", { name: "Delete permanently" });
    await expect(confirm).toBeDisabled();
    // Type the exact name to enable the destructive button.
    await dialog.getByPlaceholder("Acme Corporation").fill("Acme Corporation");
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect(page).toHaveURL(/\/instruments$/);
    await page.reload();
    await expect(
      page.getByTestId("instrument-row").filter({ hasText: "Acme" }),
    ).toHaveCount(0);
  });
});

test("Add instrument dialog (Manual mode) creates an instrument from /instruments", async ({ page }) => {
  await page.goto("/instruments");
  await expect(page).toHaveURL(/\/instruments$/);

  await test.step("open the Add instrument dialog and switch to Manual mode", async () => {
    await page.getByTestId("add-instrument").click();
    const dialog = page.getByRole("dialog");
    // The form opens in Symbol/ISIN lookup mode (live provider); Manual is the
    // deterministic, offline path the e2e suite can rely on.
    await expect(dialog.getByTestId("ni-mode-symbol")).toBeVisible();
    await dialog.getByRole("button", { name: "Can't find it? Add manually" }).click();
    await dialog.getByTestId("ni-manual-name").fill("Gold Bar");
    await dialog.getByTestId("ni-manual-currency").fill("USD");
    await dialog.getByTestId("add-instrument-submit").click();
    await expect(dialog).toBeHidden();
  });

  await test.step("the new instrument appears in the list with no price (—)", async () => {
    await page.reload();
    const row = page.getByTestId("instrument-row").filter({ hasText: "Gold Bar" });
    await expect(row).toBeVisible();
    // Manual instruments carry no looked-up price until one is added.
    await expect(row).toContainText("—");
  });
});
