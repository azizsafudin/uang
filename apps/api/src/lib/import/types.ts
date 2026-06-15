// ---- Canonical row: the engine's output, before persistence ----
export interface CanonicalRow {
  raw: Record<string, string>;     // header -> cell, for audit
  date: string | null;             // YYYY-MM-DD
  amountMinor: number | null;      // signed; + = account cash increases
  description: string;
  error?: string;                  // set when the row could not be parsed
}

// ---- Declarative parser config ----
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

export interface PdfParserConfig {
  version: 1;
  format: "pdf";
  region?: { startAfter?: string; stopAt?: string }; // optional regex anchors bounding the txn section
  transactionLine: string;        // JS regex source; MUST contain named groups (?<date>) and (?<amount>); (?<description>) optional
  date: { format: string };       // tokens reused from Spec 1 parseDate: YYYY YY MMMM MMM MM M DD D
  amount: { decimal: string; thousands: string; sign: "negativeIsDebit" | "positiveIsDebit" };
  multiline?: { continuationAppendsTo: "description" }; // non-matching lines appended to previous row's description
}

export type ParserConfig = CsvParserConfig | PdfParserConfig;

// ---- Detection fingerprint ----
export interface CsvFingerprint {
  format: "csv";
  delimiter: string;
  headerColumns: string[]; // normalized, sorted
}
export interface PdfFingerprint {
  format: "pdf";
  markers: string[]; // normalized (lowercased, trimmed) stable strings
}

export type ParserFingerprint = CsvFingerprint | PdfFingerprint;
