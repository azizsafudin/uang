import { expect, test } from "bun:test";
import { roundDiv } from "./money";

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
});
