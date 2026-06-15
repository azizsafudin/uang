// apps/api/src/lib/trade-prices.test.ts
import { expect, test, beforeEach } from "bun:test";
import { resetDb } from "./test-helpers";
import { db } from "../db/client";
import { instruments, prices } from "../db/schema";
import { createId, nowEpoch } from "./ids";
import { seedTradePrice } from "./trade-prices";
import { eq } from "drizzle-orm";

beforeEach(resetDb);

async function instr(): Promise<string> {
  const id = createId();
  await db.insert(instruments).values({
    id, symbol: "AAPL", isin: null, name: "Apple", kind: "stock", currency: "USD", createdAt: nowEpoch(),
  });
  return id;
}

test("inserts a trade-sourced price when none exists for the date", async () => {
  const id = await instr();
  await seedTradePrice(id, "2026-01-01", 50_00000000);
  const rows = await db.select().from(prices).where(eq(prices.instrumentId, id));
  expect(rows.length).toBe(1);
  expect(rows[0].source).toBe("trade");
  expect(rows[0].priceScaled).toBe(50_00000000);
});

test("does not clobber an existing manual price for the same date", async () => {
  const id = await instr();
  await db.insert(prices).values({
    id: createId(), instrumentId: id, date: "2026-01-01", priceScaled: 99_00000000, source: "manual", createdAt: nowEpoch(),
  });
  await seedTradePrice(id, "2026-01-01", 50_00000000);
  const [row] = await db.select().from(prices).where(eq(prices.instrumentId, id));
  expect(row.source).toBe("manual");
  expect(row.priceScaled).toBe(99_00000000);
});

test("updates an existing trade-sourced price for the same date", async () => {
  const id = await instr();
  await seedTradePrice(id, "2026-01-01", 50_00000000);
  await seedTradePrice(id, "2026-01-01", 55_00000000);
  const rows = await db.select().from(prices).where(eq(prices.instrumentId, id));
  expect(rows.length).toBe(1);
  expect(rows[0].priceScaled).toBe(55_00000000);
});
