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
