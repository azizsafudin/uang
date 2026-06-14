import { db } from "../db/client";
import { prices } from "../db/schema";
import { and, eq, lte, desc } from "drizzle-orm";
import { SCALE, roundDiv, toBig, fromBig } from "@uang/shared";

// Latest manual price for an instrument with date <= asOf (carry-forward),
// or latest overall if asOf absent. null if none. Returns price_scaled (price-per-unit * 1e8).
export async function instrumentPriceScaled(instrumentId: string, asOf?: string): Promise<number | null> {
  const where = asOf
    ? and(eq(prices.instrumentId, instrumentId), lte(prices.date, asOf))
    : eq(prices.instrumentId, instrumentId);
  const rows = await db
    .select({ priceScaled: prices.priceScaled })
    .from(prices)
    .where(where)
    .orderBy(desc(prices.date))
    .limit(1);
  return rows[0]?.priceScaled ?? null;
}

export type LotInput = { unitsScaled: number; unitCostScaled: number; feesMinor: number };
export type LotValue = { mvMinor: number; costMinor: number; gainMinor: number };

// Market value, cost, and unrealized gain for a lot, all in the INSTRUMENT's currency
// minor units. instrDec = currencyDecimals(instrument.currency).
//   mv   = round( units_scaled * price_scaled * 10^instrDec / (SCALE * SCALE) )
//   cost = round( units_scaled * unit_cost_scaled * 10^instrDec / (SCALE * SCALE) ) + fees_minor
export function lotValuation(lot: LotInput, priceScaled: number, instrDec: number): LotValue {
  const units = toBig(lot.unitsScaled);
  const scale2 = SCALE * SCALE;
  const tenDec = 10n ** BigInt(instrDec);
  const mvBig = roundDiv(units * toBig(priceScaled) * tenDec, scale2);
  const costBig = roundDiv(units * toBig(lot.unitCostScaled) * tenDec, scale2) + toBig(lot.feesMinor);
  const mvMinor = fromBig(mvBig);
  const costMinor = fromBig(costBig);
  return { mvMinor, costMinor, gainMinor: mvMinor - costMinor };
}
