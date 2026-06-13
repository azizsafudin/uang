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
