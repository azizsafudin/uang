import { db } from "../db/client";
import { goals as goalsTable, memberProfiles } from "../db/schema";
import {
  convertToBase, toBig, fromBig, compoundMinor,
  compoundMonthlyMinor, annuityFutureValueMinor,
  allocateGoals, requiredMonthlyContributionMinor, goalOnTrack,
  type AllocAccount, type GoalInput,
} from "@uang/shared";
import { netWorth, latestFxRateScaled } from "./valuation";
import { getSettings } from "./settings";

type GoalRow = typeof goalsTable.$inferSelect;

export type GoalAnalysis = {
  id: string;
  name: string;
  term: "short" | "long";
  targetAmountMinor: number; // base currency
  targetDate: string;
  currency: string;
  allocatedMinor: number;
  progressPct: number;
  projectedAllocatedMinor: number;
  gapMinor: number;
  requiredMonthlyMinor: number;
  onPlanTodayMinor: number;
  aheadByMinor: number;
  onTrack: boolean;
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
  const thisYear = yearOf(todayISO);

  // Today's snapshot -> base targets -> allocation.
  const nwToday = await netWorth({ owner: "household" });
  const allocAccountsToday = toAllocAccounts(nwToday.accounts, birthByUser);

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

  // For on-track we need each goal's allocated-at-anchor. Group goals by distinct
  // anchor date so we run one netWorth() snapshot + allocation per anchor.
  const anchorByGoal = new Map<string, string>();
  for (const g of goalRows) anchorByGoal.set(g.id, (g.anchorDate ?? new Date(g.createdAt * 1000).toISOString().slice(0, 10)));
  const distinctAnchors = [...new Set(anchorByGoal.values())];

  const allocatedAtAnchorById = new Map<string, number>();
  for (const anchor of distinctAnchors) {
    const nwAnchor = await netWorth({ asOf: anchor, owner: "household" });
    const allocAnchor = allocateGoals({
      goals: goalInputs,
      accounts: toAllocAccounts(nwAnchor.accounts, birthByUser),
    });
    for (const g of allocAnchor.goals) {
      if (anchorByGoal.get(g.id) === anchor) allocatedAtAnchorById.set(g.id, g.allocatedMinor);
    }
  }

  const analyses: GoalAnalysis[] = [];
  for (const g of goalRows) {
    const targetBase = targetBaseById.get(g.id) ?? g.targetAmountMinor;
    const alloc = allocById.get(g.id)!;

    // §5.3 projected allocated: grow each allocated line at its own rate to target year.
    const yearsToTarget = Math.max(0, yearOf(g.targetDate) - thisYear);
    let projectedAllocated = 0;
    for (const line of alloc.lines) {
      projectedAllocated += compoundMinor(line.allocatedMinor, line.growthRateBps, yearsToTarget);
    }
    const gap = targetBase - projectedAllocated;
    const monthsToTarget = monthsBetween(todayISO, g.targetDate);
    const requiredMonthly = requiredMonthlyContributionMinor(gap, planRateBps, monthsToTarget);

    // §5.4 on-track, per goal, anchored.
    const anchor = anchorByGoal.get(g.id)!;
    const startAnchor = allocatedAtAnchorById.get(g.id) ?? alloc.allocatedMinor;
    const ot = goalOnTrack({
      targetMinor: targetBase,
      startAnchorMinor: startAnchor,
      allocatedTodayMinor: alloc.allocatedMinor,
      planRateBps,
      monthsAnchorToToday: monthsBetween(anchor, todayISO),
      monthsAnchorToTarget: monthsBetween(anchor, g.targetDate),
    });

    analyses.push({
      id: g.id, name: g.name, term: g.term, targetAmountMinor: targetBase,
      targetDate: g.targetDate, currency: g.currency,
      allocatedMinor: alloc.allocatedMinor, progressPct: alloc.progressPct,
      projectedAllocatedMinor: projectedAllocated, gapMinor: Math.max(0, gap),
      requiredMonthlyMinor: requiredMonthly,
      onPlanTodayMinor: ot.onPlanTodayMinor, aheadByMinor: ot.aheadByMinor, onTrack: ot.onTrack,
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

// Shift an ISO date (YYYY-MM-DD) by whole months (UTC).
function addMonthsISO(iso: string, deltaMonths: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + deltaMonths);
  return d.toISOString().slice(0, 10);
}

export type GoalProjectionPoint = {
  date: string;
  actual: number | null;   // realized allocated value (past + today)
  onPlan: number | null;   // glide path (today + future)
  eligible: number | null; // allocated capital left to grow (today + future)
};

// A funding account that contributes to this goal, with its allocated slice.
export type GoalSource = {
  accountId: string;
  name: string;
  allocatedMinor: number;
};

export type GoalProjectionResult = {
  baseCurrency: string;
  goal: { id: string; name: string; term: "short" | "long"; targetDate: string; currency: string };
  targetMinor: number;
  allocatedMinor: number;
  progressPct: number;
  requiredMonthlyMinor: number;
  onTrack: boolean;
  aheadByMinor: number;
  sources: GoalSource[];
  series: GoalProjectionPoint[];
};

// Per-goal time series: realized allocation over the last `historyMonths`,
// then the on-plan glide path vs the eligible-accounts trajectory to the target
// date. All goal allocations are computed globally (no double-counting), then
// this goal's slice is taken. Returns null if the goal does not exist.
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
  const thisYear = yearOf(todayISO);

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

  // Funding sources: this goal's allocation lines with account names (most-liquid first,
  // the order allocation filled them).
  const nameById = new Map(nwToday.accounts.map((a) => [a.id, a.name]));
  const sources: GoalSource[] = mine.lines.map((line) => ({
    accountId: line.accountId,
    name: nameById.get(line.accountId) ?? line.accountId,
    allocatedMinor: line.allocatedMinor,
  }));

  // Required monthly (same model as analyzeGoals): grow allocated at per-account
  // annual rates to the target year, fill the gap at the plan rate.
  const yearsToTarget = Math.max(0, yearOf(goal.targetDate) - thisYear);
  let projectedAllocated = 0;
  for (const line of mine.lines) projectedAllocated += compoundMinor(line.allocatedMinor, line.growthRateBps, yearsToTarget);
  const monthsToTarget = monthsBetween(todayISO, goal.targetDate);
  const requiredMonthly = requiredMonthlyContributionMinor(targetBase - projectedAllocated, planRateBps, monthsToTarget);

  // On-track, anchored (same as analyzeGoals).
  const anchor = goal.anchorDate ?? new Date(goal.createdAt * 1000).toISOString().slice(0, 10);
  const nwAnchor = await netWorth({ asOf: anchor, owner: "household" });
  const allocAnchor = allocateGoals({ goals: goalInputs, accounts: toAllocAccounts(nwAnchor.accounts, birthByUser) });
  const startAnchor = allocAnchor.goals.find((g) => g.id === goal.id)?.allocatedMinor ?? allocatedToday;
  const ot = goalOnTrack({
    targetMinor: targetBase,
    startAnchorMinor: startAnchor,
    allocatedTodayMinor: allocatedToday,
    planRateBps,
    monthsAnchorToToday: monthsBetween(anchor, todayISO),
    monthsAnchorToTarget: monthsBetween(anchor, goal.targetDate),
  });

  const series: GoalProjectionPoint[] = [];

  // Past: realized allocation as of each month-end (oldest first).
  for (let k = historyMonths; k >= 1; k--) {
    const date = addMonthsISO(todayISO, -k);
    const nwPast = await netWorth({ asOf: date, owner: "household" });
    const allocPast = allocateGoals({ goals: goalInputs, accounts: toAllocAccounts(nwPast.accounts, birthByUser) });
    const realized = allocPast.goals.find((g) => g.id === goal.id)?.allocatedMinor ?? 0;
    series.push({ date, actual: realized, onPlan: null, eligible: null });
  }

  // Today: all three series meet at the current allocation.
  series.push({ date: todayISO, actual: allocatedToday, onPlan: allocatedToday, eligible: allocatedToday });

  // Future: step so a far-dated goal stays under ~120 points; always include the target month.
  const step = Math.max(1, Math.ceil(monthsToTarget / 120));
  const futureMonths: number[] = [];
  for (let m = step; m < monthsToTarget; m += step) futureMonths.push(m);
  if (monthsToTarget > 0) futureMonths.push(monthsToTarget);
  for (const m of futureMonths) {
    const date = addMonthsISO(todayISO, m);
    const onPlan = compoundMonthlyMinor(allocatedToday, planRateBps, m) + annuityFutureValueMinor(requiredMonthly, planRateBps, m);
    let eligible = 0;
    for (const line of mine.lines) eligible += compoundMonthlyMinor(line.allocatedMinor, line.growthRateBps, m);
    series.push({ date, actual: null, onPlan, eligible });
  }

  return {
    baseCurrency: base,
    goal: { id: goal.id, name: goal.name, term: goal.term, targetDate: goal.targetDate, currency: goal.currency },
    targetMinor: targetBase,
    allocatedMinor: allocatedToday,
    progressPct: mine.progressPct,
    requiredMonthlyMinor: requiredMonthly,
    onTrack: ot.onTrack,
    aheadByMinor: ot.aheadByMinor,
    sources,
    series,
  };
}
