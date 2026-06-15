import { expect, test } from "bun:test";
import { runPdfParser } from "./pdf";
import type { PdfParserConfig } from "./types";

const CFG: PdfParserConfig = {
  version: 1, format: "pdf",
  region: { startAfter: "Transaction Details", stopAt: "Closing Balance" },
  transactionLine: "^(?<date>\\d{2}/\\d{2}/\\d{4})\\s+(?<description>.+?)\\s+(?<amount>-?[\\d,]+\\.\\d{2})$",
  date: { format: "DD/MM/YYYY" },
  amount: { decimal: ".", thousands: ",", sign: "negativeIsDebit" },
};

const TEXT = [
  "DBS BANK STATEMENT",
  "Account 1234",
  "Transaction Details",
  "02/01/2026 COFFEE BEAN -4.50",
  "03/01/2026 SALARY 2,500.00",
  "Closing Balance 9,999.00",
  "Page 1 of 1",
].join("\n");

test("extracts only rows inside the region and maps date/description/amount", () => {
  const rows = runPdfParser(TEXT, CFG, "USD");
  expect(rows.length).toBe(2);
  expect(rows[0]).toMatchObject({ date: "2026-01-02", amountMinor: -450, description: "COFFEE BEAN" });
  expect(rows[1]).toMatchObject({ date: "2026-01-03", amountMinor: 250000, description: "SALARY" });
  expect(rows[0].raw.line).toBe("02/01/2026 COFFEE BEAN -4.50");
});

test("positiveIsDebit flips the sign", () => {
  const rows = runPdfParser(TEXT, { ...CFG, amount: { ...CFG.amount, sign: "positiveIsDebit" } }, "USD");
  expect(rows[0].amountMinor).toBe(450);   // -4.50 parsed, then negated
  expect(rows[1].amountMinor).toBe(-250000);
});

test("without a region, all matching lines are parsed and non-matching ignored", () => {
  const rows = runPdfParser(TEXT, { ...CFG, region: undefined }, "USD");
  expect(rows.length).toBe(2);
});

test("multiline continuation appends non-matching lines to the previous description", () => {
  const text = [
    "Transaction Details",
    "02/01/2026 COFFEE BEAN -4.50",
    "  ROASTERS PTE LTD",
    "Closing Balance",
  ].join("\n");
  const rows = runPdfParser(text, { ...CFG, multiline: { continuationAppendsTo: "description" } }, "USD");
  expect(rows.length).toBe(1);
  expect(rows[0].description).toBe("COFFEE BEAN ROASTERS PTE LTD");
});

test("a matching line with an unparseable date is flagged as an error row", () => {
  const text = ["Transaction Details", "99/99/2026 BAD -1.00", "Closing Balance"].join("\n");
  const rows = runPdfParser(text, CFG, "USD");
  expect(rows.length).toBe(1);
  expect(rows[0].error).toBe("unparseable_date");
});
