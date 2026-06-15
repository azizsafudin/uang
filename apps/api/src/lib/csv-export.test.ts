import { expect, test } from "bun:test";
import { csvField, toCsv, minorToDecimal, scaledToDecimal } from "./csv-export";

test("csvField escapes commas, quotes, newlines; blanks null", () => {
  expect(csvField("plain")).toBe("plain");
  expect(csvField("a,b")).toBe('"a,b"');
  expect(csvField('he said "hi"')).toBe('"he said ""hi"""');
  expect(csvField("line1\nline2")).toBe('"line1\nline2"');
  expect(csvField(null)).toBe("");
  expect(csvField(42)).toBe("42");
});

test("toCsv builds header + rows terminated by CRLF", () => {
  expect(toCsv(["a", "b"], [[1, "x,y"]])).toBe('a,b\r\n1,"x,y"\r\n');
});

test("minorToDecimal honours currency decimals (exact, integer-based)", () => {
  expect(minorToDecimal(123456, "USD")).toBe("1234.56");
  expect(minorToDecimal(-5, "USD")).toBe("-0.05");
  expect(minorToDecimal(1000, "JPY")).toBe("1000");
  expect(minorToDecimal(1234, "BHD")).toBe("1.234");
});

test("scaledToDecimal (×1e8) trims trailing zeros", () => {
  expect(scaledToDecimal(150000000)).toBe("1.5");
  expect(scaledToDecimal(100000000)).toBe("1");
  expect(scaledToDecimal(-12345000)).toBe("-0.12345");
  expect(scaledToDecimal(0)).toBe("0");
});
