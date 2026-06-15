import { expect, test } from "bun:test";
import { SCALE } from "@uang/shared";
import { parseAmountToMinor, amountMinorToUnitsDelta, unitsDeltaToAmountMinor } from "./amount";

const S = Number(SCALE);

test("parses amounts with separators, signs, parentheses, symbols", () => {
  const o = { decimal: ".", thousands: ",", currency: "USD" };
  expect(parseAmountToMinor("1,234.56", o)).toBe(123456);
  expect(parseAmountToMinor("-12.00", o)).toBe(-1200);
  expect(parseAmountToMinor("(45.00)", o)).toBe(-4500);   // accounting negative
  expect(parseAmountToMinor("$ 9.99", o)).toBe(999);
  expect(parseAmountToMinor("", o)).toBeNull();
});

test("normalizes negative zero to +0", () => {
  const result = parseAmountToMinor("(0.00)", { decimal: ".", thousands: ",", currency: "USD" });
  expect(result).toBe(0);
  expect(Object.is(result, -0)).toBe(false);
});

test("parses European 1.234,56 style", () => {
  expect(parseAmountToMinor("1.234,56", { decimal: ",", thousands: ".", currency: "USD" })).toBe(123456);
});

test("respects currency minor-unit digits (JPY=0)", () => {
  expect(parseAmountToMinor("1500", { decimal: ".", thousands: ",", currency: "JPY" })).toBe(1500);
});

test("converts minor units <-> unitsDelta exactly", () => {
  expect(amountMinorToUnitsDelta(1005, "USD")).toBe(1005 * S / 100);   // $10.05 → 1005000000
  expect(amountMinorToUnitsDelta(-1005, "USD")).toBe(-1005 * S / 100);
  expect(unitsDeltaToAmountMinor(1005 * S / 100, "USD")).toBe(1005);
  expect(unitsDeltaToAmountMinor(-1005 * S / 100, "USD")).toBe(-1005);
  // round-trip through both directions
  expect(unitsDeltaToAmountMinor(amountMinorToUnitsDelta(1500, "JPY"), "JPY")).toBe(1500);
});
