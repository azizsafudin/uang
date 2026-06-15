import { expect, test } from "bun:test";
import { validateParserConfig, validateFingerprint } from "./validate";
import type { CsvParserConfig } from "./types";

const good: CsvParserConfig = {
  version: 1, format: "csv", csv: { delimiter: ",", headerRow: 0, skipRows: 0 },
  fields: {
    date: { column: "Date", format: "DD MMM YYYY" },
    description: { column: "Description" },
    amount: { mode: "single", column: "Amount", decimal: ".", thousands: ",", sign: "negativeIsDebit" },
  },
};

test("accepts a well-formed CSV config and returns it typed", () => {
  expect(validateParserConfig(good)).toEqual(good);
});

test("rejects malformed configs with a descriptive error", () => {
  expect(() => validateParserConfig(null)).toThrow("invalid_config");
  expect(() => validateParserConfig({ version: 1, format: "csv" })).toThrow("invalid_config");
  expect(() => validateParserConfig({ ...good, fields: { ...good.fields, amount: { mode: "bogus" } } })).toThrow("invalid_config");
});

test("rejects negative headerRow/skipRows and multi-char delimiter", () => {
  expect(() => validateParserConfig({ ...good, csv: { ...good.csv, headerRow: -1 } })).toThrow("invalid_config");
  expect(() => validateParserConfig({ ...good, csv: { ...good.csv, skipRows: -1 } })).toThrow("invalid_config");
  expect(() => validateParserConfig({ ...good, csv: { ...good.csv, delimiter: ";;" } })).toThrow("invalid_config");
});

test("validateFingerprint accepts good and rejects bad fingerprints", () => {
  const fp = { format: "csv", delimiter: ",", headerColumns: ["a", "b"] };
  expect(validateFingerprint(fp)).toEqual(fp);
  expect(() => validateFingerprint(null)).toThrow("invalid_fingerprint");
  expect(() => validateFingerprint({ ...fp, headerColumns: "x" })).toThrow("invalid_fingerprint");
  expect(() => validateFingerprint({ ...fp, delimiter: ";;" })).toThrow("invalid_fingerprint");
});

// ---- PDF validation tests ----

const PDF_OK = {
  version: 1, format: "pdf",
  region: { startAfter: "Transaction Details", stopAt: "Closing Balance" },
  transactionLine: "^(?<date>\\d{2}/\\d{2}/\\d{4})\\s+(?<description>.+?)\\s+(?<amount>-?[\\d,]+\\.\\d{2})$",
  date: { format: "DD/MM/YYYY" },
  amount: { decimal: ".", thousands: ",", sign: "negativeIsDebit" },
  multiline: { continuationAppendsTo: "description" },
};

test("validateParserConfig accepts a well-formed PDF config", () => {
  const cfg = validateParserConfig(PDF_OK);
  expect(cfg.format).toBe("pdf");
  if (cfg.format !== "pdf") throw new Error("narrow");
  expect(cfg.transactionLine).toContain("(?<date>");
  expect(cfg.region?.startAfter).toBe("Transaction Details");
  expect(cfg.multiline?.continuationAppendsTo).toBe("description");
});

test("validateParserConfig rejects a PDF config missing the date/amount named groups", () => {
  expect(() => validateParserConfig({ ...PDF_OK, transactionLine: "^(.+)$" })).toThrow();
});

test("validateParserConfig rejects a ReDoS-prone transactionLine (nested quantifier)", () => {
  expect(() => validateParserConfig({ ...PDF_OK, transactionLine: "(?<date>(a+)+)(?<amount>b)" })).toThrow();
});

test("validateParserConfig rejects an over-long transactionLine", () => {
  expect(() => validateParserConfig({ ...PDF_OK, transactionLine: "(?<date>a)(?<amount>b)" + "x".repeat(1001) })).toThrow();
});

test("validateParserConfig rejects an uncompilable transactionLine", () => {
  expect(() => validateParserConfig({ ...PDF_OK, transactionLine: "(?<date>(?<amount>" })).toThrow();
});

test("validateFingerprint accepts a PDF fingerprint", () => {
  const fp = validateFingerprint({ format: "pdf", markers: ["dbs bank", "statement of account"] });
  expect(fp.format).toBe("pdf");
  if (fp.format !== "pdf") throw new Error("narrow");
  expect(fp.markers).toEqual(["dbs bank", "statement of account"]);
});

test("validateFingerprint rejects a PDF fingerprint with non-string markers", () => {
  expect(() => validateFingerprint({ format: "pdf", markers: [1, 2] })).toThrow();
});
