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
