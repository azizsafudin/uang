import { test, expect } from "./fixtures";
import { seedHousehold, createAccount } from "./helpers";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const PDF_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../apps/api/src/lib/import/fixtures/sample-statement.pdf",
);

// Markers match what fingerprintPdf() produces from the sample-statement.pdf text:
// - "dbs bank statement of account"  (line 1, no date/amount)
// - "customer service 1800 111 1111" (line 2, no date/amount patterns)
// - "transaction details"             (line 3, section header)
// - "page 1 of 1"                    (line 7, footer)
// Lines 4-6 are skipped (contain dates or amounts).
const PDF_PARSER = {
  id: "dbs-pdf",
  name: "DBS PDF",
  sourceFormat: "pdf",
  origin: "manual",
  config: {
    version: 1,
    format: "pdf",
    region: { startAfter: "Transaction Details", stopAt: "Closing Balance" },
    transactionLine:
      "^(?<date>\\d{2}/\\d{2}/\\d{4})\\s+(?<description>.+?)\\s+(?<amount>-?[\\d,]+\\.\\d{2})$",
    date: { format: "DD/MM/YYYY" },
    amount: { decimal: ".", thousands: ",", sign: "negativeIsDebit" },
  },
  fingerprint: {
    format: "pdf",
    markers: [
      "dbs bank statement of account",
      "customer service 1800 111 1111",
      "transaction details",
      "page 1 of 1",
    ],
  },
};

test.beforeEach(async ({ backend, request, context }) => {
  await backend.freshDb();
  await seedHousehold(request, context, backend.apiURL);
  // Seed a saved PDF parser so detection matches on upload (authed via injected cookie).
  await request.post(`${backend.apiURL}/api/import-parsers`, { data: PDF_PARSER });
});

test("import a PDF statement into an account", async ({ page }) => {
  await page.goto("/");
  await createAccount(page, { name: "Checking", currency: "USD" });

  // Live-query/optimistic timing: reload so the freshly-created account row is
  // present before we click it.
  await page.reload();
  await page.getByTestId("account-row").filter({ hasText: "Checking" }).click();
  await expect(page).toHaveURL(/\/accounts\//);

  await page.getByRole("button", { name: "Import statement" }).click();
  const dialog = page.getByRole("dialog");

  // Upload the PDF from a file buffer.
  await dialog.getByTestId("import-file").setInputFiles({
    name: "stmt.pdf",
    mimeType: "application/pdf",
    buffer: readFileSync(PDF_PATH),
  });

  // The seeded parser should be auto-selected as a confident match (Jaccard >= 0.6).
  await expect(dialog.getByTestId("import-parser")).toContainText("DBS PDF");

  await dialog.getByTestId("import-run").click();

  // Review screen shows 2 rows; commit them.
  await expect(dialog.getByTestId("import-row")).toHaveCount(2);
  await dialog.getByTestId("import-commit").click();
  await expect(dialog).toBeHidden();

  // Navigate to History tab to see the imported transactions.
  await page.getByRole("tab", { name: "History" }).click();

  // The two transactions now appear in the account history.
  await expect(page.getByText("SALARY")).toBeVisible();
  await expect(page.getByText("COFFEE BEAN")).toBeVisible();
});
