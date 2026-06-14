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
