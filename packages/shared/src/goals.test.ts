import { expect, test } from "bun:test";
import {
  annuityFutureValueMinor,
  requiredMonthlyContributionMinor,
  compoundMonthlyMinor,
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
