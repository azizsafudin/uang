import { describe, expect, it } from "bun:test";
import { cleanMoneyInput, formatMoneyInput } from "./money.ts";

describe("cleanMoneyInput", () => {
  it("keeps plain digits", () => {
    expect(cleanMoneyInput("5400")).toBe("5400");
  });

  it("strips grouping separators and currency symbols", () => {
    expect(cleanMoneyInput("$5,400.00")).toBe("5400.00");
    expect(cleanMoneyInput("RM 1,234")).toBe("1234");
  });

  it("keeps a single leading minus", () => {
    expect(cleanMoneyInput("-5400")).toBe("-5400");
    expect(cleanMoneyInput("5-4-0-0")).toBe("5400");
  });

  it("keeps only the first decimal point", () => {
    expect(cleanMoneyInput("54.0.0")).toBe("54.00");
    expect(cleanMoneyInput("12.34")).toBe("12.34");
  });

  it("drops a lone minus with no digits", () => {
    expect(cleanMoneyInput("-")).toBe("");
  });

  it("passes through empty", () => {
    expect(cleanMoneyInput("")).toBe("");
  });
});

describe("formatMoneyInput", () => {
  it("adds grouping and symbol with currency decimals", () => {
    expect(formatMoneyInput("5400", "USD")).toBe("$5,400.00");
    expect(formatMoneyInput("1234.5", "SGD")).toBe("$1,234.50");
  });

  it("respects zero-decimal currencies", () => {
    expect(formatMoneyInput("5400", "JPY")).toBe("¥5,400");
  });

  it("formats negatives with a leading minus", () => {
    expect(formatMoneyInput("-5400", "USD")).toBe("-$5,400.00");
  });

  it("falls back to the ISO code for unknown symbols", () => {
    expect(formatMoneyInput("100", "XYZ")).toBe("XYZ100.00");
  });

  it("passes through partial entries unchanged", () => {
    expect(formatMoneyInput("", "USD")).toBe("");
    expect(formatMoneyInput("-", "USD")).toBe("-");
    expect(formatMoneyInput(".", "USD")).toBe(".");
  });
});
