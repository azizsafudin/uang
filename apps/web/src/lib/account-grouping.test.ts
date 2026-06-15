import { expect, test } from "bun:test";
import { visibleForOwner, type AccountValuation } from "./account-grouping";

function acct(id: string, ownerIds: string[]): AccountValuation {
  return {
    id,
    name: id,
    class: "asset",
    subtype: "bank",
    currency: "USD",
    balanceMinor: 0,
    baseMinor: 0,
    missingRate: false,
    ownerIds,
    shared: ownerIds.length >= 2,
    illiquid: false,
    groupId: null,
    sortOrder: 0,
  };
}

const accounts = [
  acct("solo-a", ["aziz"]),
  acct("solo-j", ["jihan"]),
  acct("shared", ["aziz", "jihan"]),
];

test("household shows everything", () => {
  expect(visibleForOwner(accounts, "household").map((a) => a.id)).toEqual([
    "solo-a",
    "solo-j",
    "shared",
  ]);
});

test("a member shows their solo accounts and any shared account they co-own", () => {
  expect(visibleForOwner(accounts, "aziz").map((a) => a.id)).toEqual([
    "solo-a",
    "shared",
  ]);
});

test("a member does not see another member's solo accounts", () => {
  expect(visibleForOwner(accounts, "jihan").map((a) => a.id)).toEqual([
    "solo-j",
    "shared",
  ]);
});
