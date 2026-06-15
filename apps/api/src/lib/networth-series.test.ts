import { expect, test, beforeEach } from "bun:test";
import { resetDb } from "./test-helpers";
import { netWorthSeries } from "./networth-series";
import { db } from "../db/client";
import { accounts, instruments, transactions, accountOwners, settings } from "../db/schema";
import { SCALE } from "@uang/shared";
import { createId, nowEpoch } from "./ids";

beforeEach(resetDb);

const S = Number(SCALE);

// Find-or-create a currency instrument for `currency`, returning its id.
async function ensureCurrency(currency: string): Promise<string> {
  const id = createId();
  await db.insert(instruments).values({
    id, symbol: currency, isin: null, name: currency, kind: "currency", currency, createdAt: nowEpoch(),
  });
  return id;
}

// Insert a cash transaction of `amountMinor` (account-currency minor units) on `date`.
async function seedTx(accountId: string, instrumentId: string, amountMinor: number, date: string, userId = "seed") {
  const amountMajor = amountMinor / 100;
  await db.insert(transactions).values({
    id: createId(), accountId, instrumentId, date,
    unitsDelta: Math.round(amountMajor * S), unitPriceScaled: S, feesMinor: 0, notes: null,
    createdAt: nowEpoch(), createdBy: userId,
  });
}

// resetDb wipes settings; netWorth needs a base-currency row. Seed it directly.
async function seedSettings(baseCurrency = "USD") {
  await db.insert(settings).values({
    id: 1,
    householdName: "Test",
    baseCurrency,
    createdAt: nowEpoch(),
  });
}

async function seedAccount(opts: {
  cls: "asset" | "liability";
  currency: string;
  amountMinor: number;
  date: string;
  userId?: string;
}): Promise<{ id: string; instrumentId: string }> {
  const id = createId();
  await db.insert(accounts).values({
    id,
    name: "Acct",
    class: opts.cls,
    subtype: "bank",
    currency: opts.currency,
    isArchived: 0,
    sortOrder: 0,
    createdAt: nowEpoch(),
    createdBy: opts.userId ?? "seed",
  });
  const instrumentId = await ensureCurrency(opts.currency);
  await seedTx(id, instrumentId, opts.amountMinor, opts.date, opts.userId ?? "seed");
  return { id, instrumentId };
}

async function ownAccount(accountId: string, userIds: string[]) {
  for (const userId of userIds) {
    await db.insert(accountOwners).values({ accountId, userId });
  }
}

test("weekly points are ascending, anchored on `to`, with as-of values", async () => {
  await seedSettings("USD");
  // Opening $1,000 on 2026-01-01; +$500 on 2026-02-01 (balance 1500 from Feb 1).
  const { id: acct, instrumentId } = await seedAccount({ cls: "asset", currency: "USD", amountMinor: 100000, date: "2026-01-01" });
  await seedTx(acct, instrumentId, 50000, "2026-02-01");

  const series = await netWorthSeries({ from: "2026-01-01", to: "2026-02-05" });

  // Anchored on 2026-02-05, stepping back 7 days, reversed ascending:
  // 01-01, 01-08, 01-15, 01-22, 01-29, 02-05
  expect(series.baseCurrency).toBe("USD");
  expect(series.points.map((p) => p.date)).toEqual([
    "2026-01-01", "2026-01-08", "2026-01-15", "2026-01-22", "2026-01-29", "2026-02-05",
  ]);
  // All weeks before Feb 1 see only the opening (100000); 02-05 sees both (150000).
  expect(series.points[0]).toEqual({ date: "2026-01-01", totalBaseMinor: 100000, netDepositsBaseMinor: 100000 });
  expect(series.points.at(-1)).toEqual({ date: "2026-02-05", totalBaseMinor: 150000, netDepositsBaseMinor: 150000 });
});

test("omitting `to` anchors the last point on today", async () => {
  await seedSettings("USD");
  await seedAccount({ cls: "asset", currency: "USD", amountMinor: 100000, date: "2020-01-01" });

  const series = await netWorthSeries({ from: "2020-01-01" });

  const today = new Date().toISOString().slice(0, 10);
  expect(series.points.at(-1)!.date).toBe(today);
  expect(series.points.at(-1)!.totalBaseMinor).toBe(100000);
});

test("owner filter restricts to that member's sole-owned accounts", async () => {
  await seedSettings("USD");
  const { id: mine } = await seedAccount({ cls: "asset", currency: "USD", amountMinor: 10000, date: "2026-01-01", userId: "u1" });
  await ownAccount(mine, ["u1"]);
  const { id: joint } = await seedAccount({ cls: "asset", currency: "USD", amountMinor: 20000, date: "2026-01-01", userId: "u1" });
  await ownAccount(joint, ["u1", "u2"]);

  const series = await netWorthSeries({ from: "2026-01-01", to: "2026-01-01", owner: "u1" });

  expect(series.points).toEqual([{ date: "2026-01-01", totalBaseMinor: 10000, netDepositsBaseMinor: 10000 }]);
});

test("from after to yields no points but still reports base currency", async () => {
  await seedSettings("EUR");

  const series = await netWorthSeries({ from: "2026-03-01", to: "2026-01-01" });

  expect(series.points).toEqual([]);
  expect(series.baseCurrency).toBe("EUR");
});

test("net deposits accumulate from standalone cash flows", async () => {
  await seedSettings("USD");
  const acc = createId();
  await db.insert(accounts).values({
    id: acc, name: "Brokerage", class: "asset", subtype: "investment", currency: "USD",
    isArchived: 0, sortOrder: 0, createdAt: nowEpoch(), createdBy: "seed",
  });
  const usd = await ensureCurrency("USD");
  await db.insert(transactions).values({
    id: createId(), accountId: acc, instrumentId: usd, date: "2026-01-01",
    unitsDelta: 5000 * S, unitPriceScaled: S, feesMinor: 0, notes: null, createdAt: nowEpoch(), createdBy: "u",
  });
  await db.insert(transactions).values({
    id: createId(), accountId: acc, instrumentId: usd, date: "2026-01-15",
    unitsDelta: -1000 * S, unitPriceScaled: S, feesMinor: 0, notes: null, createdAt: nowEpoch(), createdBy: "u",
  });

  const series = await netWorthSeries({ from: "2026-01-01", to: "2026-01-15" });
  const byDate = new Map(series.points.map((p) => [p.date, p.netDepositsBaseMinor]));
  expect(byDate.get("2026-01-01")).toBe(500000);  // +$5000
  expect(byDate.get("2026-01-15")).toBe(400000);  // +$5000 − $1000
});

test("a buy's linked cash leg is excluded from net deposits", async () => {
  await seedSettings("USD");
  const acc = createId();
  await db.insert(accounts).values({
    id: acc, name: "Brokerage", class: "asset", subtype: "investment", currency: "USD",
    isArchived: 0, sortOrder: 0, createdAt: nowEpoch(), createdBy: "seed",
  });
  const usd = await ensureCurrency("USD");
  const stock = createId();
  await db.insert(instruments).values({
    id: stock, symbol: "AAPL", isin: null, name: "Apple", kind: "stock", currency: "USD", createdAt: nowEpoch(),
  });
  const buyId = createId();
  await db.insert(transactions).values({
    id: buyId, accountId: acc, instrumentId: stock, date: "2026-01-01",
    unitsDelta: 10 * S, unitPriceScaled: 100 * S, feesMinor: 0, notes: null, createdAt: nowEpoch(), createdBy: "u",
  });
  await db.insert(transactions).values({
    id: createId(), accountId: acc, instrumentId: usd, date: "2026-01-01",
    unitsDelta: -1000 * S, unitPriceScaled: S, feesMinor: 0, notes: null,
    linkedTransactionId: buyId, createdAt: nowEpoch(), createdBy: "u",
  });

  const series = await netWorthSeries({ from: "2026-01-01", to: "2026-01-01" });
  expect(series.points[0].netDepositsBaseMinor).toBe(0); // cash leg excluded
});
