import { expect, test } from "bun:test";
import { compoundMinor, projectSeries, accessibleValueMinor, type AccessibilityConfig } from "./projection";

test("compoundMinor: zero years returns the input", () => {
  expect(compoundMinor(100_000, 800, 0)).toBe(100_000);
});

test("compoundMinor: 8% for 1 year", () => {
  expect(compoundMinor(100_000, 800, 1)).toBe(108_000);
});

test("compoundMinor: 8% for 2 years compounds (banker's rounding)", () => {
  // 100000 -> 108000 -> 116640
  expect(compoundMinor(100_000, 800, 2)).toBe(116_640);
});

test("compoundMinor: 0% leaves balance unchanged", () => {
  expect(compoundMinor(43_000_00, 0, 30)).toBe(43_000_00);
});

test("compoundMinor: negative balances (debt) grow more negative", () => {
  expect(compoundMinor(-100_000, 250, 1)).toBe(-102_500);
});

test("compoundMinor: rejects non-integer / negative years", () => {
  expect(() => compoundMinor(1, 0, -1)).toThrow();
  expect(() => compoundMinor(1, 0, 1.5)).toThrow();
});

test("projectSeries: returns offsets 0..years inclusive", () => {
  expect(projectSeries(100_000, 800, 2)).toEqual([100_000, 108_000, 116_640]);
});

test("projectSeries: contribution added at start of each year before growth", () => {
  // y1: (100000 + 10000) * 1.08 = 118800 ; y2: (118800 + 10000) * 1.08 = 139104
  expect(projectSeries(100_000, 800, 2, 10_000)).toEqual([100_000, 118_800, 139_104]);
});

const liquid: AccessibilityConfig = {
  accessibleFromAge: 0, earlyWithdrawal: "none", earlyHaircutBps: 0,
  illiquid: false, liquidationAge: null,
};
const srs: AccessibilityConfig = {
  accessibleFromAge: 62, earlyWithdrawal: "penalty", earlyHaircutBps: 500,
  illiquid: false, liquidationAge: null,
};
const cpf: AccessibilityConfig = {
  accessibleFromAge: 55, earlyWithdrawal: "none", earlyHaircutBps: 0,
  illiquid: false, liquidationAge: null,
};
const property: AccessibilityConfig = {
  accessibleFromAge: 0, earlyWithdrawal: "none", earlyHaircutBps: 0,
  illiquid: true, liquidationAge: null,
};

test("liquid account is fully accessible at any age", () => {
  expect(accessibleValueMinor(100_000, 30, liquid)).toBe(100_000);
});

test("liabilities reduce accessible (negative passes through when liquid)", () => {
  expect(accessibleValueMinor(-50_000, 40, liquid)).toBe(-50_000);
});

test("SRS before free age: 5% penalty haircut", () => {
  expect(accessibleValueMinor(100_000, 50, srs)).toBe(95_000);
});

test("SRS at/after free age: full", () => {
  expect(accessibleValueMinor(100_000, 62, srs)).toBe(100_000);
});

test("CPF before 55 with earlyWithdrawal none: locked (0)", () => {
  expect(accessibleValueMinor(100_000, 40, cpf)).toBe(0);
});

test("CPF at 55: full", () => {
  expect(accessibleValueMinor(100_000, 55, cpf)).toBe(100_000);
});

test("illiquid is excluded until liquidationAge", () => {
  expect(accessibleValueMinor(700_000, 40, property)).toBe(0);
  expect(accessibleValueMinor(700_000, 40, { ...property, liquidationAge: 38 })).toBe(700_000);
});

test("infinite age (no birth year) treats age-gated as accessible", () => {
  expect(accessibleValueMinor(100_000, Number.POSITIVE_INFINITY, cpf)).toBe(100_000);
});

test("accessibleValueMinor: rejects out-of-range earlyHaircutBps", () => {
  const bad: AccessibilityConfig = {
    accessibleFromAge: 62, earlyWithdrawal: "penalty", earlyHaircutBps: 15000,
    illiquid: false, liquidationAge: null,
  };
  expect(() => accessibleValueMinor(100_000, 50, bad)).toThrow();
});

import { loanMonthlyPaymentMinor, projectNetWorth, projectAccountSeries, milestoneYears, type ProjectionAccount, type WithdrawalConfig, type AccumulationConfig } from "./projection";

const noSpend: WithdrawalConfig = {
  spendType: "none", spendAmountMinor: null, spendRateBps: null,
  spendStartKind: "age", spendStartAge: null, spendStartTargetMinor: null,
};

const noAcc: AccumulationConfig = {
  contributionMinor: 0, contributionUntilAge: null, compoundInterval: "annually",
};

test("milestoneYears: default 55/62/65", () => {
  expect(milestoneYears(1990)).toEqual([
    { age: 55, year: 2045 },
    { age: 62, year: 2052 },
    { age: 65, year: 2055 },
  ]);
});

test("projectNetWorth: total grows; accessible respects unlocks", () => {
  const cash: ProjectionAccount = {
    baseMinor: 100_000, growthRateBps: 0, accessibleFromAge: 0,
    earlyWithdrawal: "none", earlyHaircutBps: 0, illiquid: false,
    liquidationAge: null, ownerBirthYears: [1990], isLiability: false,
    loanTermMonths: null, ...noSpend, ...noAcc,
  };
  const cpf: ProjectionAccount = {
    baseMinor: 100_000, growthRateBps: 0, accessibleFromAge: 55,
    earlyWithdrawal: "none", earlyHaircutBps: 0, illiquid: false,
    liquidationAge: null, ownerBirthYears: [1990], isLiability: false,
    loanTermMonths: null, ...noSpend, ...noAcc,
  };
  // 2030: owner age 40 -> CPF locked. 2045: owner age 55 -> CPF unlocks.
  const pts = projectNetWorth({ accounts: [cash, cpf], fromYear: 2030, toYear: 2045 });
  expect(pts[0]).toEqual({ year: 2030, totalBaseMinor: 200_000, accessibleBaseMinor: 100_000 });
  expect(pts[pts.length - 1]).toEqual({ year: 2045, totalBaseMinor: 200_000, accessibleBaseMinor: 200_000 });
});

test("projectNetWorth: shared account uses the youngest owner's age", () => {
  const shared: ProjectionAccount = {
    baseMinor: 100_000, growthRateBps: 0, accessibleFromAge: 55,
    earlyWithdrawal: "none", earlyHaircutBps: 0, illiquid: false,
    liquidationAge: null, ownerBirthYears: [1980, 1990], isLiability: false,
    loanTermMonths: null, ...noSpend, ...noAcc, // youngest born 1990
  };
  const pts = projectNetWorth({ accounts: [shared], fromYear: 2040, toYear: 2045 });
  // 2040: younger is 50 -> locked. 2045: younger is 55 -> unlocked.
  expect(pts[0].accessibleBaseMinor).toBe(0);
  expect(pts[pts.length - 1].accessibleBaseMinor).toBe(100_000);
});

test("projectNetWorth: rejects inverted range", () => {
  expect(() => projectNetWorth({ accounts: [], fromYear: 2050, toYear: 2040 })).toThrow();
});

test("projectNetWorth: empty ownerBirthYears treats account as accessible", () => {
  const noBirth: ProjectionAccount = {
    baseMinor: 100_000, growthRateBps: 0, accessibleFromAge: 55,
    earlyWithdrawal: "none", earlyHaircutBps: 0, illiquid: false,
    liquidationAge: null, ownerBirthYears: [], isLiability: false,
    loanTermMonths: null, ...noSpend, ...noAcc,
  };
  const pts = projectNetWorth({ accounts: [noBirth], fromYear: 2030, toYear: 2030 });
  expect(pts[0].accessibleBaseMinor).toBe(100_000);
});

// --- Withdrawals -----------------------------------------------------------

const liquidSpend = {
  accessibleFromAge: 0, earlyWithdrawal: "none" as const, earlyHaircutBps: 0,
  illiquid: false, liquidationAge: null, isLiability: false, loanTermMonths: null,
  ...noSpend, ...noAcc,
};

test("withdrawal none: identical to compound-only baseline", () => {
  const a: ProjectionAccount = {
    ...liquidSpend, baseMinor: 100_000, growthRateBps: 800, ownerBirthYears: [1990],
  };
  expect(projectAccountSeries(a, 2, 2030, 1990)).toEqual(projectSeries(100_000, 800, 2));
});

test("withdrawal once + age trigger: lump removed once, nothing after", () => {
  const a: ProjectionAccount = {
    ...liquidSpend, baseMinor: 100_000, growthRateBps: 0, ownerBirthYears: [1990],
    spendType: "once", spendAmountMinor: 30_000, spendStartKind: "age", spendStartAge: 60,
  };
  const pts = projectNetWorth({ accounts: [a], fromYear: 2049, toYear: 2051 });
  expect(pts.map((p) => p.totalBaseMinor)).toEqual([100_000, 70_000, 70_000]);
});

test("withdrawal monthly + age trigger: 12x amount per year from start", () => {
  const a: ProjectionAccount = {
    ...liquidSpend, baseMinor: 1_000_000, growthRateBps: 0, ownerBirthYears: [1990],
    spendType: "monthly", spendAmountMinor: 5_000, spendStartKind: "age", spendStartAge: 60,
  };
  const pts = projectNetWorth({ accounts: [a], fromYear: 2049, toYear: 2051 });
  expect(pts.map((p) => p.totalBaseMinor)).toEqual([1_000_000, 940_000, 880_000]);
});

test("withdrawal percent + age trigger: rate% of balance per year", () => {
  const a: ProjectionAccount = {
    ...liquidSpend, baseMinor: 1_000_000, growthRateBps: 0, ownerBirthYears: [1990],
    spendType: "percent", spendRateBps: 400, spendStartKind: "age", spendStartAge: 60,
  };
  const pts = projectNetWorth({ accounts: [a], fromYear: 2049, toYear: 2051 });
  expect(pts.map((p) => p.totalBaseMinor)).toEqual([1_000_000, 960_000, 921_600]);
});

test("withdrawal target trigger latches on the first year balance crosses target", () => {
  const a: ProjectionAccount = {
    ...liquidSpend, baseMinor: 100_000, growthRateBps: 800, ownerBirthYears: [],
    spendType: "once", spendAmountMinor: 10_000, spendStartKind: "target",
    spendStartTargetMinor: 120_000,
  };
  const series = projectAccountSeries(a, 4, 2030, null);
  // grow: 100000,108000,116640,125971 -> at 125971 (>=120000) withdraw 10000 -> 115971; then grow.
  expect(series).toEqual([100_000, 108_000, 116_640, 115_971, 125_249]);
});

test("withdrawal capped at available balance (floored at 0)", () => {
  const a: ProjectionAccount = {
    ...liquidSpend, baseMinor: 50_000, growthRateBps: 0, ownerBirthYears: [1990],
    spendType: "monthly", spendAmountMinor: 10_000, spendStartKind: "age", spendStartAge: 60,
  };
  const pts = projectNetWorth({ accounts: [a], fromYear: 2049, toYear: 2051 });
  expect(pts.map((p) => p.totalBaseMinor)).toEqual([50_000, 0, 0]);
});

test("age trigger never fires without an owner birth year", () => {
  const a: ProjectionAccount = {
    ...liquidSpend, baseMinor: 100_000, growthRateBps: 0, ownerBirthYears: [],
    spendType: "percent", spendRateBps: 400, spendStartKind: "age", spendStartAge: 60,
  };
  const pts = projectNetWorth({ accounts: [a], fromYear: 2049, toYear: 2051 });
  expect(pts.map((p) => p.totalBaseMinor)).toEqual([100_000, 100_000, 100_000]);
});

test("liabilities keep compounding negative; withdrawal config ignored", () => {
  const a: ProjectionAccount = {
    ...liquidSpend, baseMinor: -100_000, growthRateBps: 250, ownerBirthYears: [1990],
    spendType: "monthly", spendAmountMinor: 9_999, spendStartKind: "age", spendStartAge: 0,
  };
  const series = projectAccountSeries(a, 1, 2030, 1990);
  expect(series).toEqual([-100_000, -102_500]);
});

// --- Contributions + compound interval -------------------------------------

test("monthly contribution compounds (annual interval): 12x/yr added before growth", () => {
  const a: ProjectionAccount = {
    ...liquidSpend, baseMinor: 0, growthRateBps: 1000, ownerBirthYears: [],
    contributionMinor: 1_000, contributionUntilAge: null,
  };
  // y1: (0 + 12000) * 1.10 = 13200 ; y2: (13200 + 12000) * 1.10 = 27720
  expect(projectAccountSeries(a, 2, 2030, null)).toEqual([0, 13_200, 27_720]);
});

test("contributions run until the cutoff age, then stop", () => {
  const a: ProjectionAccount = {
    ...liquidSpend, baseMinor: 0, growthRateBps: 0, ownerBirthYears: [2000],
    contributionMinor: 1_000, contributionUntilAge: 30,
  };
  // 2029 (age 29) contributes; 2030 (age 30) and after do not.
  expect(projectAccountSeries(a, 3, 2028, 2000)).toEqual([0, 12_000, 12_000, 12_000]);
});

test("no cutoff age + no birth year still contributes for the whole projection", () => {
  const a: ProjectionAccount = {
    ...liquidSpend, baseMinor: 0, growthRateBps: 0, ownerBirthYears: [],
    contributionMinor: 1_000, contributionUntilAge: 40,
  };
  // Age can't be computed (no birth year) so the cutoff can't apply — keep contributing.
  expect(projectAccountSeries(a, 2, 2030, null)).toEqual([0, 12_000, 24_000]);
});

test("compound interval: monthly > quarterly > annually for the same nominal rate", () => {
  const base = { ...liquidSpend, baseMinor: 1_000_000, growthRateBps: 1200, ownerBirthYears: [] };
  const annually = projectAccountSeries({ ...base, compoundInterval: "annually" }, 1, 2030, null)[1];
  const quarterly = projectAccountSeries({ ...base, compoundInterval: "quarterly" }, 1, 2030, null)[1];
  const monthly = projectAccountSeries({ ...base, compoundInterval: "monthly" }, 1, 2030, null)[1];
  expect(annually).toBe(1_120_000);
  expect(quarterly).toBeGreaterThan(annually);
  expect(monthly).toBeGreaterThan(quarterly);
});

// --- Loan amortization -------------------------------------------------------

// Minimal liability/loan account factory. baseMinor is negative (debt).
const loan = (over: Partial<ProjectionAccount>): ProjectionAccount => ({
  baseMinor: 0,
  growthRateBps: 0,
  ownerBirthYears: [],
  isLiability: true,
  loanTermMonths: null,
  accessibleFromAge: 0,
  earlyWithdrawal: "none",
  earlyHaircutBps: 0,
  illiquid: false,
  liquidationAge: null,
  spendType: "none",
  spendAmountMinor: null,
  spendRateBps: null,
  spendStartKind: "age",
  spendStartAge: null,
  spendStartTargetMinor: null,
  contributionMinor: 0,
  contributionUntilAge: null,
  compoundInterval: "annually",
  ...over,
});

test("loanMonthlyPaymentMinor: 20,000 @ 5% over 48 months ≈ 460.59", () => {
  expect(loanMonthlyPaymentMinor(2_000_000, 500, 48)).toBe(46_059);
});

test("loanMonthlyPaymentMinor: 0% is straight-line", () => {
  expect(loanMonthlyPaymentMinor(1_200_000, 0, 12)).toBe(100_000);
});

test("loanMonthlyPaymentMinor: no term => 0", () => {
  expect(loanMonthlyPaymentMinor(1_200_000, 500, 0)).toBe(0);
});

test("amortize 0% loan pays down to exactly 0 within the term", () => {
  const a = loan({ baseMinor: -120_000, growthRateBps: 0, loanTermMonths: 12 });
  expect(projectAccountSeries(a, 2, 2030, null)).toEqual([-120_000, 0, 0]);
});

test("amortize 0% loan over multiple years", () => {
  const a = loan({ baseMinor: -240_000, growthRateBps: 0, loanTermMonths: 24 });
  expect(projectAccountSeries(a, 3, 2030, null)).toEqual([-240_000, -120_000, 0, 0]);
});

test("amortize 0% 18-month loan: partial balance at year 1, zero at year 2", () => {
  const a = loan({ baseMinor: -180_000, growthRateBps: 0, loanTermMonths: 18 });
  expect(projectAccountSeries(a, 2, 2030, null)).toEqual([-180_000, -60_000, 0]);
});

test("amortized loan with interest ends exactly at 0 after the term", () => {
  const a = loan({ baseMinor: -2_000_000, growthRateBps: 500, loanTermMonths: 48 });
  const series = projectAccountSeries(a, 5, 2030, null);
  expect(series[0]).toBe(-2_000_000);
  expect(series[4]).toBe(0);
  expect(series[5]).toBe(0);
  expect(series[1]).toBeGreaterThan(series[0]);
  expect(series[2]).toBeGreaterThan(series[1]);
  expect(series[3]).toBeGreaterThan(series[2]);
});

test("liability with no term is held flat (no growth, no paydown)", () => {
  const a = loan({ baseMinor: -50_000, growthRateBps: 500, loanTermMonths: null });
  expect(projectAccountSeries(a, 3, 2030, null)).toEqual([-50_000, -50_000, -50_000, -50_000]);
});

test("net worth rollup: asset grows, loan amortizes away", () => {
  const asset = loan({
    isLiability: false,
    baseMinor: 1_000_000,
    growthRateBps: 0,
    loanTermMonths: null,
  });
  const debt = loan({ baseMinor: -120_000, growthRateBps: 0, loanTermMonths: 12 });
  const pts = projectNetWorth({ accounts: [asset, debt], fromYear: 2030, toYear: 2031 });
  expect(pts[0].totalBaseMinor).toBe(880_000);
  expect(pts[1].totalBaseMinor).toBe(1_000_000);
});
