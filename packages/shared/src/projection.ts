import { roundDiv, toBig, fromBig } from "./money";

// Rates and haircuts are integer basis points: 8% === 800, 100% === 10_000.
const BPS = 10_000n;

function assertYears(years: number): void {
  if (!Number.isInteger(years) || years < 0) {
    throw new Error("projection: years must be a non-negative integer");
  }
}

// Compound a starting balance (minor units, may be negative for debt) for `years`
// whole years at `growthRateBps` per year, banker's-rounded each year.
export function compoundMinor(balanceMinor: number, growthRateBps: number, years: number): number {
  assertYears(years);
  let b = toBig(balanceMinor);
  const factor = BPS + toBig(growthRateBps);
  for (let i = 0; i < years; i++) b = roundDiv(b * factor, BPS);
  return fromBig(b);
}

// Balance at each year offset 0..years inclusive. `contributionPerYear` (minor
// units) is added at the start of each year before that year's growth.
// Offset 0 is always the untouched starting balance (today).
export function projectSeries(
  balanceMinor: number,
  growthRateBps: number,
  years: number,
  contributionPerYear = 0,
): number[] {
  assertYears(years);
  const factor = BPS + toBig(growthRateBps);
  const contrib = toBig(contributionPerYear);
  let b = toBig(balanceMinor);
  const out: number[] = [fromBig(b)];
  for (let i = 1; i <= years; i++) {
    b = roundDiv((b + contrib) * factor, BPS);
    out.push(fromBig(b));
  }
  return out;
}
