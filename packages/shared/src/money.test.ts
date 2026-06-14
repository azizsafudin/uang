import { expect, test } from "bun:test";
import { roundDiv, SCALE, convertToBase } from "./money";

test("exact division", () => {
  expect(roundDiv(10n, 2n)).toBe(5n);
});

test("rounds down below half", () => {
  expect(roundDiv(7n, 5n)).toBe(1n); // 1.4 -> 1
});

test("rounds up above half", () => {
  expect(roundDiv(9n, 5n)).toBe(2n); // 1.8 -> 2
});

test("half rounds to even", () => {
  expect(roundDiv(5n, 2n)).toBe(2n); // 2.5 -> 2 (even)
  expect(roundDiv(15n, 2n)).toBe(8n); // 7.5 -> 8 (even)
});

test("handles negatives symmetrically", () => {
  expect(roundDiv(-5n, 2n)).toBe(-2n); // -2.5 -> -2 (even)
  expect(roundDiv(-9n, 5n)).toBe(-2n); // -1.8 -> -2
  expect(roundDiv(-15n, 2n)).toBe(-8n); // -7.5 -> -8 (even)
});

test("throws on zero or negative denominator", () => {
  expect(() => roundDiv(1n, 0n)).toThrow("denominator must be positive");
  expect(() => roundDiv(1n, -1n)).toThrow("denominator must be positive");
});

test("base currency converts 1:1 regardless of rate arg", () => {
  // 12345 USD-minor (=$123.45) to USD base
  expect(convertToBase(12345n, "USD", "USD", SCALE)).toBe(12345n);
});

test("same decimals, simple rate (USD->MYR at 4.5)", () => {
  // $100.00 = 10000 minor; rate 4.5 -> RM450.00 = 45000 minor
  const rate = 45n * SCALE / 10n; // 4.5 * 1e8
  expect(convertToBase(10000n, "USD", "MYR", rate)).toBe(45000n);
});

test("fewer source decimals (JPY 0-dec -> USD 2-dec)", () => {
  // 1000 JPY (units, 0 decimals) at 0.0067 USD/JPY -> 6.70 USD = 670 minor
  const rate = 67n * SCALE / 10000n; // 0.0067 * 1e8
  expect(convertToBase(1000n, "JPY", "USD", rate)).toBe(670n);
});

test("more source decimals (BHD 3-dec -> USD 2-dec)", () => {
  // 1.500 BHD = 1500 minor at 2.65 USD/BHD -> 3.975 -> 398 (round half even) USD minor
  const rate = 265n * SCALE / 100n; // 2.65 * 1e8
  expect(convertToBase(1500n, "BHD", "USD", rate)).toBe(398n);
});

test("negative amounts (liabilities) convert correctly", () => {
  const rate = 45n * SCALE / 10n;
  expect(convertToBase(-10000n, "USD", "MYR", rate)).toBe(-45000n);
});

import { toBig, fromBig } from "./money";

test("toBig/fromBig round-trip integers", () => {
  expect(toBig(12345)).toBe(12345n);
  expect(fromBig(12345n)).toBe(12345);
  expect(toBig(-50)).toBe(-50n);
});

test("fromBig throws above the safe integer boundary", () => {
  expect(() => fromBig(9_007_199_254_740_993n)).toThrow();
});
