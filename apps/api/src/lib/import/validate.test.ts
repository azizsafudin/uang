import { expect, test } from "bun:test";
import { validateParserConfig } from "./validate";
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
