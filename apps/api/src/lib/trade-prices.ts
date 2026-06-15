// apps/api/src/lib/trade-prices.ts
import { db } from "../db/client";
import { prices } from "../db/schema";
import { and, eq } from "drizzle-orm";
import { createId, nowEpoch } from "./ids";

// Record a trade's price as a price observation for (instrument, date).
// Insert-if-absent; only ever updates our own `source="trade"` rows, never a
// manual price. Callers must pass non-currency instruments with a real price.
export async function seedTradePrice(
  instrumentId: string,
  date: string,
  priceScaled: number,
): Promise<void> {
  const [existing] = await db
    .select()
    .from(prices)
    .where(and(eq(prices.instrumentId, instrumentId), eq(prices.date, date)));
  if (!existing) {
    await db.insert(prices).values({
      id: createId(), instrumentId, date, priceScaled, source: "trade", createdAt: nowEpoch(),
    });
  } else if (existing.source === "trade") {
    await db.update(prices).set({ priceScaled }).where(eq(prices.id, existing.id));
  }
}
