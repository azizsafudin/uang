import { expect, test } from "bun:test";
import { parseDate } from "./dates";

test("parses common statement date formats to YYYY-MM-DD", () => {
  expect(parseDate("01 Feb 2026", "DD MMM YYYY")).toBe("2026-02-01");
  expect(parseDate("2/1/2026", "M/D/YYYY")).toBe("2026-02-01");
  expect(parseDate("01/02/2026", "DD/MM/YYYY")).toBe("2026-02-01");
  expect(parseDate("2026-02-01", "YYYY-MM-DD")).toBe("2026-02-01");
  expect(parseDate("01-Feb-26", "DD-MMM-YY")).toBe("2026-02-01");
});

test("returns null for unparseable input", () => {
  expect(parseDate("", "DD MMM YYYY")).toBeNull();
  expect(parseDate("not a date", "DD MMM YYYY")).toBeNull();
  expect(parseDate("31 Foo 2026", "DD MMM YYYY")).toBeNull();
});

test("rejects impossible calendar dates", () => {
  expect(parseDate("31/04/2026", "DD/MM/YYYY")).toBeNull();   // April has 30 days
  expect(parseDate("29/02/2025", "DD/MM/YYYY")).toBeNull();   // 2025 not a leap year
  expect(parseDate("29/02/2024", "DD/MM/YYYY")).toBe("2024-02-29"); // leap year valid
});
