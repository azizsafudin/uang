import { expect, test } from "bun:test";
import { compoundMinor, projectSeries } from "./projection";

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

import { accessibleValueMinor, type AccessibilityConfig } from "./projection";

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
