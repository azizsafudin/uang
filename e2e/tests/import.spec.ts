import { test, expect } from "./fixtures";
import { seedHousehold, createAccount, enableAiProvider, ADMIN } from "./helpers";

const CSV = "Date,Description,Amount\n2026-02-01,COFFEE BEAN,-4.50\n2026-02-02,SALARY,2500.00\n";

test.beforeEach(async ({ backend, request, context }) => {
  await backend.freshDb();
  await seedHousehold(request, context, backend.apiURL);
  await enableAiProvider(request, backend.apiURL); // import entry point requires AI configured
});

test("import a CSV statement into an account", async ({ page }) => {
  await page.goto("/");
  await createAccount(page, { name: "Checking", currency: "USD" });

  // Live-query/optimistic timing: reload so the freshly-created account row is
  // present before we click it (matches accounts.spec / transactions.spec).
  await page.reload();
  await page.getByTestId("account-row").filter({ hasText: "Checking" }).click();
  await expect(page).toHaveURL(/\/accounts\//);

  await page.getByRole("button", { name: "Import statement" }).click();
  const dialog = page.getByRole("dialog");

  // Upload the CSV from an in-memory buffer.
  await dialog.getByTestId("import-file").setInputFiles({
    name: "feb.csv", mimeType: "text/csv", buffer: Buffer.from(CSV),
  });

  // No saved parser yet -> creating a new one. With AI on, mapping lives behind
  // the "Parser details" disclosure — open it to map columns manually.
  await dialog.getByTestId("parser-details-toggle").click();
  await dialog.getByTestId("map-date").click();
  await page.getByRole("option", { name: "Date" }).click();
  await dialog.getByTestId("map-dateformat").fill("YYYY-MM-DD");
  await dialog.getByTestId("map-desc").click();
  await page.getByRole("option", { name: "Description" }).click();
  await dialog.getByTestId("map-amount").click();
  await page.getByRole("option", { name: "Amount" }).click();

  await dialog.getByTestId("import-run").click();

  // Review screen shows 2 rows; commit them.
  await expect(dialog.getByTestId("import-row")).toHaveCount(2);
  await dialog.getByTestId("import-commit").click();
  await expect(dialog).toBeHidden();

  // Navigate to History tab to see the imported transactions.
  await page.getByRole("tab", { name: "History" }).click();

  // The two transactions now appear in the account history (as notes).
  await expect(page.getByText("SALARY")).toBeVisible();
  await expect(page.getByText("COFFEE BEAN")).toBeVisible();
});
