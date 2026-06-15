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
