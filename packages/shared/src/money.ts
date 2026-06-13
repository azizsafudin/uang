import { currencyDecimals } from "./currencies";

export const SCALE = 100_000_000n; // 1e8: shared scale for rates, prices, units

// Divide num/den with round-half-to-even (banker's rounding). den must be > 0.
export function roundDiv(num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new Error("roundDiv: denominator must be positive");
  const neg = num < 0n;
  const a = neg ? -num : num;
  const q = a / den;
  const rem = a - q * den;
  const twice = rem * 2n;
  let result = q;
  if (twice > den) result = q + 1n;
  else if (twice === den && q % 2n === 1n) result = q + 1n;
  return neg ? -result : result;
}

// Convert an amount in `from` currency minor units to `base` currency minor units.
// rateScaled = (base major per 1 from-major) * SCALE. For from === base, pass SCALE.
// base_minor = round( amountMinor * 10^baseDec * rateScaled / (10^fromDec * SCALE) )
export function convertToBase(
  amountMinor: bigint,
  from: string,
  base: string,
  rateScaled: bigint,
): bigint {
  if (from.toUpperCase() === base.toUpperCase()) return amountMinor;
  const fromDec = BigInt(currencyDecimals(from));
  const baseDec = BigInt(currencyDecimals(base));
  const num = amountMinor * 10n ** baseDec * rateScaled;
  const den = 10n ** fromDec * SCALE;
  return roundDiv(num, den);
}

// Boundary helpers between DB/JSON numbers and BigInt math.
export function toBig(n: number): bigint {
  if (!Number.isInteger(n)) throw new Error("toBig: expected an integer");
  return BigInt(n);
}

export function fromBig(b: bigint): number {
  if (b > 9_007_199_254_740_991n || b < -9_007_199_254_740_991n) {
    throw new Error("fromBig: value exceeds safe integer range");
  }
  return Number(b);
}
