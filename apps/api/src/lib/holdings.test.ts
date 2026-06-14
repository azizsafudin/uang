import { expect, test, beforeEach } from "bun:test";
import { resetDb } from "./test-helpers";
import { db } from "../db/client";
import { instruments, prices } from "../db/schema";
import { createId, nowEpoch } from "./ids";
import { instrumentPriceScaled, lotValuation } from "./holdings";

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
