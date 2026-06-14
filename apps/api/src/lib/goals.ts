import { db } from "../db/client";
import { goals as goalsTable, memberProfiles } from "../db/schema";
import {
  convertToBase, toBig, fromBig,
  compoundMonthlyMinor, annuityFutureValueMinor, monthsToReachMinor,
  allocateGoals, requiredMonthlyContributionMinor,
  type AllocAccount, type GoalInput,
} from "@uang/shared";
import { netWorth, latestFxRateScaled } from "./valuation";
import { getSettings } from "./settings";

type GoalRow = typeof goalsTable.$inferSelect;

// A funding account that contributes to this goal, with its allocated slice.
export type GoalSource = {
  accountId: string;
  name: string;
  allocatedMinor: number;
};

export type GoalAnalysis = {
  id: string;
  name: string;
  term: "short" | "long";
  targetAmountMinor: number; // base currency
  targetDate: string;
  currency: string;
  allocatedMinor: number;
  progressPct: number;
  monthlyContributionMinor: number;   // the goal's planned saving
  requiredMonthlyMinor: number;       // contribution needed to hit target
  projectedAtTargetMinor: number;     // where the plan lands by the target date
  onTrack: boolean;                   // projected >= target
  reachDate: string | null;          // YYYY-MM-DD the plan first reaches target (null = not within ~100y)
  sources: GoalSource[];
};

export type GoalsAnalysisResult = {
  baseCurrency: string;
  contributionGrowthRateBps: number;
  unallocatedMinor: number;
  goals: GoalAnalysis[];
  overall: { onTrack: boolean; behindCount: number };
};

const yearOf = (iso: string): number => parseInt(iso.slice(0, 10), 10);

function monthsBetween(fromISO: string, toISO: string): number {
  const f = new Date(`${fromISO.slice(0, 10)}T00:00:00Z`);
  const t = new Date(`${toISO.slice(0, 10)}T00:00:00Z`);
  const m = (t.getUTCFullYear() - f.getUTCFullYear()) * 12 + (t.getUTCMonth() - f.getUTCMonth());
  return Math.max(0, m);
}

// Shift an ISO date (YYYY-MM-DD) by whole months (UTC).
function addMonthsISO(iso: string, deltaMonths: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + deltaMonths);
  return d.toISOString().slice(0, 10);
}

// Single-rate plan math: today's allocated balance grows at the plan rate, and the
// planned monthly contribution accumulates on top. `required` is the contribution
// that would land exactly on target; on track when the plan reaches the target.
function goalPlanMath(params: {
  allocatedMinor: number;
  monthlyContributionMinor: number;
  targetMinor: number;
  planRateBps: number;
  monthsToTarget: number;
}): { requiredMonthlyMinor: number; projectedAtTargetMinor: number; onTrack: boolean; reachMonths: number | null } {
  const { allocatedMinor, monthlyContributionMinor, targetMinor, planRateBps, monthsToTarget } = params;
  const grownAllocated = compoundMonthlyMinor(allocatedMinor, planRateBps, monthsToTarget);
  const requiredMonthlyMinor = requiredMonthlyContributionMinor(targetMinor - grownAllocated, planRateBps, monthsToTarget);
  const projectedAtTargetMinor = grownAllocated + annuityFutureValueMinor(monthlyContributionMinor, planRateBps, monthsToTarget);
  // When (with growth + contribution) the balance first reaches the target. Search
  // well past the target date so a behind goal still gets an (later) completion date.
  const cap = Math.max(monthsToTarget * 3, 1200);
  const reachMonths = monthsToReachMinor(allocatedMinor, monthlyContributionMinor, targetMinor, planRateBps, cap);
  return { requiredMonthlyMinor, projectedAtTargetMinor, onTrack: projectedAtTargetMinor >= targetMinor, reachMonths };
}

// Convert a goal's target into base currency using the latest FX rate.
async function targetInBaseMinor(g: GoalRow, base: string): Promise<number> {
  if (g.currency.toUpperCase() === base.toUpperCase()) return g.targetAmountMinor;
  const rate = await latestFxRateScaled(g.currency);
  if (rate === null) return g.targetAmountMinor; // no rate: best-effort, treat as base
  return fromBig(convertToBase(toBig(g.targetAmountMinor), g.currency, base, toBig(rate)));
}

// Build the allocation-account list from a netWorth() snapshot + member birth years.
function toAllocAccounts(
  nwAccounts: Awaited<ReturnType<typeof netWorth>>["accounts"],
  birthByUser: Map<string, number | null>,
): AllocAccount[] {
  return nwAccounts.map((a) => ({
    id: a.id,
    baseMinor: a.baseMinor,
    growthRateBps: a.growthRateBps,
    accessibleFromAge: a.accessibleFromAge,
    earlyWithdrawal: a.earlyWithdrawal,
    earlyHaircutBps: a.earlyHaircutBps,
    illiquid: a.illiquid,
    liquidationAge: a.liquidationAge,
    ownerIds: a.ownerIds,
    ownerBirthYears: a.ownerIds
      .map((id) => birthByUser.get(id) ?? null)
      .filter((y): y is number => y != null),
  }));
}

export async function analyzeGoals(): Promise<GoalsAnalysisResult> {
  const s = await getSettings();
  const base = s?.baseCurrency ?? "USD";
  const planRateBps = s?.contributionGrowthRateBps ?? 800;

  const goalRows = await db.select().from(goalsTable).orderBy(goalsTable.sortOrder);
  const profiles = await db.select().from(memberProfiles);
  const birthByUser = new Map<string, number | null>(profiles.map((p) => [p.userId, p.birthYear]));

  const todayISO = new Date().toISOString().slice(0, 10);

  // Today's snapshot -> base targets -> allocation.
  const nwToday = await netWorth({ owner: "household" });
  const allocAccountsToday = toAllocAccounts(nwToday.accounts, birthByUser);
  const nameById = new Map(nwToday.accounts.map((a) => [a.id, a.name]));

  const goalInputs: GoalInput[] = [];
  const targetBaseById = new Map<string, number>();
  for (const g of goalRows) {
    const targetBase = await targetInBaseMinor(g, base);
    targetBaseById.set(g.id, targetBase);
    goalInputs.push({
      id: g.id, targetAmountMinor: targetBase, targetYear: yearOf(g.targetDate),
      ownerScope: g.ownerScope, term: g.term, sortOrder: g.sortOrder,
    });
  }

  const allocToday = allocateGoals({ goals: goalInputs, accounts: allocAccountsToday });
  const allocById = new Map(allocToday.goals.map((g) => [g.id, g]));

  const analyses: GoalAnalysis[] = [];
  for (const g of goalRows) {
    const targetBase = targetBaseById.get(g.id) ?? g.targetAmountMinor;
    const alloc = allocById.get(g.id)!;
    const monthsToTarget = monthsBetween(todayISO, g.targetDate);
    const m = goalPlanMath({
      allocatedMinor: alloc.allocatedMinor,
      monthlyContributionMinor: g.monthlyContributionMinor,
      targetMinor: targetBase,
      planRateBps,
      monthsToTarget,
    });

    analyses.push({
      id: g.id, name: g.name, term: g.term, targetAmountMinor: targetBase,
      targetDate: g.targetDate, currency: g.currency,
      allocatedMinor: alloc.allocatedMinor, progressPct: alloc.progressPct,
      monthlyContributionMinor: g.monthlyContributionMinor,
      requiredMonthlyMinor: m.requiredMonthlyMinor,
      projectedAtTargetMinor: m.projectedAtTargetMinor,
      onTrack: m.onTrack,
      reachDate: m.reachMonths === null ? null : addMonthsISO(todayISO, m.reachMonths),
      sources: alloc.lines.map((line) => ({
        accountId: line.accountId,
        name: nameById.get(line.accountId) ?? line.accountId,
        allocatedMinor: line.allocatedMinor,
      })),
    });
  }

  const behindCount = analyses.filter((a) => !a.onTrack).length;
  return {
    baseCurrency: base,
    contributionGrowthRateBps: planRateBps,
    unallocatedMinor: allocToday.unallocatedMinor,
    goals: analyses,
    overall: { onTrack: behindCount === 0, behindCount },
  };
}

export type GoalProjectionPoint = {
  date: string;
  actual: number | null;    // realized allocated value (past + today)
  projected: number | null; // allocated + planned contribution, growing (today + future)
};

export type GoalProjectionResult = {
  baseCurrency: string;
  goal: { id: string; name: string; term: "short" | "long"; targetDate: string; currency: string };
  targetMinor: number;
  allocatedMinor: number;
  progressPct: number;
  monthlyContributionMinor: number;
  requiredMonthlyMinor: number;
  projectedAtTargetMinor: number;
  onTrack: boolean;
  reachDate: string | null; // YYYY-MM-DD the plan first reaches target (null = not within ~100y)
  sources: GoalSource[];
  series: GoalProjectionPoint[];
};

// Per-goal time series: realized allocation over the last `historyMonths`, then a
// single projected trajectory to the target date = today's allocation growing at
// the plan rate plus the goal's planned monthly contribution. All goal allocations
// are computed globally (no double-counting), then this goal's slice is taken.
// Returns null if the goal does not exist.
export async function goalProjection(
  goalId: string,
  historyMonths = 12,
): Promise<GoalProjectionResult | null> {
  const s = await getSettings();
  const base = s?.baseCurrency ?? "USD";
  const planRateBps = s?.contributionGrowthRateBps ?? 800;

  const goalRows = await db.select().from(goalsTable).orderBy(goalsTable.sortOrder);
  const goal = goalRows.find((g) => g.id === goalId);
  if (!goal) return null;

  const profiles = await db.select().from(memberProfiles);
  const birthByUser = new Map<string, number | null>(profiles.map((p) => [p.userId, p.birthYear]));

  const todayISO = new Date().toISOString().slice(0, 10);

  // Inputs for ALL goals (allocation is global), with base-currency targets.
  const goalInputs: GoalInput[] = [];
  const targetBaseById = new Map<string, number>();
  for (const g of goalRows) {
    const tb = await targetInBaseMinor(g, base);
    targetBaseById.set(g.id, tb);
    goalInputs.push({
      id: g.id, targetAmountMinor: tb, targetYear: yearOf(g.targetDate),
      ownerScope: g.ownerScope, term: g.term, sortOrder: g.sortOrder,
    });
  }
  const targetBase = targetBaseById.get(goal.id)!;

  // Today's allocation for this goal.
  const nwToday = await netWorth({ owner: "household" });
  const allocToday = allocateGoals({ goals: goalInputs, accounts: toAllocAccounts(nwToday.accounts, birthByUser) });
  const mine = allocToday.goals.find((g) => g.id === goal.id)!;
  const allocatedToday = mine.allocatedMinor;

  // Funding sources: this goal's allocation lines with account names (most-liquid first).
  const nameById = new Map(nwToday.accounts.map((a) => [a.id, a.name]));
  const sources: GoalSource[] = mine.lines.map((line) => ({
    accountId: line.accountId,
    name: nameById.get(line.accountId) ?? line.accountId,
    allocatedMinor: line.allocatedMinor,
  }));

  const contribution = goal.monthlyContributionMinor;
  const monthsToTarget = monthsBetween(todayISO, goal.targetDate);
  const m = goalPlanMath({
    allocatedMinor: allocatedToday,
    monthlyContributionMinor: contribution,
    targetMinor: targetBase,
    planRateBps,
    monthsToTarget,
  });

  const series: GoalProjectionPoint[] = [];

  // Past: realized allocation as of each month-end (oldest first).
  for (let k = historyMonths; k >= 1; k--) {
    const date = addMonthsISO(todayISO, -k);
    const nwPast = await netWorth({ asOf: date, owner: "household" });
    const allocPast = allocateGoals({ goals: goalInputs, accounts: toAllocAccounts(nwPast.accounts, birthByUser) });
    const realized = allocPast.goals.find((g) => g.id === goal.id)?.allocatedMinor ?? 0;
    series.push({ date, actual: realized, projected: null });
  }

  // Today: actual meets projected at the current allocation.
  series.push({ date: todayISO, actual: allocatedToday, projected: allocatedToday });

  // Future: step so a far-dated goal stays under ~120 points; always include the
  // target month, and the reach month (if it falls within the horizon) so the chart
  // can mark exactly where the projected line crosses the target.
  const step = Math.max(1, Math.ceil(monthsToTarget / 120));
  const monthsSet = new Set<number>();
  for (let mo = step; mo < monthsToTarget; mo += step) monthsSet.add(mo);
  if (monthsToTarget > 0) monthsSet.add(monthsToTarget);
  if (m.reachMonths !== null && m.reachMonths > 0 && m.reachMonths <= monthsToTarget) monthsSet.add(m.reachMonths);
  const futureMonths = [...monthsSet].sort((a, b) => a - b);
  for (const mo of futureMonths) {
    const date = addMonthsISO(todayISO, mo);
    const projected = compoundMonthlyMinor(allocatedToday, planRateBps, mo) + annuityFutureValueMinor(contribution, planRateBps, mo);
    series.push({ date, actual: null, projected });
  }

  const reachDate = m.reachMonths === null ? null : addMonthsISO(todayISO, m.reachMonths);

  return {
    baseCurrency: base,
    goal: { id: goal.id, name: goal.name, term: goal.term, targetDate: goal.targetDate, currency: goal.currency },
    targetMinor: targetBase,
    allocatedMinor: allocatedToday,
    progressPct: mine.progressPct,
    monthlyContributionMinor: contribution,
    requiredMonthlyMinor: m.requiredMonthlyMinor,
    projectedAtTargetMinor: m.projectedAtTargetMinor,
    onTrack: m.onTrack,
    reachDate,
    sources,
    series,
  };
}
