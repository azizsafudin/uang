import { expect, test, beforeEach } from "bun:test";
import { resetDb } from "./test-helpers";
import { db } from "../db/client";
import { instruments, prices, accounts, lots, fxRates } from "../db/schema";
import { createId, nowEpoch } from "./ids";
import { instrumentPriceScaled, lotValuation, holdingsAccountValuation } from "./holdings";

const SCALE = 100_000_000; // 1e8

beforeEach(resetDb);

async function addInstrument(p: { currency: string }) {
  const id = createId();
  await db.insert(instruments).values({
    id, symbol: "X", isin: null, name: "X Corp", kind: "stock", currency: p.currency, createdAt: nowEpoch(),
  });
  return id;
}
async function addPrice(instrumentId: string, date: string, priceMajor: number) {
  await db.insert(prices).values({
    id: createId(), instrumentId, date, priceScaled: Math.round(priceMajor * SCALE), source: "manual", createdAt: nowEpoch(),
  });
}
async function addHoldingsAccount(currency = "USD") {
  const id = createId();
  await db.insert(accounts).values({
    id, name: "Broker", class: "asset", subtype: "investment", currency,
    valuationMode: "holdings", isArchived: 0, sortOrder: 0, createdAt: nowEpoch(), createdBy: "u1",
  });
  return id;
}
async function addLot(p: { accountId: string; instrumentId: string; unitsMajor: number; unitCostMajor: number; feesMinor?: number; tradeDate: string }) {
  await db.insert(lots).values({
    id: createId(), accountId: p.accountId, instrumentId: p.instrumentId,
    unitsScaled: Math.round(p.unitsMajor * SCALE), unitCostScaled: Math.round(p.unitCostMajor * SCALE),
    feesMinor: p.feesMinor ?? 0, tradeDate: p.tradeDate, note: null, createdAt: nowEpoch(), createdBy: "u1",
  });
}
async function addFx(currency: string, date: string, rateMajor: number) {
  await db.insert(fxRates).values({ id: createId(), currency, date, rateScaled: Math.round(rateMajor * SCALE), createdAt: nowEpoch() });
}

test("instrumentPriceScaled carries forward the latest price <= asOf", async () => {
  const i = await addInstrument({ currency: "USD" });
  await addPrice(i, "2026-01-01", 100);
  await addPrice(i, "2026-03-01", 120);
  expect(await instrumentPriceScaled(i, "2026-02-15")).toBe(100 * SCALE);
  expect(await instrumentPriceScaled(i, "2026-03-01")).toBe(120 * SCALE);
  expect(await instrumentPriceScaled(i, "2025-12-31")).toBe(null);
  expect(await instrumentPriceScaled(i)).toBe(120 * SCALE); // no asOf -> latest
});

test("lotValuation: USD instrument, fractional units, fees", () => {
  const v = lotValuation(
    { unitsScaled: 10 * SCALE, unitCostScaled: 100 * SCALE, feesMinor: 500 },
    123.45 * SCALE,
    2,
  );
  expect(v.mvMinor).toBe(123450);
  expect(v.costMinor).toBe(100500);
  expect(v.gainMinor).toBe(22950);
});

test("lotValuation: JPY instrument (0 decimals), gain and loss", () => {
  const gain = lotValuation(
    { unitsScaled: 5 * SCALE, unitCostScaled: 1500 * SCALE, feesMinor: 0 },
    2000 * SCALE,
    0,
  );
  expect(gain.mvMinor).toBe(10000);
  expect(gain.costMinor).toBe(7500);
  expect(gain.gainMinor).toBe(2500);
  const loss = lotValuation(
    { unitsScaled: 5 * SCALE, unitCostScaled: 1500 * SCALE, feesMinor: 0 },
    1000 * SCALE,
    0,
  );
  expect(loss.gainMinor).toBe(-2500);
});

test("lotValuation: 1.5 units @ 10.00 USD = 15.00", () => {
  const v = lotValuation(
    { unitsScaled: 1.5 * SCALE, unitCostScaled: 10 * SCALE, feesMinor: 0 },
    10 * SCALE,
    2,
  );
  expect(v.mvMinor).toBe(1500);
  expect(v.costMinor).toBe(1500);
  expect(v.gainMinor).toBe(0);
});

test("holdingsAccountValuation: single USD lot, base USD", async () => {
  const acc = await addHoldingsAccount("USD");
  const i = await addInstrument({ currency: "USD" });
  await addPrice(i, "2026-01-01", 123.45);
  await addLot({ accountId: acc, instrumentId: i, unitsMajor: 10, unitCostMajor: 100, feesMinor: 500, tradeDate: "2026-01-01" });

  const v = await holdingsAccountValuation(acc, undefined, "USD");
  expect(v.baseMinor).toBe(123450);
  expect(v.gainBaseMinor).toBe(22950);
  expect(v.missing).toBe(false);
  expect(v.lots.length).toBe(1);
  expect(v.lots[0].mvBaseMinor).toBe(123450);
});

test("holdingsAccountValuation: JPY instrument converted to USD base via FX", async () => {
  const acc = await addHoldingsAccount("USD");
  const i = await addInstrument({ currency: "JPY" });
  await addPrice(i, "2026-01-01", 2000);
  await addLot({ accountId: acc, instrumentId: i, unitsMajor: 5, unitCostMajor: 1500, tradeDate: "2026-01-01" });
  await addFx("JPY", "2026-01-01", 0.0067);

  const v = await holdingsAccountValuation(acc, undefined, "USD");
  expect(v.baseMinor).toBe(6700);     // ¥10000 -> $67.00
  expect(v.gainBaseMinor).toBe(1675); // ¥2500 -> $16.75
  expect(v.missing).toBe(false);
});

test("holdingsAccountValuation: missing price flags + excludes the lot", async () => {
  const acc = await addHoldingsAccount("USD");
  const i = await addInstrument({ currency: "USD" });
  await addLot({ accountId: acc, instrumentId: i, unitsMajor: 10, unitCostMajor: 100, tradeDate: "2026-01-01" });

  const v = await holdingsAccountValuation(acc, undefined, "USD");
  expect(v.baseMinor).toBe(0);
  expect(v.missing).toBe(true);
  expect(v.lots[0].missingPrice).toBe(true);
});

test("holdingsAccountValuation: a lot with trade_date after asOf is excluded", async () => {
  const acc = await addHoldingsAccount("USD");
  const i = await addInstrument({ currency: "USD" });
  await addPrice(i, "2026-01-01", 100);
  await addLot({ accountId: acc, instrumentId: i, unitsMajor: 10, unitCostMajor: 100, tradeDate: "2026-06-01" });

  const before = await holdingsAccountValuation(acc, "2026-03-01", "USD");
  expect(before.lots.length).toBe(0);
  expect(before.baseMinor).toBe(0);
  const after = await holdingsAccountValuation(acc, "2026-06-01", "USD");
  expect(after.lots.length).toBe(1);
  expect(after.baseMinor).toBe(100000);
});

test("holdingsAccountValuation: missing FX rate (non-base instrument) flags + excludes", async () => {
  const acc = await addHoldingsAccount("USD");
  const i = await addInstrument({ currency: "EUR" });
  await addPrice(i, "2026-01-01", 50);
  await addLot({ accountId: acc, instrumentId: i, unitsMajor: 2, unitCostMajor: 40, tradeDate: "2026-01-01" });

  const v = await holdingsAccountValuation(acc, undefined, "USD");
  expect(v.baseMinor).toBe(0);
  expect(v.missing).toBe(true);
  expect(v.lots[0].missingPrice).toBe(true);
});
