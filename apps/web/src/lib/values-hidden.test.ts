import { expect, test } from "bun:test";
import { MASK, maskMoney } from "./values-hidden";

test("maskMoney returns the formatted value when not hidden", () => {
  expect(maskMoney("£284,910", false)).toBe("£284,910");
});

test("maskMoney returns the mask placeholder when hidden", () => {
  expect(maskMoney("£284,910", true)).toBe(MASK);
});

test("MASK is a fixed bullet placeholder, independent of value length", () => {
  expect(maskMoney("£1", true)).toBe(MASK);
  expect(maskMoney("£1,234,567.89", true)).toBe(MASK);
  expect(MASK).toBe("••••••");
});
