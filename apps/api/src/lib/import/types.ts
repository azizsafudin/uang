// ---- Canonical row: the engine's output, before persistence ----
export interface CanonicalRow {
  raw: Record<string, string>;     // header -> cell, for audit
  date: string | null;             // YYYY-MM-DD
  amountMinor: number | null;      // signed; + = account cash increases
  description: string;
  error?: string;                  // set when the row could not be parsed
}

// ---- Declarative parser config (v1: CSV only; union grows in later specs) ----
export interface CsvAmountSingle {
  mode: "single";
  column: string;
  decimal: string;
  thousands: string;
  sign: "negativeIsDebit" | "positiveIsDebit";
}
export interface CsvAmountDebitCredit {
  mode: "debitCredit";
  debitColumn: string;
  creditColumn: string;
  decimal: string;
  thousands: string;
}
export interface CsvParserConfig {
  version: 1;
  format: "csv";
  csv: { delimiter: string; headerRow: number; skipRows: number };
  fields: {
    date: { column: string; format: string };
    description: { column: string };
    amount: CsvAmountSingle | CsvAmountDebitCredit;
  };
  rowFilter?: { dropIfBlank?: Array<"date" | "amount" | "description"> };
}

export type ParserConfig = CsvParserConfig;

// ---- Detection fingerprint ----
export interface CsvFingerprint {
  format: "csv";
  delimiter: string;
  headerColumns: string[]; // normalized, sorted
}
export type ParserFingerprint = CsvFingerprint;
