import { expect, test } from "bun:test";
import { slugifyHousehold } from "./export-name";

test("slugifyHousehold lowercases and hyphenates", () => {
  expect(slugifyHousehold("Demo Household")).toBe("demo-household");
  expect(slugifyHousehold("The Smiths")).toBe("the-smiths");
});

test("slugifyHousehold collapses punctuation and trims hyphens", () => {
  expect(slugifyHousehold("  O'Brien & Co.  ")).toBe("o-brien-co");
  expect(slugifyHousehold("Café Münch")).toBe("cafe-munch");
});

test("slugifyHousehold falls back to 'household' when empty", () => {
  expect(slugifyHousehold("")).toBe("household");
  expect(slugifyHousehold("   ")).toBe("household");
  expect(slugifyHousehold("@#$%")).toBe("household");
});
