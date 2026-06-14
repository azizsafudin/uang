import { currencyDecimals } from "@uang/shared";

// Format integer minor units as a localized currency string.
export function formatMoney(minor: number, currency: string): string {
  const dec = currencyDecimals(currency);
  const major = minor / 10 ** dec;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: dec,
      maximumFractionDigits: dec,
    }).format(major);
  } catch {
    return `${major.toFixed(dec)} ${currency}`;
  }
}
