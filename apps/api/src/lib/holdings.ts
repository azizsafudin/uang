import { db } from "../db/client";
import { prices, lots, instruments } from "../db/schema";
import { and, eq, lte, desc } from "drizzle-orm";
import { SCALE, roundDiv, toBig, fromBig, convertToBase, currencyDecimals } from "@uang/shared";
import { latestFxRateScaled } from "./fx";

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

export type HoldingLot = {
  lotId: string; instrumentId: string;
  instrument: { id: string; symbol: string | null; name: string; kind: string; currency: string };
  unitsScaled: number; unitCostScaled: number; feesMinor: number; tradeDate: string; note: string | null;
  priceScaled: number | null;
  mvMinor: number; costMinor: number; gainMinor: number; // instrument currency
  instrumentCurrency: string;
  mvBaseMinor: number; gainBaseMinor: number; // base currency
  missingPrice: boolean; // true if no price OR no FX rate -> excluded from totals
};

export type HoldingsValuation = {
  baseMinor: number; gainBaseMinor: number; missing: boolean; lots: HoldingLot[];
};

// Value every lot in an account (with trade_date <= asOf) using carry-forward prices,
// converting each lot's market value & gain from the instrument's currency to `base`.
// A missing price or missing FX rate flags the account and excludes that lot from totals.
export async function holdingsAccountValuation(accountId: string, asOf: string | undefined, base: string): Promise<HoldingsValuation> {
  const rows = await db
    .select()
    .from(lots)
    .innerJoin(instruments, eq(lots.instrumentId, instruments.id))
    .where(eq(lots.accountId, accountId));

  let totalBase = 0n;
  let totalGainBase = 0n;
  let missing = false;
  const out: HoldingLot[] = [];

  for (const row of rows) {
    const lot = row.lots;
    const instr = row.instruments;
    if (asOf && lot.tradeDate > asOf) continue;

    const priceScaled = await instrumentPriceScaled(lot.instrumentId, asOf);
    const instrDec = currencyDecimals(instr.currency);

    let mvMinor = 0, costMinor = 0, gainMinor = 0;
    let mvBaseMinor = 0, gainBaseMinor = 0;
    let missingPrice = false;

    if (priceScaled === null) {
      missingPrice = true;
    } else {
      const v = lotValuation(
        { unitsScaled: lot.unitsScaled, unitCostScaled: lot.unitCostScaled, feesMinor: lot.feesMinor },
        priceScaled, instrDec,
      );
      mvMinor = v.mvMinor; costMinor = v.costMinor; gainMinor = v.gainMinor;

      if (instr.currency.toUpperCase() === base.toUpperCase()) {
        mvBaseMinor = mvMinor; gainBaseMinor = gainMinor;
      } else {
        const rate = await latestFxRateScaled(instr.currency, asOf);
        if (rate === null) {
          missingPrice = true;
        } else {
          mvBaseMinor = fromBig(convertToBase(toBig(mvMinor), instr.currency, base, toBig(rate)));
          gainBaseMinor = fromBig(convertToBase(toBig(gainMinor), instr.currency, base, toBig(rate)));
        }
      }
    }

    if (missingPrice) {
      missing = true;
    } else {
      totalBase += toBig(mvBaseMinor);
      totalGainBase += toBig(gainBaseMinor);
    }

    out.push({
      lotId: lot.id, instrumentId: lot.instrumentId,
      instrument: { id: instr.id, symbol: instr.symbol, name: instr.name, kind: instr.kind, currency: instr.currency },
      unitsScaled: lot.unitsScaled, unitCostScaled: lot.unitCostScaled, feesMinor: lot.feesMinor,
      tradeDate: lot.tradeDate, note: lot.note,
      priceScaled,
      mvMinor, costMinor, gainMinor,
      instrumentCurrency: instr.currency,
      mvBaseMinor, gainBaseMinor,
      missingPrice,
    });
  }

  return { baseMinor: fromBig(totalBase), gainBaseMinor: fromBig(totalGainBase), missing, lots: out };
}
