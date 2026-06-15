import { SCALE, currencyDecimals } from "@uang/shared";

export interface AmountFormat {
  decimal: string;   // "." or ","
  thousands: string; // "," "." " " or ""
  currency: string;
}

// Parse a raw amount cell into signed minor units. Handles thousands/decimal
// marks, leading minus, accounting parentheses, and stray currency symbols.
export function parseAmountToMinor(raw: string, fmt: AmountFormat): number | null {
  if (raw == null) return null;
  let s = raw.trim();
  if (s === "") return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (fmt.thousands) s = s.split(fmt.thousands).join("");
  if (fmt.decimal !== ".") s = s.split(fmt.decimal).join(".");
  if (s.includes("-")) negative = true;
  s = s.replace(/[^0-9.]/g, "");
  if (s === "" || s === ".") return null;
  const value = Number(s);
  if (!Number.isFinite(value)) return null;
  const dec = currencyDecimals(fmt.currency);
  const minor = Math.round(value * 10 ** dec);
  if (minor === 0) return 0; // normalize: never return -0
  return negative ? -minor : minor;
}

// minor units (e.g. cents) -> signed unitsDelta (×1e8). Exact: SCALE is
// divisible by 10^dec for dec <= 8.
export function amountMinorToUnitsDelta(amountMinor: number, currency: string): number {
  const dec = BigInt(currencyDecimals(currency));
  const abs = BigInt(Math.abs(amountMinor));
  const units = (abs * SCALE) / 10n ** dec;
  return Number(amountMinor < 0 ? -units : units);
}

// Inverse of amountMinorToUnitsDelta — reconstruct minor units from a stored
// transaction's unitsDelta (used for deduping against existing transactions).
export function unitsDeltaToAmountMinor(unitsDelta: number, currency: string): number {
  const dec = BigInt(currencyDecimals(currency));
  const abs = BigInt(Math.abs(unitsDelta));
  const minor = (abs * 10n ** dec) / SCALE;
  return Number(unitsDelta < 0 ? -minor : minor);
}
