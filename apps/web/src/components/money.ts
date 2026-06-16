import { currencyDecimals, currencySymbol } from "@uang/shared";

// Format integer minor units as a currency string, prefixed with the currency's
// display symbol (e.g. "$1,234.00") rather than its ISO code.
export function formatMoney(minor: number, currency: string): string {
  const dec = currencyDecimals(currency);
  const major = minor / 10 ** dec;
  const sym = currencySymbol(currency);
  const sign = major < 0 ? "-" : "";
  const num = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  }).format(Math.abs(major));
  return `${sign}${sym}${num}`;
}

// Strip a free-typed money string down to the canonical numeric form we keep in
// form state: an optional leading minus, digits, and at most one decimal point.
// Removes grouping separators, currency symbols, and stray characters.
export function cleanMoneyInput(raw: string): string {
  const neg = raw.trim().startsWith("-");
  let s = raw.replace(/[^0-9.]/g, "");
  const firstDot = s.indexOf(".");
  if (firstDot !== -1) {
    // Keep only the first decimal point.
    s = s.slice(0, firstDot + 1) + s.slice(firstDot + 1).replace(/\./g, "");
  }
  return (neg && s !== "" ? "-" : "") + s;
}

// Format a canonical numeric major-unit string for display when the field is not
// focused: grouping separators + currency symbol (e.g. "5400" -> "$5,400.00").
// Partial entries ("", "-", ".") and non-numeric values pass through unchanged.
export function formatMoneyInput(value: string, currency: string): string {
  if (value === "" || value === "-" || value === ".") return value;
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  const dec = currencyDecimals(currency);
  const sym = currencySymbol(currency);
  const sign = n < 0 ? "-" : "";
  const num = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  }).format(Math.abs(n));
  return `${sign}${sym}${num}`;
}
