import { expect, test, beforeEach } from "bun:test";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { networthSeriesRoutes } from "./networth-series";
import { transactionsRoutes } from "./transactions";
import { pricesRoutes } from "./prices";
import { db } from "../db/client";
import { accounts, instruments, transactions } from "../db/schema";
import { SCALE } from "@uang/shared";
import { createId, nowEpoch } from "../lib/ids";

beforeEach(resetDb);

const app = makeApp(networthSeriesRoutes, transactionsRoutes, pricesRoutes);

const S = Number(SCALE);

async function seedAccount(amountMinor: number, date: string) {
  const id = createId();
  await db.insert(accounts).values({
    id, name: "Checking", class: "asset", subtype: "bank", currency: "USD",
    isArchived: 0, sortOrder: 0,
    createdAt: nowEpoch(), createdBy: "seed",
  });
  const instrId = createId();
  await db.insert(instruments).values({
    id: instrId, symbol: "USD", isin: null, name: "USD", kind: "currency", currency: "USD", createdAt: nowEpoch(),
  });
  await db.insert(transactions).values({
    id: createId(), accountId: id, instrumentId: instrId, date,
    unitsDelta: Math.round((amountMinor / 100) * S), unitPriceScaled: S, feesMinor: 0, notes: null,
    createdAt: nowEpoch(), createdBy: "seed",
  });
  return id;
}

test("GET /networth/series returns ascending weekly points", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  await seedAccount(100000, "2026-01-01");

  const res = await app.handle(
    new Request("http://localhost/networth/series?from=2026-01-01&to=2026-01-15", { headers: { cookie } }),
  );
  expect(res.status).toBe(200);

  const series = await res.json();
  expect(series.baseCurrency).toBe("USD");
  expect(series.points.map((p: any) => p.date)).toEqual(["2026-01-01", "2026-01-08", "2026-01-15"]);
  expect(series.points.every((p: any) => p.totalBaseMinor === 100000)).toBe(true);
});

test("GET /networth/series without `from` returns all-time from the earliest tx", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  await seedAccount(100000, "2026-01-01");

  const res = await app.handle(
    new Request("http://localhost/networth/series?to=2026-01-15", { headers: { cookie } }),
  );
  expect(res.status).toBe(200);

  const series = await res.json();
  // Range starts at the earliest transaction date, not a client-supplied `from`.
  expect(series.points[0].date).toBe("2026-01-01");
  expect(series.points.map((p: any) => p.date)).toEqual(["2026-01-01", "2026-01-08", "2026-01-15"]);
});

test("GET /networth/series returns 401 without auth", async () => {
  const res = await app.handle(new Request("http://localhost/networth/series?from=2026-01-01"));
  expect(res.status).toBe(401);
});

async function seedStockAccount(): Promise<{ acc: string; stock: string }> {
  const acc = createId();
  await db.insert(accounts).values({
    id: acc, name: "Brokerage", class: "asset", subtype: "investment", currency: "USD",
    isArchived: 0, sortOrder: 0, createdAt: nowEpoch(), createdBy: "seed",
  });
  const stock = createId();
  await db.insert(instruments).values({
    id: stock, symbol: "AAPL", isin: null, name: "Apple", kind: "stock", currency: "USD", createdAt: nowEpoch(),
  });
  return { acc, stock };
}

test("backdated buy appreciates as a newer price is set (reported bug)", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const { acc, stock } = await seedStockAccount();

  // Backdated buy: 10 AAPL @ $100 on 2026-01-01 -> seeds price $100@2026-01-01.
  await app.handle(new Request(`http://localhost/accounts/${acc}/transactions`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ instrumentId: stock, date: "2026-01-01", unitsDelta: 10 * S, unitPriceScaled: 100 * S }),
  }));
  // Newer price $120 on 2026-01-15.
  await app.handle(new Request(`http://localhost/instruments/${stock}/prices`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ date: "2026-01-15", priceScaled: 120 * S }),
  }));

  const series = await (await app.handle(new Request(
    `http://localhost/networth/series?from=2026-01-01&to=2026-01-15`, { headers: { cookie } },
  ))).json();

  const byDate = new Map(series.points.map((p: any) => [p.date, p.totalBaseMinor]));
  expect(byDate.get("2026-01-01")).toBe(100000); // 10 × $100 = $1000.00
  expect(byDate.get("2026-01-15")).toBe(120000); // 10 × $120 = $1200.00
});
