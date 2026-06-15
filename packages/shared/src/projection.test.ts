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

import { projectNetWorth, projectAccountSeries, milestoneYears, type ProjectionAccount, type WithdrawalConfig } from "./projection";

const noSpend: WithdrawalConfig = {
  spendType: "none", spendAmountMinor: null, spendRateBps: null,
  spendStartKind: "age", spendStartAge: null, spendStartTargetMinor: null,
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
    liquidationAge: null, ownerBirthYears: [1990], ...noSpend,
  };
  const cpf: ProjectionAccount = {
    baseMinor: 100_000, growthRateBps: 0, accessibleFromAge: 55,
    earlyWithdrawal: "none", earlyHaircutBps: 0, illiquid: false,
    liquidationAge: null, ownerBirthYears: [1990], ...noSpend,
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
    liquidationAge: null, ownerBirthYears: [1980, 1990], ...noSpend, // youngest born 1990
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
    liquidationAge: null, ownerBirthYears: [], ...noSpend,
  };
  const pts = projectNetWorth({ accounts: [noBirth], fromYear: 2030, toYear: 2030 });
  expect(pts[0].accessibleBaseMinor).toBe(100_000);
});

// --- Withdrawals -----------------------------------------------------------

const liquidSpend = {
  accessibleFromAge: 0, earlyWithdrawal: "none" as const, earlyHaircutBps: 0,
  illiquid: false, liquidationAge: null, ...noSpend,
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
