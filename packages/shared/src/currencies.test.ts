import { expect, test } from "bun:test";
import { currencyDecimals } from "./currencies";

test("known minor-unit digits", () => {
  expect(currencyDecimals("USD")).toBe(2);
  expect(currencyDecimals("MYR")).toBe(2);
  expect(currencyDecimals("JPY")).toBe(0);
  expect(currencyDecimals("BHD")).toBe(3);
});

test("is case-insensitive", () => {
  expect(currencyDecimals("jpy")).toBe(0);
});

test("defaults unknown codes to 2", () => {
  expect(currencyDecimals("ZZZ")).toBe(2);
});

import { currencyName } from "./currencies";

test("currencyName returns a friendly name for known codes", () => {
  expect(currencyName("SGD")).toBe("Singapore Dollar");
  expect(currencyName("usd")).toBe("US Dollar");
});

test("currencyName falls back to the upper-cased code for unknown currencies", () => {
  expect(currencyName("xyz")).toBe("XYZ");
});
