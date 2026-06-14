import { expect, test, beforeEach } from "bun:test";
import { resetDb } from "./test-helpers";
import { netWorthSeries } from "./networth-series";
import { db } from "../db/client";
import { accounts, entries, accountOwners, settings } from "../db/schema";
import { createId, nowEpoch } from "./ids";

beforeEach(resetDb);

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
}) {
  const id = createId();
  await db.insert(accounts).values({
    id,
    name: "Acct",
    class: opts.cls,
    subtype: "bank",
    currency: opts.currency,
    valuationMode: "ledger",
    isArchived: 0,
    sortOrder: 0,
    createdAt: nowEpoch(),
    createdBy: opts.userId ?? "seed",
  });
  await db.insert(entries).values({
    id: createId(),
    accountId: id,
    date: opts.date,
    amountMinor: opts.amountMinor,
    kind: "opening",
    createdAt: nowEpoch(),
    createdBy: opts.userId ?? "seed",
  });
  return id;
}

async function ownAccount(accountId: string, userIds: string[]) {
  for (const userId of userIds) {
    await db.insert(accountOwners).values({ accountId, userId });
  }
}

test("weekly points are ascending, anchored on `to`, with as-of values", async () => {
  await seedSettings("USD");
  // Opening $1,000 on 2026-01-01; +$500 on 2026-02-01 (balance 1500 from Feb 1).
  const acct = await seedAccount({ cls: "asset", currency: "USD", amountMinor: 100000, date: "2026-01-01" });
  await db.insert(entries).values({
    id: createId(), accountId: acct, date: "2026-02-01", amountMinor: 50000,
    kind: "adjust", createdAt: nowEpoch(), createdBy: "seed",
  });

  const series = await netWorthSeries({ from: "2026-01-01", to: "2026-02-05" });

  // Anchored on 2026-02-05, stepping back 7 days, reversed ascending:
  // 01-01, 01-08, 01-15, 01-22, 01-29, 02-05
  expect(series.baseCurrency).toBe("USD");
  expect(series.points.map((p) => p.date)).toEqual([
    "2026-01-01", "2026-01-08", "2026-01-15", "2026-01-22", "2026-01-29", "2026-02-05",
  ]);
  // All weeks before Feb 1 see only the opening (100000); 02-05 sees both (150000).
  expect(series.points[0]).toEqual({ date: "2026-01-01", totalBaseMinor: 100000 });
  expect(series.points.at(-1)).toEqual({ date: "2026-02-05", totalBaseMinor: 150000 });
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
  const mine = await seedAccount({ cls: "asset", currency: "USD", amountMinor: 10000, date: "2026-01-01", userId: "u1" });
  await ownAccount(mine, ["u1"]);
  const joint = await seedAccount({ cls: "asset", currency: "USD", amountMinor: 20000, date: "2026-01-01", userId: "u1" });
  await ownAccount(joint, ["u1", "u2"]);

  const series = await netWorthSeries({ from: "2026-01-01", to: "2026-01-01", owner: "u1" });

  expect(series.points).toEqual([{ date: "2026-01-01", totalBaseMinor: 10000 }]);
});

test("from after to yields no points but still reports base currency", async () => {
  await seedSettings("EUR");

  const series = await netWorthSeries({ from: "2026-03-01", to: "2026-01-01" });

  expect(series.points).toEqual([]);
  expect(series.baseCurrency).toBe("EUR");
});
