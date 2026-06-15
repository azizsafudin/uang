import { expect, test } from "bun:test";
import { normalizeDescription, dedupHash } from "./dedup";

test("normalizeDescription collapses case and whitespace", () => {
  expect(normalizeDescription("  COFFEE   BEAN ")).toBe("coffee bean");
});

test("dedupHash is stable and sensitive to the key fields", () => {
  const a = dedupHash("acc1", { date: "2026-02-01", amountMinor: -450, description: "Coffee  Bean" });
  const b = dedupHash("acc1", { date: "2026-02-01", amountMinor: -450, description: "coffee bean" });
  const c = dedupHash("acc1", { date: "2026-02-01", amountMinor: -451, description: "coffee bean" });
  expect(a).toBe(b);          // normalization makes these equal
  expect(a).not.toBe(c);      // different amount
  expect(a).toHaveLength(64); // sha256 hex
});
