import { db } from "../db/client";
import { fxRates } from "../db/schema";
import { and, eq, lte, desc } from "drizzle-orm";

// Latest fx_rate.rate_scaled for `currency` with date <= asOf (or latest overall
// if asOf is absent). null if no rate exists. rate_scaled = base-major per 1 from-major * SCALE.
export async function latestFxRateScaled(currency: string, asOf?: string): Promise<number | null> {
  const where = asOf
    ? and(eq(fxRates.currency, currency), lte(fxRates.date, asOf))
    : eq(fxRates.currency, currency);
  const rows = await db
    .select({ rateScaled: fxRates.rateScaled })
    .from(fxRates)
    .where(where)
    .orderBy(desc(fxRates.date))
    .limit(1);
  return rows[0]?.rateScaled ?? null;
}
