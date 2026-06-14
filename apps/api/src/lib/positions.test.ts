import { expect, test, beforeEach } from "bun:test";
import { db } from "../db/client";
import { accounts, instruments, prices, transactions } from "../db/schema";
import { SCALE } from "@uang/shared";
import { createId, nowEpoch } from "./ids";
import { resetDb } from "./test-helpers";
import { accountPositions, instrumentPriceScaled } from "./positions";

beforeEach(resetDb);

const S = Number(SCALE);

async function seedAccount(currency = "USD"): Promise<string> {
  const id = createId();
  await db.insert(accounts).values({
    id, name: "Acct", class: "asset", subtype: "investment", currency,
    isArchived: 0, sortOrder: 0, createdAt: nowEpoch(), createdBy: "u",
    growthRateBps: 0, accessibleFromAge: 0, earlyWithdrawal: "none",
    earlyHaircutBps: 0, illiquid: 0, liquidationAge: null,
  });
  return id;
}

async function addInstrument(opts: { kind?: string; currency?: string; symbol?: string }): Promise<string> {
  const id = createId();
  await db.insert(instruments).values({
    id, symbol: opts.symbol ?? "AAPL", isin: null, name: "Test Instr",
    kind: (opts.kind ?? "stock") as "currency" | "stock" | "etf" | "fund" | "crypto" | "other",
    currency: opts.currency ?? "USD", createdAt: nowEpoch(),
  });
  return id;
}

async function addTx(accountId: string, instrumentId: string, unitsMajor: number, priceMajor: number | null, date = "2026-01-01") {
  await db.insert(transactions).values({
    id: createId(), accountId, instrumentId, date,
    unitsDelta: Math.round(unitsMajor * S),
    unitPriceScaled: priceMajor === null ? null : Math.round(priceMajor * S),
    feesMinor: 0, notes: null, createdAt: nowEpoch(), createdBy: "u",
  });
}

async function addPrice(instrumentId: string, date: string, priceMajor: number) {
  await db.insert(prices).values({
    id: createId(), instrumentId, date, priceScaled: Math.round(priceMajor * S),
    source: "manual", createdAt: nowEpoch(),
  });
}

test("currency position: units sum, price 1.0, no gain", async () => {
  const acc = await seedAccount("SGD");
  const sgd = await addInstrument({ kind: "currency", currency: "SGD", symbol: "SGD" });
  await addTx(acc, sgd, 500, 1, "2026-01-01");
  await addTx(acc, sgd, -120, 1, "2026-02-01");

  const pos = await accountPositions(acc);
  expect(pos.length).toBe(1);
  expect(pos[0].units).toBe(380 * S);
  expect(pos[0].currentPriceScaled).toBe(S);
  expect(pos[0].avgCostScaled).toBe(S);
  expect(pos[0].marketValueMinor).toBe(38000); // 380.00 SGD
  expect(pos[0].unrealizedGainMinor).toBe(0);
  expect(pos[0].missingPrice).toBe(false);
});

test("stock position: weighted avg cost, market value, unrealized gain", async () => {
  const acc = await seedAccount("USD");
  const aapl = await addInstrument({ kind: "stock", currency: "USD" });
  await addTx(acc, aapl, 10, 100, "2026-01-01"); // 10 @ 100
  await addTx(acc, aapl, 10, 120, "2026-02-01"); // 10 @ 120 → avg 110
  await addPrice(aapl, "2026-03-01", 130);

  const pos = await accountPositions(acc);
  expect(pos.length).toBe(1);
  expect(pos[0].units).toBe(20 * S);
  expect(pos[0].avgCostScaled).toBe(110 * S);
  expect(pos[0].currentPriceScaled).toBe(130 * S);
  expect(pos[0].marketValueMinor).toBe(260000); // 20 × 130 = 2600.00
  expect(pos[0].unrealizedGainMinor).toBe(40000); // (130-110) × 20 = 400.00
});

test("stock with no price is flagged missingPrice and zero-valued", async () => {
  const acc = await seedAccount("USD");
  const aapl = await addInstrument({ kind: "stock", currency: "USD" });
  await addTx(acc, aapl, 5, 100, "2026-01-01");

  const pos = await accountPositions(acc);
  expect(pos[0].missingPrice).toBe(true);
  expect(pos[0].marketValueMinor).toBe(0);
});

test("fully-disposed instrument (net units 0) is omitted", async () => {
  const acc = await seedAccount("USD");
  const aapl = await addInstrument({ kind: "stock", currency: "USD" });
  await addTx(acc, aapl, 5, 100, "2026-01-01");
  await addTx(acc, aapl, -5, 110, "2026-02-01");

  const pos = await accountPositions(acc);
  expect(pos.length).toBe(0);
});

test("asOf excludes later transactions and uses carry-forward price", async () => {
  const acc = await seedAccount("USD");
  const aapl = await addInstrument({ kind: "stock", currency: "USD" });
  await addTx(acc, aapl, 10, 100, "2026-01-01");
  await addTx(acc, aapl, 10, 100, "2026-03-01");
  await addPrice(aapl, "2026-01-15", 105);

  const pos = await accountPositions(acc, "2026-02-01");
  expect(pos[0].units).toBe(10 * S);
  expect(pos[0].currentPriceScaled).toBe(105 * S);
});

test("instrumentPriceScaled carries forward the latest price <= asOf", async () => {
  const aapl = await addInstrument({ kind: "stock", currency: "USD" });
  await addPrice(aapl, "2026-01-01", 100);
  await addPrice(aapl, "2026-03-01", 120);
  expect(await instrumentPriceScaled(aapl, "2026-02-15")).toBe(100 * S);
  expect(await instrumentPriceScaled(aapl, "2025-12-31")).toBe(null);
  expect(await instrumentPriceScaled(aapl)).toBe(120 * S);
});
