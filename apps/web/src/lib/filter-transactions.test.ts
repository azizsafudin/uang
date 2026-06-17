import { expect, test } from "bun:test";
import { filterTransactions, ALL, type FilterableTx } from "./filter-transactions";

function tx(over: Partial<{
  symbol: string | null; name: string; kind: string;
  accountId: string; accountName: string;
  ownerIds: string[]; ownerNames: string[]; notes: string | null;
}> = {}): FilterableTx {
  return {
    instrument: {
      symbol: over.symbol ?? "AAPL",
      name: over.name ?? "Apple Inc",
      kind: over.kind ?? "stock",
    },
    account: { id: over.accountId ?? "acc1", name: over.accountName ?? "Brokerage" },
    ownerIds: over.ownerIds ?? ["u1"],
    ownerNames: over.ownerNames ?? ["Alice"],
    notes: over.notes ?? null,
  };
}

const NONE = { search: "", kind: ALL, accountId: ALL, ownerId: ALL };

test("no filters returns everything", () => {
  const rows = [tx(), tx({ symbol: "MSFT" })];
  expect(filterTransactions(rows, NONE)).toHaveLength(2);
});

test("kind filter matches exactly", () => {
  const rows = [tx({ kind: "stock" }), tx({ kind: "currency" })];
  expect(filterTransactions(rows, { ...NONE, kind: "currency" })).toHaveLength(1);
});

test("account filter matches by id", () => {
  const rows = [tx({ accountId: "a" }), tx({ accountId: "b" })];
  const out = filterTransactions(rows, { ...NONE, accountId: "b" });
  expect(out.map((t) => t.account.id)).toEqual(["b"]);
});

test("owner filter matches when owner is one of the account's owners", () => {
  const rows = [
    tx({ ownerIds: ["u1"] }),
    tx({ ownerIds: ["u2", "u3"] }), // shared
  ];
  expect(filterTransactions(rows, { ...NONE, ownerId: "u1" })).toHaveLength(1);
  // u3 co-owns the shared account, so that row matches.
  expect(filterTransactions(rows, { ...NONE, ownerId: "u3" })).toHaveLength(1);
  expect(filterTransactions(rows, { ...NONE, ownerId: "nobody" })).toHaveLength(0);
});

test("search is case-insensitive across symbol, name, account, owner, notes", () => {
  const rows = [
    tx({ symbol: "AAPL", name: "Apple Inc" }),
    tx({ symbol: "MSFT", name: "Microsoft", accountName: "Pension", ownerNames: ["Bob"], notes: "rebalance" }),
  ];
  expect(filterTransactions(rows, { ...NONE, search: "apple" })).toHaveLength(1);
  expect(filterTransactions(rows, { ...NONE, search: "PENSION" })).toHaveLength(1);
  expect(filterTransactions(rows, { ...NONE, search: "bob" })).toHaveLength(1);
  expect(filterTransactions(rows, { ...NONE, search: "rebalance" })).toHaveLength(1);
});

test("search trims whitespace and combines with property filters", () => {
  const rows = [
    tx({ symbol: "AAPL", kind: "stock" }),
    tx({ symbol: "AAPL", kind: "currency" }),
  ];
  const out = filterTransactions(rows, { ...NONE, search: "  aapl  ", kind: "stock" });
  expect(out).toHaveLength(1);
  expect(out[0].instrument.kind).toBe("stock");
});

test("null symbol/notes and empty owners don't break search", () => {
  const rows = [tx({ symbol: null, notes: null, ownerIds: [], ownerNames: [], name: "Cash" })];
  expect(filterTransactions(rows, { ...NONE, search: "cash" })).toHaveLength(1);
  expect(filterTransactions(rows, { ...NONE, search: "zzz" })).toHaveLength(0);
});
