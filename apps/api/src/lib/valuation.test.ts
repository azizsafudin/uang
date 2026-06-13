import { expect, test, beforeEach } from "bun:test";
import { resetDb } from "./test-helpers";
import { db } from "../db/client";
import { settings, accounts, entries, fxRates } from "../db/schema";
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
