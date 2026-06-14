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

import { accessibleValueMinor, type AccessibilityConfig } from "./projection";

export type GoalTerm = "short" | "long";

export type GoalInput = {
  id: string;
  targetAmountMinor: number; // already in base currency
  targetYear: number;        // year component of targetDate
  ownerScope: string;        // 'household' | a userId
  term: GoalTerm;
  sortOrder: number;
};

export type AllocAccount = AccessibilityConfig & {
  id: string;
  baseMinor: number;        // current base-currency balance (signed)
  growthRateBps: number;
  ownerIds: string[];
  ownerBirthYears: number[]; // owners' birth years; empty = unknown (treated as accessible)
};

export type GoalAllocationLine = {
  accountId: string;
  allocatedMinor: number;
  growthRateBps: number;
};

export type GoalAllocation = {
  id: string;
  allocatedMinor: number;
  targetMinor: number;
  progressPct: number; // 0..100, integer, capped
  lines: GoalAllocationLine[];
};

export type AllocationResult = {
  goals: GoalAllocation[];
  unallocatedMinor: number;
};

// Age of an account's youngest owner in a given year; +Infinity when unknown
// (mirrors the curve: unknown birth year => age-gates don't bind).
function ownerAgeInYear(a: AllocAccount, year: number): number {
  if (a.ownerBirthYears.length === 0) return Number.POSITIVE_INFINITY;
  return year - Math.max(...a.ownerBirthYears);
}

// Whether a personal goal (ownerScope = userId) may draw from this account:
// only if the account is solely owned by that member. Shared accounts fund
// household goals only. Household goals draw from everything.
function ownerScopeAllows(a: AllocAccount, ownerScope: string): boolean {
  if (ownerScope === "household") return true;
  return a.ownerIds.length === 1 && a.ownerIds[0] === ownerScope;
}

// Liquidity ordering for "most-liquid first": liquid before age-gated before
// penalty before illiquid; ties broken by accessibleFromAge.
function liquidityRank(a: AllocAccount): number {
  if (a.illiquid) return 3_000 + a.accessibleFromAge;
  if (a.earlyWithdrawal === "penalty" && a.accessibleFromAge > 0) return 2_000 + a.accessibleFromAge;
  return a.accessibleFromAge; // 0 for fully-liquid
}

const BPS_ALLOC = 10_000n;

// Raw balance consumed to deliver `takeMinor` of post-haircut value from a
// penalty account: take / (1 - haircut), rounded up so we never leave phantom
// dollars behind.
function rawConsumedForPenalty(takeMinor: number, haircutBps: number): number {
  const num = toBig(takeMinor) * BPS_ALLOC;
  const den = BPS_ALLOC - toBig(haircutBps);
  return fromBig((num + den - 1n) / den); // ceil-div, positive operands
}

export function allocateGoals(params: {
  goals: GoalInput[];
  accounts: AllocAccount[];
}): AllocationResult {
  const { goals, accounts } = params;

  // Raw remaining pool: assets with a positive base balance only.
  const remaining = new Map<string, number>();
  for (const a of accounts) if (a.baseMinor > 0) remaining.set(a.id, a.baseMinor);

  // Soonest target first; tie-break short before long, then sortOrder.
  const ordered = [...goals].sort((g1, g2) => {
    if (g1.targetYear !== g2.targetYear) return g1.targetYear - g2.targetYear;
    if (g1.term !== g2.term) return g1.term === "short" ? -1 : 1;
    return g1.sortOrder - g2.sortOrder;
  });

  const out: GoalAllocation[] = [];
  for (const goal of ordered) {
    let need = goal.targetAmountMinor;
    let allocated = 0;
    const lines: GoalAllocationLine[] = [];

    const eligible = accounts
      .filter((a) => (remaining.get(a.id) ?? 0) > 0 && ownerScopeAllows(a, goal.ownerScope))
      .sort((x, y) => liquidityRank(x) - liquidityRank(y));

    for (const a of eligible) {
      if (need <= 0) break;
      const raw = remaining.get(a.id) ?? 0;
      if (raw <= 0) continue;
      const age = ownerAgeInYear(a, goal.targetYear);
      const available = accessibleValueMinor(raw, age, a); // post-haircut / lock-aware
      if (available <= 0) continue;
      const take = Math.min(need, available);
      allocated += take;
      need -= take;
      lines.push({ accountId: a.id, allocatedMinor: take, growthRateBps: a.growthRateBps });
      const penaltyApplies = !a.illiquid && age < a.accessibleFromAge && a.earlyWithdrawal === "penalty";
      const consumed = take >= available
        ? raw // exhausted this account's accessible value -> raw is gone
        : (penaltyApplies ? rawConsumedForPenalty(take, a.earlyHaircutBps) : take);
      remaining.set(a.id, Math.max(0, raw - consumed));
    }

    const target = goal.targetAmountMinor;
    const progressPct = target <= 0 ? 100 : Math.min(100, Math.round((allocated * 100) / target));
    out.push({ id: goal.id, allocatedMinor: allocated, targetMinor: target, progressPct, lines });
  }

  let unallocated = 0;
  for (const v of remaining.values()) unallocated += v;

  // Preserve the caller's goal order in the result (allocation order is internal).
  const byId = new Map(out.map((g) => [g.id, g]));
  return { goals: goals.map((g) => byId.get(g.id)!), unallocatedMinor: unallocated };
}
