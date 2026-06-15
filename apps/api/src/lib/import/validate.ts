import type { CsvParserConfig, PdfParserConfig, ParserConfig, ParserFingerprint } from "./types";

function fail(): never { throw new Error("invalid_config"); }
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function str(v: unknown): string { if (typeof v !== "string") fail(); return v; }
function num(v: unknown): number { if (typeof v !== "number") fail(); return v; }

// Treat a synthesized/edited regex as untrusted: cap length, reject the classic
// nested-unbounded-quantifier ReDoS shape (e.g. (a+)+ / (a*)* / (\d+)*), and make
// sure it compiles. Returns the source if safe; throws otherwise.
export function assertSafeRegex(src: string): string {
  if (src.length > 1000) fail();
  if (/\([^()]*[+*][^()]*\)[+*]/.test(src)) fail(); // (..+..)+ , (..*..)* , (\d+)*
  if (/[+*]{2,}/.test(src)) fail();                  // a++ , a** , a*+
  try { new RegExp(src); } catch { fail(); }
  return src;
}

function validateCsvConfig(input: Record<string, unknown>): CsvParserConfig {
  const csv = input.csv;
  if (!isObj(csv)) fail();
  const delimiter = str(csv.delimiter);
  if (delimiter.length !== 1) fail();
  const headerRow = num(csv.headerRow);
  const skipRows = num(csv.skipRows);
  if (headerRow < 0 || skipRows < 0) fail();
  const csvBlock = { delimiter, headerRow, skipRows };

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

function validatePdfConfig(input: Record<string, unknown>): PdfParserConfig {
  const transactionLine = assertSafeRegex(str(input.transactionLine));
  if (!transactionLine.includes("(?<date>") || !transactionLine.includes("(?<amount>")) fail();

  const date = input.date; if (!isObj(date)) fail();
  const amount = input.amount; if (!isObj(amount)) fail();
  if (amount.sign !== "negativeIsDebit" && amount.sign !== "positiveIsDebit") fail();

  const config: PdfParserConfig = {
    version: 1, format: "pdf", transactionLine,
    date: { format: str(date.format) },
    amount: { decimal: str(amount.decimal), thousands: str(amount.thousands), sign: amount.sign },
  };

  if (isObj(input.region)) {
    const region: { startAfter?: string; stopAt?: string } = {};
    if (input.region.startAfter !== undefined) region.startAfter = assertSafeRegex(str(input.region.startAfter));
    if (input.region.stopAt !== undefined) region.stopAt = assertSafeRegex(str(input.region.stopAt));
    config.region = region;
  }
  if (isObj(input.multiline) && input.multiline.continuationAppendsTo === "description") {
    config.multiline = { continuationAppendsTo: "description" };
  }
  return config;
}

export function validateParserConfig(input: unknown): ParserConfig {
  if (!isObj(input)) fail();
  if (input.version !== 1) fail();
  if (input.format === "csv") return validateCsvConfig(input);
  if (input.format === "pdf") return validatePdfConfig(input);
  return fail();
}

export function validateFingerprint(input: unknown): ParserFingerprint {
  if (!isObj(input)) throw new Error("invalid_fingerprint");
  if (input.format === "csv") {
    if (typeof input.delimiter !== "string" || input.delimiter.length !== 1) throw new Error("invalid_fingerprint");
    if (!Array.isArray(input.headerColumns) || input.headerColumns.length > 200) throw new Error("invalid_fingerprint");
    const headerColumns: string[] = [];
    for (const c of input.headerColumns) {
      if (typeof c !== "string") throw new Error("invalid_fingerprint");
      headerColumns.push(c);
    }
    return { format: "csv", delimiter: input.delimiter, headerColumns };
  }
  if (input.format === "pdf") {
    if (!Array.isArray(input.markers) || input.markers.length > 200) throw new Error("invalid_fingerprint");
    const markers: string[] = [];
    for (const m of input.markers) {
      if (typeof m !== "string") throw new Error("invalid_fingerprint");
      markers.push(m);
    }
    return { format: "pdf", markers };
  }
  throw new Error("invalid_fingerprint");
}
