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

// First whole month at which `principalMinor` (compounding monthly at annualRateBps)
// plus a level monthly contribution (ordinary annuity) reaches `targetMinor`.
// Returns 0 if already there, or null if not reached within `capMonths`.
export function monthsToReachMinor(
  principalMinor: number,
  monthlyContributionMinor: number,
  targetMinor: number,
  annualRateBps: number,
  capMonths: number,
): number | null {
  assertMonths(capMonths);
  if (principalMinor >= targetMinor) return 0;
  const iScaled = monthlyRateScaled(annualRateBps);
  const factor = SCALE + iScaled;
  const pmt = toBig(monthlyContributionMinor);
  const target = toBig(targetMinor);
  let bal = toBig(principalMinor);
  for (let m = 1; m <= capMonths; m++) {
    // Grow last month's balance, then add this month's contribution (end of period).
    bal = roundDiv(bal * factor, SCALE) + pmt;
    if (bal >= target) return m;
  }
  return null;
}

import { accessibleValueMinor, type AccessibilityConfig } from "./projection";

export type GoalInput = {
  id: string;
  targetAmountMinor: number;   // already in base currency
  targetYear: number | null;   // year component of targetDate; null = indefinite (no deadline)
  ownerScope: string;          // 'household' | a userId
  accountIds: string[];        // accounts assigned to fund this goal
  priority: number;            // lower = funded first (goals.sortOrder)
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
// (mirrors the curve: unknown birth year => age-gates don't bind) or when the
// goal is indefinite (no deadline => an account counts if it ever unlocks).
function ownerAgeInYear(a: AllocAccount, year: number | null): number {
  if (year === null || a.ownerBirthYears.length === 0) return Number.POSITIVE_INFINITY;
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

  // Goal priority first (sortOrder), then soonest deadline (indefinite last),
  // then smallest target, then id for stable ordering.
  const ordered = [...goals].sort((g1, g2) => {
    if (g1.priority !== g2.priority) return g1.priority - g2.priority;
    const y1 = g1.targetYear ?? Number.POSITIVE_INFINITY;
    const y2 = g2.targetYear ?? Number.POSITIVE_INFINITY;
    if (y1 !== y2) return y1 - y2;
    if (g1.targetAmountMinor !== g2.targetAmountMinor) return g1.targetAmountMinor - g2.targetAmountMinor;
    return g1.id < g2.id ? -1 : g1.id > g2.id ? 1 : 0;
  });

  const out: GoalAllocation[] = [];
  for (const goal of ordered) {
    let need = goal.targetAmountMinor;
    let allocated = 0;
    const lines: GoalAllocationLine[] = [];

    const assigned = new Set(goal.accountIds);
    const eligible = accounts
      .filter((a) => assigned.has(a.id) && (remaining.get(a.id) ?? 0) > 0 && ownerScopeAllows(a, goal.ownerScope))
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

// ---------------------------------------------------------------------------
// simulateGoals — month-by-month multi-goal cashflow simulation
// ---------------------------------------------------------------------------

export type SpendType = "none" | "once" | "monthly" | "percent";

// One goal's inputs to the simulation. startBalanceMinor is today's allocation
// (from allocateGoals); targetMonth is whole months from the sim start to the
// goal's targetDate (null = indefinite, no deadline).
export type SimGoal = {
  id: string;
  startBalanceMinor: number;
  targetMinor: number;
  targetMonth: number | null;
  monthlyContributionMinor: number;
  spendType: SpendType;
  spendAmountMinor: number | null; // 'once' lump / 'monthly' flat
  spendRateBps: number | null;     // 'percent' annual % of current balance
};

export type SimGoalResult = {
  id: string;
  startBalanceMinor: number;
  reachMonth: number | null;  // first month (1..horizon) balance >= target; 0 if already there; null if never
  balances: number[];         // length horizonMonths + 1; balances[0] = startBalanceMinor
};

export type SimResult = { goals: SimGoalResult[] };

// Pure month-by-month simulation of the whole goal set. Each month every goal's
// balance grows at the plan rate, then active (not-yet-reached) goals add their
// own contribution and the soonest active goal also receives the freed-contribution
// stream; goals that reach their target are capped and cascade their surplus, and
// spend goals draw down from their targetMonth onward (Task 4). Money is base
// minor units, BigInt, banker's-rounded. The caller supplies starting balances
// and horizon (no Date.now here).
export function simulateGoals(params: {
  goals: SimGoal[];
  planRateBps: number;
  horizonMonths: number;
}): SimResult {
  const { goals, planRateBps, horizonMonths } = params;
  assertMonths(horizonMonths);

  // Priority: soonest targetMonth (indefinite last), then smallest target, then id.
  const order = [...goals].sort((a, b) => {
    const am = a.targetMonth ?? Number.POSITIVE_INFINITY;
    const bm = b.targetMonth ?? Number.POSITIVE_INFINITY;
    if (am !== bm) return am - bm;
    if (a.targetMinor !== b.targetMinor) return a.targetMinor - b.targetMinor;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const n = order.length;

  const iScaled = monthlyRateScaled(planRateBps);
  const factor = SCALE + iScaled;

  const bal = order.map((g) => toBig(g.startBalanceMinor));
  const targetBig = order.map((g) => toBig(g.targetMinor));
  const contribBig = order.map((g) => toBig(g.monthlyContributionMinor));
  const reached = order.map(() => false);
  const finishedOnce = order.map(() => false); // 'once'-spent: emptied, no longer grows
  const reachMonth = order.map<number | null>(() => null);
  const series = order.map((g) => [g.startBalanceMinor]);

  // A goal already at/above target today is reached at month 0; its contribution
  // joins the freed stream immediately. (Not capped at init so today's actual ==
  // today's projected; any pre-existing overshoot simply stays with the goal.)
  for (let i = 0; i < n; i++) {
    if (bal[i] >= targetBig[i]) { reached[i] = true; reachMonth[i] = 0; }
  }

  // Sum of reached goals' contributions, redirected each month to the soonest
  // still-active goal (the "freed pool" as a recurring stream).
  let freedMonthly = 0n;
  for (let i = 0; i < n; i++) if (reached[i]) freedMonthly += contribBig[i];

  const soonestActive = (): number => {
    for (let i = 0; i < n; i++) if (!reached[i]) return i;
    return -1;
  };

  for (let m = 1; m <= horizonMonths; m++) {
    // 1. Grow every (still-held) balance at the plan rate.
    for (let i = 0; i < n; i++) {
      if (finishedOnce[i]) continue;
      bal[i] = roundDiv(bal[i] * factor, SCALE);
    }

    // 2. Contribute: active goals add their own contribution; the freed stream
    //    tops up the soonest active goal on top of its own.
    for (let i = 0; i < n; i++) if (!reached[i]) bal[i] += contribBig[i];
    const sa = soonestActive();
    if (sa !== -1 && freedMonthly > 0n) bal[sa] += freedMonthly;

    // 3. Reach: cap at target, cascade surplus to the soonest active goal, and
    //    free this goal's contribution from next month on.
    for (let i = 0; i < n; i++) {
      if (reached[i] || finishedOnce[i]) continue;
      if (bal[i] >= targetBig[i]) {
        reached[i] = true;
        reachMonth[i] = m;
        const surplus = bal[i] - targetBig[i];
        bal[i] = targetBig[i];
        freedMonthly += contribBig[i];
        if (surplus > 0n) {
          const j = soonestActive();
          if (j !== -1) bal[j] += surplus;
        }
      }
    }

    // 4. Spend at/after each goal's targetMonth. Consumed money leaves the sim;
    //    the pot keeps growing at the plan rate underneath.
    for (let i = 0; i < n; i++) {
      const g = order[i];
      const tm = g.targetMonth;
      if (tm === null || m < tm || finishedOnce[i]) continue;
      if (g.spendType === "once" && m === tm) {
        const amt = toBig(g.spendAmountMinor ?? 0);
        const spent = amt > bal[i] ? bal[i] : amt;
        bal[i] -= spent;
        const leftover = bal[i];
        bal[i] = 0n;
        finishedOnce[i] = true;
        if (!reached[i]) { reached[i] = true; reachMonth[i] = m; freedMonthly += contribBig[i]; }
        if (leftover > 0n) {
          const j = soonestActive();
          if (j !== -1) bal[j] += leftover;
        }
      } else if (g.spendType === "monthly") {
        const amt = toBig(g.spendAmountMinor ?? 0);
        bal[i] = bal[i] > amt ? bal[i] - amt : 0n;
      } else if (g.spendType === "percent" && (m - tm) % 12 === 0) {
        const wd = roundDiv(bal[i] * toBig(g.spendRateBps ?? 0), BPS);
        bal[i] = bal[i] > wd ? bal[i] - wd : 0n;
      }
    }

    for (let i = 0; i < n; i++) series[i].push(fromBig(bal[i]));
  }

  const byId = new Map(
    order.map((g, i) => [g.id, { id: g.id, startBalanceMinor: g.startBalanceMinor, reachMonth: reachMonth[i], balances: series[i] }] as const),
  );
  return { goals: goals.map((g) => byId.get(g.id)!) };
}

export type OnTrack = {
  onPlanTodayMinor: number;
  aheadByMinor: number; // actual - on-plan (negative => behind)
  onTrack: boolean;
};

// Per-goal glide-path check. The plan is fixed at the anchor: grow the
// allocated-at-anchor start to the target at `planRateBps` and add the level
// contribution that closes the remaining gap by `monthsAnchorToTarget`. The
// on-plan value today is the start grown to today plus that contribution's
// annuity FV over the elapsed months. We are on track iff today's actual
// allocation is at least the on-plan value.
export function goalOnTrack(params: {
  targetMinor: number;
  startAnchorMinor: number;
  allocatedTodayMinor: number;
  planRateBps: number;
  monthsAnchorToToday: number;
  monthsAnchorToTarget: number;
}): OnTrack {
  const {
    targetMinor, startAnchorMinor, allocatedTodayMinor,
    planRateBps, monthsAnchorToToday, monthsAnchorToTarget,
  } = params;

  const startGrownToTarget = compoundMonthlyMinor(startAnchorMinor, planRateBps, monthsAnchorToTarget);
  const planGap = targetMinor - startGrownToTarget;
  const requiredPmt = requiredMonthlyContributionMinor(planGap, planRateBps, monthsAnchorToTarget);

  const startGrownToToday = compoundMonthlyMinor(startAnchorMinor, planRateBps, monthsAnchorToToday);
  const contributedToToday = annuityFutureValueMinor(requiredPmt, planRateBps, monthsAnchorToToday);
  const onPlanTodayMinor = startGrownToToday + contributedToToday;

  const aheadByMinor = allocatedTodayMinor - onPlanTodayMinor;
  return { onPlanTodayMinor, aheadByMinor, onTrack: aheadByMinor >= 0 };
}
