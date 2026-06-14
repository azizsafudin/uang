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
