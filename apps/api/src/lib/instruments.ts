import { db } from "../db/client";
import { instruments } from "../db/schema";
import { and, eq } from "drizzle-orm";
import { currencyName } from "@uang/shared";
import { createId, nowEpoch } from "./ids";

// Find-or-create the currency instrument for `symbol`. Idempotent; returns its id.
export async function ensureCurrencyInstrument(symbol: string): Promise<string> {
  const sym = symbol.toUpperCase();
  const existing = await db
    .select({ id: instruments.id })
    .from(instruments)
    .where(and(eq(instruments.kind, "currency"), eq(instruments.symbol, sym)));
  if (existing[0]) return existing[0].id;

  const id = createId();
  await db.insert(instruments).values({
    id, symbol: sym, isin: null, name: currencyName(sym),
    kind: "currency", currency: sym, createdAt: nowEpoch(),
  });
  return id;
}
