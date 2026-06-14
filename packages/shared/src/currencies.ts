// ISO 4217 minor-unit digits for currencies that differ from the default of 2,
// plus common 2-digit ones for clarity. Unknown codes default to 2.
const MINOR_UNITS: Record<string, number> = {
  USD: 2, EUR: 2, GBP: 2, MYR: 2, SGD: 2, AUD: 2, CAD: 2, CHF: 2,
  IDR: 2, INR: 2, CNY: 2, HKD: 2, THB: 2, PHP: 2,
  JPY: 0, KRW: 0, VND: 0, CLP: 0, ISK: 0,
  BHD: 3, KWD: 3, OMR: 3, JOD: 3, TND: 3,
};

export function currencyDecimals(code: string): number {
  const d = MINOR_UNITS[code.toUpperCase()];
  return d === undefined ? 2 : d;
}

// Display symbol per ISO 4217 code. Unknown codes fall back to the code itself.
const SYMBOLS: Record<string, string> = {
  USD: "$", EUR: "€", GBP: "£", MYR: "RM", SGD: "$", AUD: "$", CAD: "$", CHF: "Fr",
  IDR: "Rp", INR: "₹", CNY: "¥", HKD: "$", THB: "฿", PHP: "₱",
  JPY: "¥", KRW: "₩", VND: "₫", CLP: "$", ISK: "kr",
  BHD: "BD", KWD: "KD", OMR: "﷼", JOD: "JD", TND: "DT",
};

export function currencySymbol(code: string): string {
  return SYMBOLS[code.toUpperCase()] ?? code.toUpperCase();
}

// Supported ISO 4217 codes, roughly ordered by likely usage, for select inputs.
export const CURRENCY_CODES: readonly string[] = [
  "USD", "EUR", "GBP", "SGD", "MYR", "AUD", "CAD", "CHF",
  "HKD", "CNY", "INR", "IDR", "THB", "PHP",
  "JPY", "KRW", "VND",
  "CLP", "ISK", "BHD", "KWD", "OMR", "JOD", "TND",
];

// Friendly display names for currency instruments. Unknown codes fall back to the code.
const CURRENCY_NAMES: Record<string, string> = {
  USD: "US Dollar", EUR: "Euro", GBP: "Pound Sterling", SGD: "Singapore Dollar",
  MYR: "Malaysian Ringgit", AUD: "Australian Dollar", CAD: "Canadian Dollar",
  CHF: "Swiss Franc", JPY: "Japanese Yen", HKD: "Hong Kong Dollar", CNY: "Chinese Yuan",
  INR: "Indian Rupee", IDR: "Indonesian Rupiah", THB: "Thai Baht", PHP: "Philippine Peso",
  KRW: "South Korean Won", VND: "Vietnamese Dong",
};

export function currencyName(code: string): string {
  return CURRENCY_NAMES[code.toUpperCase()] ?? code.toUpperCase();
}
