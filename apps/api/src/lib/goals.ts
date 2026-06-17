import { db } from "../db/client";
import { goals as goalsTable, memberProfiles, goalAccounts } from "../db/schema";
import {
  convertToBase, toBig, fromBig, roundDiv,
  compoundMonthlyMinor,
  allocateGoals, requiredMonthlyContributionMinor, simulateGoals,
  type AllocAccount, type GoalInput, type SimGoal, type SpendType,
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
  targetAmountMinor: number; // base currency
  targetDate: string | null; // null = indefinite (amount-only) goal
  currency: string;
  allocatedMinor: number;
  progressPct: number;
  monthlyContributionMinor: number;   // the goal's planned saving
  requiredMonthlyMinor: number;       // contribution needed to hit target by the date (0 if indefinite)
  projectedAtTargetMinor: number | null; // where the plan lands by the target date (null if indefinite)
  onTrack: boolean | null;            // dated: projected >= target; indefinite: null (no deadline)
  reachDate: string | null;          // YYYY-MM-DD the plan first reaches target (null = not within ~100y)
  spendType: SpendType;              // how this goal spends at/after targetDate
  spendAmountMinor: number | null;   // lump / monthly flat; null for percent/none goals
  spendRateBps: number | null;       // percent-of-balance rate; null for other spend types
  annualIncomeMinor: number | null;  // derived recurring income (monthly/percent); null otherwise
  accountIds: string[];              // accounts assigned to fund this goal
  contributionAccountId: string | null; // assigned account the monthly contribution lands in
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

// Drawdown display window appended after the target date so recurring spends are
// visible on the chart (30 years).
const DRAWDOWN_MONTHS = 360;

// Contribution that would land exactly on target by the deadline (per-goal,
// closed-form — ignores cascade, matching the "what you'd need alone" figure).
function requiredMonthlyMinorFor(
  allocatedMinor: number,
  targetMinor: number,
  planRateBps: number,
  monthsToTarget: number | null,
): number {
  if (monthsToTarget === null) return 0;
  const grown = compoundMonthlyMinor(allocatedMinor, planRateBps, monthsToTarget);
  return requiredMonthlyContributionMinor(targetMinor - grown, planRateBps, monthsToTarget);
}

// Derived recurring income: monthly -> flat * 12; percent -> rate% * balance at
// the target date; once/none -> null.
function annualIncomeMinorFor(
  spendType: SpendType,
  spendAmountMinor: number | null,
  spendRateBps: number | null,
  balanceAtTargetMinor: number | null,
): number | null {
  if (spendType === "monthly") return (spendAmountMinor ?? 0) * 12;
  if (spendType === "percent" && balanceAtTargetMinor !== null) {
    // Approximate annual income = rate% of the balance at the target date. For a
    // dated percent goal the sim already takes the first withdrawal in the target
    // month, so this reads the post-first-withdrawal balance — a slight understate,
    // adequate for the "≈ …/yr" display label.
    return fromBig(roundDiv(toBig(balanceAtTargetMinor) * toBig(spendRateBps ?? 0), 10_000n));
  }
  return null;
}

// Build the SimGoal list for the whole goal set (allocation is global). Caller
// supplies each goal's starting balance (today's allocation) and base target.
function toSimGoals(
  goalRows: GoalRow[],
  startById: Map<string, number>,
  targetBaseById: Map<string, number>,
  todayISO: string,
): SimGoal[] {
  return goalRows.map((g) => ({
    id: g.id,
    startBalanceMinor: startById.get(g.id) ?? 0,
    targetMinor: targetBaseById.get(g.id) ?? g.targetAmountMinor,
    targetMonth: g.targetDate ? monthsBetween(todayISO, g.targetDate) : null,
    monthlyContributionMinor: g.monthlyContributionMinor,
    spendType: g.spendType,
    spendAmountMinor: g.spendAmountMinor,
    spendRateBps: g.spendRateBps,
  }));
}

// A horizon large enough to cover every target date plus the drawdown window and
// to detect a late reach (mirrors the old ~1200-month search cap).
function simHorizon(goalRows: GoalRow[], todayISO: string): number {
  const targets = goalRows.map((g) => (g.targetDate ? monthsBetween(todayISO, g.targetDate) : 0));
  const maxTarget = targets.length ? Math.max(...targets) : 0;
  return Math.max(maxTarget + DRAWDOWN_MONTHS, 1200);
}

// Convert a goal's target into base currency using the latest FX rate.
async function targetInBaseMinor(g: GoalRow, base: string): Promise<number> {
  if (g.currency.toUpperCase() === base.toUpperCase()) return g.targetAmountMinor;
  const rate = await latestFxRateScaled(g.currency);
  if (rate === null) return g.targetAmountMinor; // no rate: best-effort, treat as base
  return fromBig(convertToBase(toBig(g.targetAmountMinor), g.currency, base, toBig(rate)));
}

// goalId -> assigned accountIds (order not significant; allocation sorts by liquidity).
async function loadAssignments(): Promise<Map<string, string[]>> {
  const links = await db.select().from(goalAccounts);
  const byGoal = new Map<string, string[]>();
  for (const l of links) {
    const arr = byGoal.get(l.goalId);
    if (arr) arr.push(l.accountId);
    else byGoal.set(l.goalId, [l.accountId]);
  }
  return byGoal;
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
  const accountIdsByGoal = await loadAssignments();

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
      id: g.id, targetAmountMinor: targetBase, targetYear: g.targetDate ? yearOf(g.targetDate) : null,
      ownerScope: g.ownerScope,
      accountIds: accountIdsByGoal.get(g.id) ?? [],
      priority: g.sortOrder,
    });
  }

  const allocToday = allocateGoals({ goals: goalInputs, accounts: allocAccountsToday });
  const allocById = new Map(allocToday.goals.map((g) => [g.id, g]));
  const startById = new Map(allocToday.goals.map((g) => [g.id, g.allocatedMinor]));

  // One global simulation drives reach/projection/income (cascade is global).
  const horizonMonths = simHorizon(goalRows, todayISO);
  const sim = simulateGoals({
    goals: toSimGoals(goalRows, startById, targetBaseById, todayISO),
    planRateBps,
    horizonMonths,
  });
  const simById = new Map(sim.goals.map((g) => [g.id, g]));

  const analyses: GoalAnalysis[] = [];
  for (const g of goalRows) {
    const targetBase = targetBaseById.get(g.id) ?? g.targetAmountMinor;
    const alloc = allocById.get(g.id)!;
    const sg = simById.get(g.id)!;
    const monthsToTarget = g.targetDate ? monthsBetween(todayISO, g.targetDate) : null;
    const reachMonths = sg.reachMonth;
    const balanceAtTarget = monthsToTarget === null ? null : (sg.balances[monthsToTarget] ?? null);
    const onTrack: boolean | null = monthsToTarget === null
      ? null
      : reachMonths !== null && reachMonths <= monthsToTarget;

    analyses.push({
      id: g.id, name: g.name, targetAmountMinor: targetBase,
      targetDate: g.targetDate, currency: g.currency,
      allocatedMinor: alloc.allocatedMinor, progressPct: alloc.progressPct,
      monthlyContributionMinor: g.monthlyContributionMinor,
      requiredMonthlyMinor: requiredMonthlyMinorFor(alloc.allocatedMinor, targetBase, planRateBps, monthsToTarget),
      projectedAtTargetMinor: balanceAtTarget,
      onTrack,
      reachDate: reachMonths === null ? null : addMonthsISO(todayISO, reachMonths),
      spendType: g.spendType,
      spendAmountMinor: g.spendAmountMinor,
      spendRateBps: g.spendRateBps,
      annualIncomeMinor: annualIncomeMinorFor(g.spendType, g.spendAmountMinor, g.spendRateBps, balanceAtTarget),
      accountIds: accountIdsByGoal.get(g.id) ?? [],
      contributionAccountId: g.contributionAccountId,
      sources: alloc.lines.map((line) => ({
        accountId: line.accountId,
        name: nameById.get(line.accountId) ?? line.accountId,
        allocatedMinor: line.allocatedMinor,
      })),
    });
  }

  const behindCount = analyses.filter((a) => a.onTrack === false).length;
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
  goal: { id: string; name: string; targetDate: string | null; currency: string };
  targetMinor: number;
  allocatedMinor: number;
  progressPct: number;
  monthlyContributionMinor: number;
  requiredMonthlyMinor: number;
  projectedAtTargetMinor: number | null;
  onTrack: boolean | null;
  reachDate: string | null; // YYYY-MM-DD the plan first reaches target (null = not within ~100y)
  spendType: SpendType;
  spendAmountMinor: number | null;   // 'once' lump / 'monthly' flat (for display); null otherwise
  annualIncomeMinor: number | null;
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
  const accountIdsByGoal = await loadAssignments();

  const todayISO = new Date().toISOString().slice(0, 10);

  // Inputs for ALL goals (allocation is global), with base-currency targets.
  const goalInputs: GoalInput[] = [];
  const targetBaseById = new Map<string, number>();
  for (const g of goalRows) {
    const tb = await targetInBaseMinor(g, base);
    targetBaseById.set(g.id, tb);
    goalInputs.push({
      id: g.id, targetAmountMinor: tb, targetYear: g.targetDate ? yearOf(g.targetDate) : null,
      ownerScope: g.ownerScope,
      accountIds: accountIdsByGoal.get(g.id) ?? [],
      priority: g.sortOrder,
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
  const monthsToTarget = goal.targetDate ? monthsBetween(todayISO, goal.targetDate) : null;

  // One global simulation (cascade is global); read this goal's trajectory off it.
  const startById = new Map(allocToday.goals.map((g) => [g.id, g.allocatedMinor]));
  const horizonMonths = simHorizon(goalRows, todayISO);
  const sim = simulateGoals({
    goals: toSimGoals(goalRows, startById, targetBaseById, todayISO),
    planRateBps,
    horizonMonths,
  });
  const sg = sim.goals.find((g) => g.id === goal.id)!;
  const reachMonths = sg.reachMonth;
  const balanceAtTarget = monthsToTarget === null ? null : (sg.balances[monthsToTarget] ?? null);
  const onTrack: boolean | null = monthsToTarget === null
    ? null
    : reachMonths !== null && reachMonths <= monthsToTarget;

  // Display window: to the target date for accumulate-only dated goals; extended
  // by the drawdown window for spend goals; to the reach month for indefinite goals.
  const displayHorizon =
    goal.spendType !== "none" && monthsToTarget !== null
      ? monthsToTarget + DRAWDOWN_MONTHS
      : monthsToTarget !== null
        ? monthsToTarget
        : (reachMonths ?? 360);

  const series: GoalProjectionPoint[] = [];

  // Past: realized allocation as of each month-end (oldest first).
  for (let k = historyMonths; k >= 1; k--) {
    const date = addMonthsISO(todayISO, -k);
    const nwPast = await netWorth({ asOf: date, owner: "household" });
    const allocPast = allocateGoals({ goals: goalInputs, accounts: toAllocAccounts(nwPast.accounts, birthByUser) });
    const realized = allocPast.goals.find((g) => g.id === goal.id)?.allocatedMinor ?? 0;
    series.push({ date, actual: realized, projected: null });
  }

  // Today: actual meets projected at the current allocation (== sim balances[0]).
  series.push({ date: todayISO, actual: allocatedToday, projected: allocatedToday });

  // Future: step so a far-dated goal stays under ~120 points; always include the
  // display horizon, the reach month, and the target month (the drawdown kink).
  const step = Math.max(1, Math.ceil(displayHorizon / 120));
  const monthsSet = new Set<number>();
  for (let mo = step; mo < displayHorizon; mo += step) monthsSet.add(mo);
  if (displayHorizon > 0) monthsSet.add(displayHorizon);
  if (reachMonths !== null && reachMonths > 0 && reachMonths <= displayHorizon) monthsSet.add(reachMonths);
  if (monthsToTarget !== null && monthsToTarget > 0 && monthsToTarget <= displayHorizon) monthsSet.add(monthsToTarget);
  const futureMonths = [...monthsSet].sort((a, b) => a - b);
  for (const mo of futureMonths) {
    series.push({ date: addMonthsISO(todayISO, mo), actual: null, projected: sg.balances[mo] ?? null });
  }

  return {
    baseCurrency: base,
    goal: { id: goal.id, name: goal.name, targetDate: goal.targetDate, currency: goal.currency },
    targetMinor: targetBase,
    allocatedMinor: allocatedToday,
    progressPct: mine.progressPct,
    monthlyContributionMinor: contribution,
    requiredMonthlyMinor: requiredMonthlyMinorFor(allocatedToday, targetBase, planRateBps, monthsToTarget),
    projectedAtTargetMinor: balanceAtTarget,
    onTrack,
    reachDate: reachMonths === null ? null : addMonthsISO(todayISO, reachMonths),
    spendType: goal.spendType,
    spendAmountMinor: goal.spendAmountMinor,
    annualIncomeMinor: annualIncomeMinorFor(goal.spendType, goal.spendAmountMinor, goal.spendRateBps, balanceAtTarget),
    sources,
    series,
  };
}
