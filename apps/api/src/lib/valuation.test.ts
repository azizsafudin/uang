import { expect, test, beforeEach } from "bun:test";
import { resetDb } from "./test-helpers";
import { db } from "../db/client";
import { settings, accounts, entries, fxRates, accountOwners, instruments, lots, prices } from "../db/schema";
import { SCALE } from "@uang/shared";
import { createId, nowEpoch } from "./ids";
import { accountBalanceMinor, netWorth } from "./valuation";

async function seedBase(currency: string) {
  await db.insert(settings).values({ id: 1, householdName: "H", baseCurrency: currency, createdAt: nowEpoch() });
}
async function addAccount(p: { name: string; cls: string; currency: string }) {
  const id = createId();
  await db.insert(accounts).values({
    id, name: p.name, class: p.cls, subtype: "bank", currency: p.currency,
    valuationMode: "ledger", isArchived: 0, sortOrder: 0, createdAt: nowEpoch(), createdBy: "u",
  });
  return id;
}
async function addEntry(accountId: string, amountMinor: number, date: string, kind = "opening") {
  await db.insert(entries).values({
    id: createId(), accountId, date, amountMinor, kind, createdAt: nowEpoch(), createdBy: "u",
  });
}
async function setOwnersDirect(accountId: string, userIds: string[]) {
  for (const userId of userIds) {
    await db.insert(accountOwners).values({ accountId, userId });
  }
}
async function addHoldingsAccount(name: string) {
  const id = createId();
  await db.insert(accounts).values({
    id, name, class: "asset", subtype: "investment", currency: "USD",
    valuationMode: "holdings", isArchived: 0, sortOrder: 0, createdAt: nowEpoch(), createdBy: "u",
  });
  return id;
}
async function addInstrument(currency: string) {
  const id = createId();
  await db.insert(instruments).values({ id, symbol: "X", isin: null, name: "X", kind: "stock", currency, createdAt: nowEpoch() });
  return id;
}
async function addPrice(instrumentId: string, date: string, priceMajor: number) {
  await db.insert(prices).values({ id: createId(), instrumentId, date, priceScaled: Math.round(priceMajor * Number(SCALE)), source: "manual", createdAt: nowEpoch() });
}
async function addLot(accountId: string, instrumentId: string, unitsMajor: number, costMajor: number, tradeDate: string) {
  await db.insert(lots).values({
    id: createId(), accountId, instrumentId,
    unitsScaled: Math.round(unitsMajor * Number(SCALE)), unitCostScaled: Math.round(costMajor * Number(SCALE)),
    feesMinor: 0, tradeDate, note: null, createdAt: nowEpoch(), createdBy: "u",
  });
}

beforeEach(resetDb);

test("accountBalanceMinor sums entries up to asOf inclusive", async () => {
  await seedBase("USD");
  const a = await addAccount({ name: "Checking", cls: "asset", currency: "USD" });
  await addEntry(a, 10000, "2026-01-01");
  await addEntry(a, -2500, "2026-02-01", "transaction");
  await addEntry(a, 999, "2026-03-15", "transaction");
  expect(await accountBalanceMinor(a)).toBe(8499);
  expect(await accountBalanceMinor(a, "2026-02-01")).toBe(7500);
  expect(await accountBalanceMinor(a, "2025-12-31")).toBe(0);
});

test("netWorth sums assets minus liabilities in base currency, converting FX", async () => {
  await seedBase("USD");
  const usd = await addAccount({ name: "US Checking", cls: "asset", currency: "USD" });
  await addEntry(usd, 100000, "2026-01-01"); // $1,000.00
  const cc = await addAccount({ name: "Credit Card", cls: "liability", currency: "USD" });
  await addEntry(cc, -25000, "2026-01-01"); // -$250.00
  const myr = await addAccount({ name: "MY Savings", cls: "asset", currency: "MYR" });
  await addEntry(myr, 45000, "2026-01-01"); // RM450.00
  // 1 MYR = 0.22 USD
  await db.insert(fxRates).values({ id: createId(), currency: "MYR", date: "2026-01-01", rateScaled: 22_000_000, createdAt: nowEpoch() });

  const nw = await netWorth();
  expect(nw.baseCurrency).toBe("USD");
  // 100000 - 25000 + round(45000 * 22e6 / 1e8) = 75000 + 9900 = 84900
  expect(nw.totalBaseMinor).toBe(84900);
  const my = nw.accounts.find((x) => x.name === "MY Savings")!;
  expect(my.baseMinor).toBe(9900);
  expect(my.missingRate).toBe(false);
});

test("netWorth flags accounts with no FX rate and excludes them from the total", async () => {
  await seedBase("USD");
  const eur = await addAccount({ name: "EU Account", cls: "asset", currency: "EUR" });
  await addEntry(eur, 50000, "2026-01-01");
  const nw = await netWorth();
  expect(nw.totalBaseMinor).toBe(0);
  const e = nw.accounts.find((x) => x.name === "EU Account")!;
  expect(e.missingRate).toBe(true);
  expect(e.baseMinor).toBe(0);
});

test("netWorth tags each account with ownerIds and shared (|O|>=2)", async () => {
  await seedBase("USD");
  const personal = await addAccount({ name: "Solo", cls: "asset", currency: "USD" });
  await addEntry(personal, 10000, "2026-01-01");
  await setOwnersDirect(personal, ["u1"]);
  const joint = await addAccount({ name: "Joint", cls: "asset", currency: "USD" });
  await addEntry(joint, 20000, "2026-01-01");
  await setOwnersDirect(joint, ["u1", "u2"]);

  const nw = await netWorth();
  const solo = nw.accounts.find((a) => a.name === "Solo")!;
  const both = nw.accounts.find((a) => a.name === "Joint")!;
  expect(solo.ownerIds.sort()).toEqual(["u1"]);
  expect(solo.shared).toBe(false);
  expect(both.ownerIds.sort()).toEqual(["u1", "u2"]);
  expect(both.shared).toBe(true);
});

test("netWorth household total includes personal + shared accounts", async () => {
  await seedBase("USD");
  const solo = await addAccount({ name: "Solo", cls: "asset", currency: "USD" });
  await addEntry(solo, 10000, "2026-01-01");
  await setOwnersDirect(solo, ["u1"]);
  const joint = await addAccount({ name: "Joint", cls: "asset", currency: "USD" });
  await addEntry(joint, 20000, "2026-01-01");
  await setOwnersDirect(joint, ["u1", "u2"]);

  const nw = await netWorth({ owner: "household" });
  expect(nw.totalBaseMinor).toBe(30000);
  expect(nw.accounts.length).toBe(2);
});

test("netWorth for a member includes only their sole-owned accounts, excludes shared + others", async () => {
  await seedBase("USD");
  const mine = await addAccount({ name: "Mine", cls: "asset", currency: "USD" });
  await addEntry(mine, 10000, "2026-01-01");
  await setOwnersDirect(mine, ["u1"]);
  const joint = await addAccount({ name: "Joint", cls: "asset", currency: "USD" });
  await addEntry(joint, 20000, "2026-01-01");
  await setOwnersDirect(joint, ["u1", "u2"]);
  const theirs = await addAccount({ name: "Theirs", cls: "asset", currency: "USD" });
  await addEntry(theirs, 40000, "2026-01-01");
  await setOwnersDirect(theirs, ["u2"]);

  const nw = await netWorth({ owner: "u1" });
  expect(nw.totalBaseMinor).toBe(10000); // only "Mine"
  expect(nw.accounts.map((a) => a.name)).toEqual(["Mine"]);
});

test("netWorth still supports asOf via the options object", async () => {
  await seedBase("USD");
  const a = await addAccount({ name: "Savings", cls: "asset", currency: "USD" });
  await addEntry(a, 50000, "2026-03-01");
  await setOwnersDirect(a, ["u1"]);
  expect((await netWorth({ asOf: "2026-02-01" })).totalBaseMinor).toBe(0);
  expect((await netWorth({ asOf: "2026-03-01" })).totalBaseMinor).toBe(50000);
});

test("netWorth values a holdings account and sums it with ledger accounts", async () => {
  await seedBase("USD");
  const cash = await addAccount({ name: "Cash", cls: "asset", currency: "USD" });
  await addEntry(cash, 100000, "2026-01-01");
  const broker = await addHoldingsAccount("Broker");
  const inst = await addInstrument("USD");
  await addPrice(inst, "2026-01-01", 50);
  await addLot(broker, inst, 10, 40, "2026-01-01");

  const nw = await netWorth();
  expect(nw.totalBaseMinor).toBe(150000); // 100000 + 50000
  const b = nw.accounts.find((a) => a.name === "Broker")!;
  expect(b.baseMinor).toBe(50000);
  expect(b.balanceMinor).toBe(50000); // holdings: balanceMinor == base total
  expect(b.currency).toBe("USD");      // holdings report in base currency
  expect(b.missingRate).toBe(false);
});

test("netWorth holdings respects asOf (price added later does not affect earlier date)", async () => {
  await seedBase("USD");
  const broker = await addHoldingsAccount("Broker");
  const inst = await addInstrument("USD");
  await addPrice(inst, "2026-05-01", 50);
  await addLot(broker, inst, 10, 40, "2026-01-01");

  expect((await netWorth({ asOf: "2026-03-01" })).totalBaseMinor).toBe(0);
  expect((await netWorth({ asOf: "2026-05-01" })).totalBaseMinor).toBe(50000);
});
