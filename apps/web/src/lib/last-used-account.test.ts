import { expect, test } from "bun:test";
import { resolveDefaultAccountId } from "./last-used-account";

test("returns the most-recent transaction's account", () => {
  // api.transactions.get() is ordered most-recent-first.
  const tx = [{ account: { id: "b" } }, { account: { id: "a" } }];
  const accounts = [{ id: "a" }, { id: "b" }];
  expect(resolveDefaultAccountId(tx, accounts)).toBe("b");
});

test("skips a most-recent account that no longer exists", () => {
  const tx = [{ account: { id: "gone" } }, { account: { id: "a" } }];
  const accounts = [{ id: "a" }, { id: "b" }];
  expect(resolveDefaultAccountId(tx, accounts)).toBe("a");
});

test("falls back to the first account when there are no transactions", () => {
  expect(resolveDefaultAccountId([], [{ id: "a" }, { id: "b" }])).toBe("a");
  expect(resolveDefaultAccountId(undefined, [{ id: "x" }])).toBe("x");
});

test("returns undefined when there are no accounts", () => {
  expect(resolveDefaultAccountId([{ account: { id: "a" } }], [])).toBeUndefined();
  expect(resolveDefaultAccountId(undefined, undefined)).toBeUndefined();
});
