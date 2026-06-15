import { expect, test } from "bun:test";
import { parseDelimited, parseCsv } from "./csv";
import type { CsvParserConfig } from "./types";

test("parseDelimited handles quotes, embedded commas, and CRLF", () => {
  const rows = parseDelimited('a,b\r\n"x,y","he said ""hi"""\n', ",");
  expect(rows).toEqual([["a", "b"], ["x,y", 'he said "hi"']]);
});

const dbsConfig: CsvParserConfig = {
  version: 1, format: "csv",
  csv: { delimiter: ",", headerRow: 0, skipRows: 0 },
  fields: {
    date: { column: "Date", format: "DD MMM YYYY" },
    description: { column: "Description" },
    amount: { mode: "single", column: "Amount", decimal: ".", thousands: ",", sign: "negativeIsDebit" },
  },
  rowFilter: { dropIfBlank: ["date", "amount"] },
};

test("parseCsv maps rows to canonical form (single signed amount)", () => {
  const csv = [
    "Date,Description,Amount",
    "01 Feb 2026,COFFEE BEAN,-4.50",
    "03 Feb 2026,SALARY,3,000.00",     // note: thousands inside an unquoted field would split — see below
  ].join("\n");
  // Use a quoted thousands value to keep the field intact:
  const csv2 = [
    "Date,Description,Amount",
    "01 Feb 2026,COFFEE BEAN,-4.50",
    '03 Feb 2026,SALARY,"3,000.00"',
  ].join("\n");
  const rows = parseCsv(csv2, dbsConfig, "USD");
  expect(rows.length).toBe(2);
  expect(rows[0]).toMatchObject({ date: "2026-02-01", amountMinor: -450, description: "COFFEE BEAN" });
  expect(rows[1]).toMatchObject({ date: "2026-02-03", amountMinor: 300000, description: "SALARY" });
});

test("positiveIsDebit flips the sign", () => {
  const cfg: CsvParserConfig = { ...dbsConfig, fields: { ...dbsConfig.fields,
    amount: { mode: "single", column: "Amount", decimal: ".", thousands: ",", sign: "positiveIsDebit" } } };
  const rows = parseCsv("Date,Description,Amount\n01 Feb 2026,FEE,5.00", cfg, "USD");
  expect(rows[0].amountMinor).toBe(-500);
});

test("debitCredit mode computes credit - debit", () => {
  const cfg: CsvParserConfig = {
    version: 1, format: "csv", csv: { delimiter: ",", headerRow: 0, skipRows: 0 },
    fields: {
      date: { column: "Date", format: "YYYY-MM-DD" },
      description: { column: "Desc" },
      amount: { mode: "debitCredit", debitColumn: "Debit", creditColumn: "Credit", decimal: ".", thousands: "," },
    },
  };
  const csv = "Date,Desc,Debit,Credit\n2026-02-01,ATM,100.00,\n2026-02-02,PAY,,2500.00";
  const rows = parseCsv(csv, cfg, "USD");
  expect(rows[0].amountMinor).toBe(-10000); // debit
  expect(rows[1].amountMinor).toBe(250000); // credit
});

test("unparseable date/amount yields an error row; dropIfBlank skips noise", () => {
  const csv = [
    "Date,Description,Amount",
    "garbage,FOO,1.00",       // bad date -> error row
    ",,",                     // all blank -> dropped (date & amount blank)
  ].join("\n");
  const rows = parseCsv(csv, dbsConfig, "USD");
  expect(rows.length).toBe(1);
  expect(rows[0].error).toBeDefined();
});
