import { expect, test } from "bun:test";
import {
  annuityFutureValueMinor,
  requiredMonthlyContributionMinor,
  compoundMonthlyMinor,
  monthsToReachMinor,
  simulateGoals,
  type SimGoal,
} from "./goals";

// --- annuity future value (level monthly payment, ordinary annuity) ---

test("annuityFV: zero rate is just sum of payments", () => {
  expect(annuityFutureValueMinor(100_000, 0, 12)).toBe(1_200_000);
});

test("annuityFV: zero months is zero", () => {
  expect(annuityFutureValueMinor(100_000, 800, 0)).toBe(0);
});

test("annuityFV: positive rate exceeds the undiscounted sum", () => {
  // 60 payments of $500 (50_000 minor) at 6% nominal; FV > 60*50_000 = 3_000_000.
  const fv = annuityFutureValueMinor(50_000, 600, 60);
  expect(fv).toBeGreaterThan(3_000_000);
  expect(fv).toBeLessThan(3_600_000); // sanity ceiling
});

// --- required monthly contribution (inverse of annuity FV) ---

test("requiredMonthly: zero gap needs nothing", () => {
  expect(requiredMonthlyContributionMinor(0, 800, 120)).toBe(0);
  expect(requiredMonthlyContributionMinor(-5_000, 800, 120)).toBe(0);
});

test("requiredMonthly: zero rate spreads the gap evenly", () => {
  expect(requiredMonthlyContributionMinor(1_200_000, 0, 12)).toBe(100_000);
});

test("requiredMonthly: no months left means the whole gap is needed now", () => {
  expect(requiredMonthlyContributionMinor(900_000, 800, 0)).toBe(900_000);
});

test("requiredMonthly is the inverse of annuityFV (round-trips within rounding)", () => {
  const pmt = 50_000;
  const fv = annuityFutureValueMinor(pmt, 600, 120);
  const solved = requiredMonthlyContributionMinor(fv, 600, 120);
  expect(Math.abs(solved - pmt)).toBeLessThanOrEqual(2);
});

// --- monthly compounding of a lump sum ---

test("compoundMonthly: zero rate leaves principal unchanged", () => {
  expect(compoundMonthlyMinor(100_000, 0, 24)).toBe(100_000);
});

test("compoundMonthly: 12% nominal for 12 months ≈ principal * 1.01^12", () => {
  // 1.01^12 = 1.12682503... -> 112_683 (allow ±2 for banker's rounding drift)
  expect(Math.abs(compoundMonthlyMinor(100_000, 1200, 12) - 112_683)).toBeLessThanOrEqual(2);
});

import { allocateGoals, type AllocAccount, type GoalInput } from "./goals";

// Owner u1 born 1990. Account ages are derived from each goal's targetYear.
const u1 = "u1";
const liquid = {
  accessibleFromAge: 0, earlyWithdrawal: "none" as const, earlyHaircutBps: 0,
  illiquid: false, liquidationAge: null,
};
const cpfCfg = {
  accessibleFromAge: 55, earlyWithdrawal: "none" as const, earlyHaircutBps: 0,
  illiquid: false, liquidationAge: null,
};
const srsCfg = {
  accessibleFromAge: 62, earlyWithdrawal: "penalty" as const, earlyHaircutBps: 500,
  illiquid: false, liquidationAge: null,
};

function acct(id: string, baseMinor: number, cfg: typeof liquid, ownerIds = [u1], births = [1990]): AllocAccount {
  return { id, baseMinor, growthRateBps: 0, ownerIds, ownerBirthYears: births, ...cfg };
}

test("allocateGoals: soonest-first, no double-counting, short sees cash only", () => {
  const cash = acct("cash", 5_000_000, liquid);
  const cpf = acct("cpf", 10_000_000, cpfCfg);
  const goals: GoalInput[] = [
    // owner age in 2050 = 60 (CPF unlocked); in 2030 = 40 (CPF locked).
    { id: "long", targetAmountMinor: 20_000_000, targetYear: 2050, ownerScope: "household", term: "long", sortOrder: 0 },
    { id: "short", targetAmountMinor: 3_000_000, targetYear: 2030, ownerScope: "household", term: "short", sortOrder: 0 },
  ];
  const r = allocateGoals({ goals, accounts: [cash, cpf] });
  const short = r.goals.find((g) => g.id === "short")!;
  const long = r.goals.find((g) => g.id === "long")!;
  // Short (2030) fills entirely from cash (CPF locked at 40); cash left = 2_000_000.
  expect(short.allocatedMinor).toBe(3_000_000);
  expect(short.progressPct).toBe(100);
  // Long (2050) takes the remaining cash 2_000_000 then all CPF 10_000_000 = 12_000_000 / 20_000_000.
  expect(long.allocatedMinor).toBe(12_000_000);
  expect(long.progressPct).toBe(60);
  expect(r.unallocatedMinor).toBe(0);
});

test("allocateGoals: penalty account is valued after the haircut", () => {
  const srs = acct("srs", 1_000_000, srsCfg);
  const goals: GoalInput[] = [
    // owner age in 2030 = 40 (< 62) -> penalty 5%; eligible at 95% value.
    { id: "g", targetAmountMinor: 2_000_000, targetYear: 2030, ownerScope: "household", term: "long", sortOrder: 0 },
  ];
  const r = allocateGoals({ goals, accounts: [srs] });
  expect(r.goals[0].allocatedMinor).toBe(950_000); // 1_000_000 * 0.95
  expect(r.unallocatedMinor).toBe(0); // whole raw balance consumed
});

test("allocateGoals: illiquid excluded unless liquidationAge reached by target", () => {
  const propLocked = acct("prop", 7_000_000, { ...liquid, illiquid: true });
  const propSold = acct("prop2", 7_000_000, { ...liquid, illiquid: true, liquidationAge: 50 });
  const goals: GoalInput[] = [
    // owner age in 2050 = 60 >= 50 -> propSold eligible; propLocked never.
    { id: "g", targetAmountMinor: 100_000_000, targetYear: 2050, ownerScope: "household", term: "long", sortOrder: 0 },
  ];
  const r = allocateGoals({ goals, accounts: [propLocked, propSold] });
  expect(r.goals[0].allocatedMinor).toBe(7_000_000);
  expect(r.unallocatedMinor).toBe(7_000_000); // propLocked stays free
});

test("allocateGoals: ownerScope — personal goal sees only that member's solo accounts", () => {
  const u1solo = acct("a", 1_000_000, liquid, ["u1"]);
  const u2solo = acct("b", 1_000_000, liquid, ["u2"], [1992]);
  const shared = acct("c", 1_000_000, liquid, ["u1", "u2"], [1990, 1992]);
  const goals: GoalInput[] = [
    { id: "mine", targetAmountMinor: 9_000_000, targetYear: 2030, ownerScope: "u1", term: "short", sortOrder: 0 },
  ];
  const r = allocateGoals({ goals, accounts: [u1solo, u2solo, shared] });
  // Only u1's solo account funds a u1-personal goal (shared funds household only).
  expect(r.goals[0].allocatedMinor).toBe(1_000_000);
  expect(r.unallocatedMinor).toBe(2_000_000); // u2solo + shared untouched
});

test("allocateGoals: liabilities / negative balances never fund a goal", () => {
  const debt = acct("debt", -500_000, liquid);
  const cash = acct("cash", 1_000_000, liquid);
  const goals: GoalInput[] = [
    { id: "g", targetAmountMinor: 5_000_000, targetYear: 2030, ownerScope: "household", term: "short", sortOrder: 0 },
  ];
  const r = allocateGoals({ goals, accounts: [debt, cash] });
  expect(r.goals[0].allocatedMinor).toBe(1_000_000);
  expect(r.unallocatedMinor).toBe(0);
});

import { goalOnTrack } from "./goals";

test("goalOnTrack: zero planning rate is hand-computable; ahead when actual exceeds plan", () => {
  // target 1_000_000, start-at-anchor 100_000, 100 months to target, 20 elapsed.
  // plan rate 0 -> requiredPmt = (1_000_000 - 100_000) / 100 = 9_000/mo.
  // onPlanToday = 100_000 + 9_000*20 = 280_000.
  const r = goalOnTrack({
    targetMinor: 1_000_000, startAnchorMinor: 100_000, allocatedTodayMinor: 300_000,
    planRateBps: 0, monthsAnchorToToday: 20, monthsAnchorToTarget: 100,
  });
  expect(r.onPlanTodayMinor).toBe(280_000);
  expect(r.aheadByMinor).toBe(20_000);
  expect(r.onTrack).toBe(true);
});

test("goalOnTrack: behind when actual is below the on-plan value", () => {
  const r = goalOnTrack({
    targetMinor: 1_000_000, startAnchorMinor: 100_000, allocatedTodayMinor: 250_000,
    planRateBps: 0, monthsAnchorToToday: 20, monthsAnchorToTarget: 100,
  });
  expect(r.onPlanTodayMinor).toBe(280_000);
  expect(r.aheadByMinor).toBe(-30_000);
  expect(r.onTrack).toBe(false);
});

test("goalOnTrack: a brand-new goal (no time elapsed) is on track by construction", () => {
  const r = goalOnTrack({
    targetMinor: 1_000_000, startAnchorMinor: 250_000, allocatedTodayMinor: 250_000,
    planRateBps: 800, monthsAnchorToToday: 0, monthsAnchorToTarget: 120,
  });
  expect(r.onPlanTodayMinor).toBe(250_000); // start grown 0 months + 0 contributions
  expect(r.aheadByMinor).toBe(0);
  expect(r.onTrack).toBe(true);
});

test("monthsToReachMinor: already at/above target is month 0", () => {
  expect(monthsToReachMinor(100_000, 0, 100_000, 800, 1200)).toBe(0);
  expect(monthsToReachMinor(150_000, 0, 100_000, 800, 1200)).toBe(0);
});

test("monthsToReachMinor: zero rate is a straight contribution count", () => {
  // need 1_200_000 from 0 at 100_000/mo, no growth -> 12 months.
  expect(monthsToReachMinor(0, 100_000, 1_200_000, 0, 1200)).toBe(12);
});

test("monthsToReachMinor: returns null when unreachable within the cap", () => {
  // No growth, no contribution -> never reaches.
  expect(monthsToReachMinor(50_000, 0, 100_000, 0, 240)).toBeNull();
});

test("monthsToReachMinor: growth alone eventually reaches the target", () => {
  const m = monthsToReachMinor(50_000, 0, 100_000, 800, 1200);
  expect(m).not.toBeNull();
  expect(m!).toBeGreaterThan(0);
});

test("monthsToReachMinor: more contribution reaches sooner", () => {
  const slow = monthsToReachMinor(0, 50_000, 5_000_000, 800, 1200)!;
  const fast = monthsToReachMinor(0, 200_000, 5_000_000, 800, 1200)!;
  expect(fast).toBeLessThan(slow);
});

// --- simulateGoals: month-by-month multi-goal cashflow ---

// Convenience builder so tests only specify what they exercise.
function simGoal(over: Partial<SimGoal> & { id: string }): SimGoal {
  return {
    startBalanceMinor: 0,
    targetMinor: 0,
    targetMonth: null,
    monthlyContributionMinor: 0,
    spendType: "none",
    spendAmountMinor: null,
    spendRateBps: null,
    ...over,
  };
}

test("simulateGoals: single-goal accumulation matches monthsToReachMinor (regression guard)", () => {
  const start = 1_000_000, contrib = 50_000, target = 5_000_000, rate = 800, horizon = 1200;
  const { goals } = simulateGoals({
    goals: [simGoal({ id: "a", startBalanceMinor: start, targetMinor: target, monthlyContributionMinor: contrib })],
    planRateBps: rate,
    horizonMonths: horizon,
  });
  const reach = monthsToReachMinor(start, contrib, target, rate, horizon);
  expect(goals[0].reachMonth).toBe(reach);
  expect(goals[0].balances.length).toBe(horizon + 1);
  expect(goals[0].balances[0]).toBe(start);
});

test("simulateGoals: zero-rate accumulation is start + n*contribution", () => {
  const { goals } = simulateGoals({
    goals: [simGoal({ id: "a", startBalanceMinor: 100, targetMinor: 10_000, monthlyContributionMinor: 10 })],
    planRateBps: 0,
    horizonMonths: 5,
  });
  expect(goals[0].balances).toEqual([100, 110, 120, 130, 140, 150]);
});

test("simulateGoals: a goal already at target reports reachMonth 0", () => {
  const { goals } = simulateGoals({
    goals: [simGoal({ id: "a", startBalanceMinor: 3_000_000, targetMinor: 3_000_000 })],
    planRateBps: 800,
    horizonMonths: 12,
  });
  expect(goals[0].reachMonth).toBe(0);
});

test("simulateGoals: a finished goal's freed contribution + surplus accelerate the next goal", () => {
  const planRateBps = 0; // isolate the cascade from growth

  // Goal A overshoots its 1,000,000 target at month 1 (contributes 1,100,000):
  // it frees its contribution AND cascades the 100,000 surplus to B.
  const A = simGoal({ id: "a", startBalanceMinor: 0, targetMinor: 1_000_000, targetMonth: 1, monthlyContributionMinor: 1_100_000 });
  // Goal B: large + later, contributes 100,000/mo.
  const B = simGoal({ id: "b", startBalanceMinor: 0, targetMinor: 10_000_000, targetMonth: 240, monthlyContributionMinor: 100_000 });

  const bWith = simulateGoals({ goals: [A, B], planRateBps, horizonMonths: 1200 })
    .goals.find((g) => g.id === "b")!.reachMonth!;
  const bAlone = simulateGoals({ goals: [B], planRateBps, horizonMonths: 1200 })
    .goals[0].reachMonth!;

  // B alone: 10,000,000 / 100,000 = 100 months.
  expect(bAlone).toBe(100);
  // With A's freed 1,100,000/mo + 100,000 surplus, B reaches far sooner.
  expect(bWith).toBeLessThan(bAlone);
  expect(bWith).toBeLessThanOrEqual(11);
});

test("simulateGoals: one-time spend removes the lump at targetMonth and cascades the remainder", () => {
  // A holds its 1,000,000 target, spends 600,000 once at month 1; the 400,000
  // leftover cascades to B (which is far from its target, so stays active).
  const A = simGoal({ id: "a", startBalanceMinor: 1_000_000, targetMinor: 1_000_000, targetMonth: 1, spendType: "once", spendAmountMinor: 600_000 });
  const B = simGoal({ id: "b", startBalanceMinor: 0, targetMinor: 100_000_000, targetMonth: 360 });
  const { goals } = simulateGoals({ goals: [A, B], planRateBps: 0, horizonMonths: 3 });
  const a = goals.find((g) => g.id === "a")!;
  const b = goals.find((g) => g.id === "b")!;
  expect(a.balances[1]).toBe(0);        // emptied after the once-spend
  expect(a.balances[2]).toBe(0);        // stays empty
  expect(b.balances[1]).toBe(400_000);  // leftover cascaded to B
});

test("simulateGoals: monthly spend depletes the balance each month from targetMonth", () => {
  const A = simGoal({ id: "a", startBalanceMinor: 1_000_000, targetMinor: 1_000_000, targetMonth: 0, spendType: "monthly", spendAmountMinor: 100_000 });
  const { goals } = simulateGoals({ goals: [A], planRateBps: 0, horizonMonths: 3 });
  expect(goals[0].balances).toEqual([1_000_000, 900_000, 800_000, 700_000]);
});

test("simulateGoals: percent spend withdraws a share of current balance and never fully depletes", () => {
  const A = simGoal({ id: "a", startBalanceMinor: 10_000_000, targetMinor: 10_000_000, targetMonth: 0, spendType: "percent", spendRateBps: 400 });
  const { goals } = simulateGoals({ goals: [A], planRateBps: 0, horizonMonths: 36 });
  const b = goals[0].balances;
  // Withdrawals at the 12-month marks from targetMonth (12, 24, 36); 4% of current.
  expect(b[12]).toBe(10_000_000 - 400_000);   // 4% of 10,000,000
  expect(b[24]).toBe(9_600_000 - 384_000);    // 4% of 9,600,000
  expect(b[b.length - 1]).toBeGreaterThan(0); // self-adjusting; never zero
});
