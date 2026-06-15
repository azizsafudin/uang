import { test, expect } from "./fixtures";
import { seedHousehold, createAccount } from "./helpers";

const CSV = "Date,Description,Amount\n2026-02-01,COFFEE BEAN,-4.50\n2026-02-02,SALARY,2500.00\n";

test.beforeEach(async ({ backend, request, context }) => {
  await backend.freshDb();
  await seedHousehold(request, context, backend.apiURL);
});

test("drop a CSV, map columns, see live preview, import", async ({ page }) => {
  await page.goto("/");
  await createAccount(page, { name: "Checking", currency: "USD" });
  await page.reload();
  await page.getByTestId("account-row").filter({ hasText: "Checking" }).click();
  await expect(page).toHaveURL(/\/accounts\//);

  await page.getByRole("button", { name: "Import statement" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByTestId("import-file").setInputFiles({ name: "feb.csv", mimeType: "text/csv", buffer: Buffer.from(CSV) });

  // Create-new mapping
  await dialog.getByTestId("map-date").click();
  await page.getByRole("option", { name: "Date" }).click();
  await dialog.getByTestId("map-dateformat").fill("YYYY-MM-DD");
  await dialog.getByTestId("map-desc").click();
  await page.getByRole("option", { name: "Description" }).click();
  await dialog.getByTestId("map-amount").click();
  await page.getByRole("option", { name: "Amount" }).click();

  // Live preview appears (debounced 400ms — Playwright auto-waits via toBeVisible)
  await expect(dialog.getByTestId("preview-summary")).toContainText("2 found");

  await dialog.getByTestId("import-run").click();
  await expect(dialog.getByTestId("import-row")).toHaveCount(2);
  await dialog.getByTestId("import-commit").click();
  await expect(dialog).toBeHidden();
});
