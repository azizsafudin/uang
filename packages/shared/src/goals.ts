import { roundDiv, toBig, fromBig, SCALE } from "./money";

// Rates/haircuts are integer basis points: 8% === 800, 100% === 10_000.
const BPS = 10_000n;
const MONTHS = 12n;

function assertMonths(months: number): void {
  if (!Number.isInteger(months) || months < 0) {
    throw new Error("goals: months must be a non-negative integer");
  }
}

// Nominal monthly rate, scaled by SCALE: i = (rateBps / 10_000) / 12, fixed-point.
function monthlyRateScaled(annualRateBps: number): bigint {
  return roundDiv(toBig(annualRateBps) * SCALE, BPS * MONTHS);
}

// (1 + i)^n in SCALE fixed-point, computed by repeated multiply (banker's-rounded).
function compoundFactorScaled(iScaled: bigint, months: number): bigint {
  const factor = SCALE + iScaled;
  let pow = SCALE; // represents 1.0
  for (let k = 0; k < months; k++) pow = roundDiv(pow * factor, SCALE);
  return pow;
}

// Future value of a level monthly payment (ordinary annuity), invested at
// `annualRateBps` (nominal, compounded monthly) for `months` months.
//   FV = pmt * ((1 + i)^n - 1) / i      (i > 0)
//   FV = pmt * n                        (i = 0)
export function annuityFutureValueMinor(
  pmtMinor: number,
  annualRateBps: number,
  months: number,
): number {
  assertMonths(months);
  if (months === 0) return 0;
  const iScaled = monthlyRateScaled(annualRateBps);
  if (iScaled === 0n) return fromBig(toBig(pmtMinor) * toBig(months));
  const pow = compoundFactorScaled(iScaled, months);
  // annuity factor AF = ((1+i)^n - 1) / i, in SCALE fixed-point.
  const afScaled = roundDiv((pow - SCALE) * SCALE, iScaled);
  return fromBig(roundDiv(toBig(pmtMinor) * afScaled, SCALE));
}

// Level monthly payment whose annuity future value fills `gapMinor` by `months`.
// Inverse of annuityFutureValueMinor.
export function requiredMonthlyContributionMinor(
  gapMinor: number,
  annualRateBps: number,
  months: number,
): number {
  assertMonths(months);
  if (gapMinor <= 0) return 0;
  if (months === 0) return gapMinor; // can't spread it — need it now
  const iScaled = monthlyRateScaled(annualRateBps);
  if (iScaled === 0n) return fromBig(roundDiv(toBig(gapMinor), toBig(months)));
  const pow = compoundFactorScaled(iScaled, months);
  const afScaled = roundDiv((pow - SCALE) * SCALE, iScaled);
  // pmt = gap / AF = gap * SCALE / afScaled
  return fromBig(roundDiv(toBig(gapMinor) * SCALE, afScaled));
}

// A lump sum compounded monthly at `annualRateBps` (nominal) for `months`.
export function compoundMonthlyMinor(
  principalMinor: number,
  annualRateBps: number,
  months: number,
): number {
  assertMonths(months);
  if (months === 0) return principalMinor;
  const iScaled = monthlyRateScaled(annualRateBps);
  if (iScaled === 0n) return principalMinor;
  const pow = compoundFactorScaled(iScaled, months);
  return fromBig(roundDiv(toBig(principalMinor) * pow, SCALE));
}
