import { parseDate } from "./dates";
import { parseAmountToMinor } from "./amount";
import type { CanonicalRow, CsvParserConfig } from "./types";

// Minimal RFC-4180-ish delimited parser: quoted fields, "" escapes, CRLF.
export function parseDelimited(content: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let started = false;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { pushField(); rows.push(row); row = []; started = false; };
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    started = true;
    if (inQuotes) {
      if (c === '"') {
        if (content[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delimiter) pushField();
    else if (c === "\n") pushRow();
    else if (c === "\r") { /* swallow; \r\n handled by \n */ }
    else field += c;
  }
  if (started || field !== "" || row.length > 0) pushRow();
  return rows;
}

function isBlankRow(cells: string[]): boolean {
  return cells.length === 0 || cells.every((c) => c.trim() === "");
}

export function parseCsv(content: string, config: CsvParserConfig, currency: string): CanonicalRow[] {
  const all = parseDelimited(content, config.csv.delimiter);
  const header = (all[config.csv.headerRow] ?? []).map((h) => h.trim());
  const idxOf = (name: string) => header.findIndex((h) => h === name.trim());
  const dataStart = config.csv.headerRow + 1 + config.csv.skipRows;
  const dropIfBlank = config.rowFilter?.dropIfBlank ?? [];
  const out: CanonicalRow[] = [];

  for (let r = dataStart; r < all.length; r++) {
    const cells = all[r];
    if (isBlankRow(cells)) continue;

    const raw: Record<string, string> = {};
    header.forEach((h, i) => { raw[h] = cells[i] ?? ""; });

    const dateCell = cells[idxOf(config.fields.date.column)] ?? "";
    const descCell = cells[idxOf(config.fields.description.column)] ?? "";

    // amount raw presence (for dropIfBlank) + parsed value
    let amountRawBlank: boolean;
    let amountMinor: number | null;
    const a = config.fields.amount;
    if (a.mode === "single") {
      const cell = cells[idxOf(a.column)] ?? "";
      amountRawBlank = cell.trim() === "";
      const parsed = parseAmountToMinor(cell, { decimal: a.decimal, thousands: a.thousands, currency });
      amountMinor = parsed;
      if (amountMinor !== null && a.sign === "positiveIsDebit") amountMinor = -amountMinor;
    } else {
      const dCell = cells[idxOf(a.debitColumn)] ?? "";
      const cCell = cells[idxOf(a.creditColumn)] ?? "";
      amountRawBlank = dCell.trim() === "" && cCell.trim() === "";
      const debit = parseAmountToMinor(dCell, { decimal: a.decimal, thousands: a.thousands, currency }) ?? 0;
      const credit = parseAmountToMinor(cCell, { decimal: a.decimal, thousands: a.thousands, currency }) ?? 0;
      amountMinor = credit - debit;
    }

    const date = parseDate(dateCell, config.fields.date.format);

    // dropIfBlank: skip known noise rows entirely (summaries, totals)
    const blank = { date: dateCell.trim() === "", amount: amountRawBlank, description: descCell.trim() === "" };
    if (dropIfBlank.some((f) => blank[f])) continue;

    const row: CanonicalRow = { raw, date, amountMinor, description: descCell.trim() };
    if (date === null) row.error = "unparseable_date";
    else if (amountMinor === null) row.error = "unparseable_amount";
    out.push(row);
  }
  return out;
}
