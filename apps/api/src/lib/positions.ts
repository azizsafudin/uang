import { db } from "../db/client";
import { prices, transactions, instruments } from "../db/schema";
import { and, eq, lte, desc } from "drizzle-orm";
import { SCALE, roundDiv, toBig, fromBig, currencyDecimals } from "@uang/shared";

// Latest manual price for an instrument with date <= asOf (carry-forward), or latest
// overall if asOf absent. null if none. Returns price_scaled (price-per-unit × 1e8).
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

export type Position = {
  instrument: { id: string; symbol: string | null; name: string; kind: string; currency: string };
  instrumentCurrency: string;
  units: number;               // net units held, ×1e8
  avgCostScaled: number;       // weighted average acquisition price, ×1e8
  currentPriceScaled: number | null;
  marketValueMinor: number;    // in the instrument's currency minor units
  unrealizedGainMinor: number; // in the instrument's currency minor units (0 for currency kind)
  missingPrice: boolean;       // true if no price (non-currency) -> excluded from totals
};

// mv = round( units_scaled * price_scaled * 10^dec / (SCALE * SCALE) ), instrument-currency minor.
function valueMinor(unitsScaled: bigint, priceScaled: bigint, dec: number): bigint {
  return roundDiv(unitsScaled * priceScaled * 10n ** BigInt(dec), SCALE * SCALE);
}

// Net positions for an account (transactions with date <= asOf). Currency instruments are
// priced at 1.0 (SCALE) and never carry an unrealized gain.
export async function accountPositions(accountId: string, asOf?: string): Promise<Position[]> {
  const where = asOf
    ? and(eq(transactions.accountId, accountId), lte(transactions.date, asOf))
    : eq(transactions.accountId, accountId);
  const rows = await db
    .select()
    .from(transactions)
    .innerJoin(instruments, eq(transactions.instrumentId, instruments.id))
    .where(where);

  type Agg = {
    instrument: (typeof rows)[number]["instruments"];
    units: bigint;     // Σ units_delta
    acqUnits: bigint;  // Σ units_delta where > 0
    acqCost: bigint;   // Σ units_delta × unit_price (scale²) where > 0
  };
  const byInstr = new Map<string, Agg>();
  for (const row of rows) {
    const tx = row.transactions;
    const instr = row.instruments;
    let agg = byInstr.get(instr.id);
    if (!agg) { agg = { instrument: instr, units: 0n, acqUnits: 0n, acqCost: 0n }; byInstr.set(instr.id, agg); }
    const d = toBig(tx.unitsDelta);
    agg.units += d;
    if (d > 0n) {
      const isCurrency = instr.kind === "currency";
      const price = tx.unitPriceScaled ?? (isCurrency ? Number(SCALE) : 0);
      agg.acqUnits += d;
      agg.acqCost += d * toBig(price);
    }
  }

  const out: Position[] = [];
  for (const agg of byInstr.values()) {
    if (agg.units === 0n) continue;
    const instr = agg.instrument;
    const isCurrency = instr.kind === "currency";
    const dec = currencyDecimals(instr.currency);

    const avgCostScaled = isCurrency
      ? Number(SCALE)
      : agg.acqUnits > 0n ? fromBig(roundDiv(agg.acqCost, agg.acqUnits)) : 0;

    const currentPriceScaled = isCurrency
      ? Number(SCALE)
      : await instrumentPriceScaled(instr.id, asOf);

    let marketValueMinor = 0;
    let unrealizedGainMinor = 0;
    let missingPrice = false;

    if (currentPriceScaled === null) {
      missingPrice = true;
    } else {
      marketValueMinor = fromBig(valueMinor(agg.units, toBig(currentPriceScaled), dec));
      if (!isCurrency) {
        const diff = toBig(currentPriceScaled) - toBig(avgCostScaled);
        unrealizedGainMinor = fromBig(roundDiv(agg.units * diff * 10n ** BigInt(dec), SCALE * SCALE));
      }
    }

    out.push({
      instrument: { id: instr.id, symbol: instr.symbol, name: instr.name, kind: instr.kind, currency: instr.currency },
      instrumentCurrency: instr.currency,
      units: fromBig(agg.units),
      avgCostScaled,
      currentPriceScaled,
      marketValueMinor,
      unrealizedGainMinor,
      missingPrice,
    });
  }

  out.sort((a, b) => a.instrument.name.localeCompare(b.instrument.name));
  return out;
}
