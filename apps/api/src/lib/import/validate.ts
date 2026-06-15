import type { CsvParserConfig, ParserConfig } from "./types";

function fail(): never { throw new Error("invalid_config"); }
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function str(v: unknown): string { if (typeof v !== "string") fail(); return v; }
function num(v: unknown): number { if (typeof v !== "number") fail(); return v; }

export function validateParserConfig(input: unknown): ParserConfig {
  if (!isObj(input)) fail();
  if (input.version !== 1) fail();
  if (input.format !== "csv") fail();

  const csv = input.csv;
  if (!isObj(csv)) fail();
  const csvBlock = { delimiter: str(csv.delimiter), headerRow: num(csv.headerRow), skipRows: num(csv.skipRows) };

  const fields = input.fields;
  if (!isObj(fields)) fail();
  const date = fields.date; if (!isObj(date)) fail();
  const description = fields.description; if (!isObj(description)) fail();
  const amount = fields.amount; if (!isObj(amount)) fail();

  let amountBlock: CsvParserConfig["fields"]["amount"];
  if (amount.mode === "single") {
    if (amount.sign !== "negativeIsDebit" && amount.sign !== "positiveIsDebit") fail();
    amountBlock = {
      mode: "single", column: str(amount.column),
      decimal: str(amount.decimal), thousands: str(amount.thousands), sign: amount.sign,
    };
  } else if (amount.mode === "debitCredit") {
    amountBlock = {
      mode: "debitCredit", debitColumn: str(amount.debitColumn), creditColumn: str(amount.creditColumn),
      decimal: str(amount.decimal), thousands: str(amount.thousands),
    };
  } else fail();

  const config: CsvParserConfig = {
    version: 1, format: "csv", csv: csvBlock,
    fields: {
      date: { column: str(date.column), format: str(date.format) },
      description: { column: str(description.column) },
      amount: amountBlock,
    },
  };
  if (isObj(input.rowFilter) && Array.isArray(input.rowFilter.dropIfBlank)) {
    const allowed = new Set(["date", "amount", "description"]);
    const drop = input.rowFilter.dropIfBlank.filter((f): f is "date" | "amount" | "description" =>
      typeof f === "string" && allowed.has(f));
    config.rowFilter = { dropIfBlank: drop };
  }
  return config;
}
