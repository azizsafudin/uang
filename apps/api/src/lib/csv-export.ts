import { currencyDecimals } from "@uang/shared";

// RFC 4180 field escaping: quote when the value contains comma, quote, CR or LF.
export function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(
  headers: string[],
  rows: (string | number | null)[][],
): string {
  const lines = [headers.map(csvField).join(",")];
  for (const row of rows) lines.push(row.map(csvField).join(","));
  return lines.join("\r\n") + "\r\n";
}

// Exact (integer-based) conversion of a currency minor-unit amount to a decimal
// string, using the currency's decimal count (USD=2, JPY=0, BHD=3).
export function minorToDecimal(minor: number, currency: string): string {
  const dec = currencyDecimals(currency);
  const neg = minor < 0;
  const digits = Math.abs(minor).toString().padStart(dec + 1, "0");
  const cut = digits.length - dec;
  const intPart = digits.slice(0, cut);
  const frac = dec > 0 ? "." + digits.slice(cut) : "";
  return (neg ? "-" : "") + intPart + frac;
}

// Convert a SCALE (1e8) fixed-point integer to a decimal string, trimming
// trailing zeros. Used for transaction units and unit prices.
export function scaledToDecimal(scaled: number): string {
  const dec = 8;
  const neg = scaled < 0;
  const digits = Math.abs(scaled).toString().padStart(dec + 1, "0");
  const cut = digits.length - dec;
  const intPart = digits.slice(0, cut);
  const frac = digits.slice(cut).replace(/0+$/, "");
  return (neg ? "-" : "") + intPart + (frac ? "." + frac : "");
}
