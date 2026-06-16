import { db } from "../../db/client";
import { instruments, prices, fxRates, accounts, transactions } from "../../db/schema";
import { and, eq, min, max } from "drizzle-orm";
import { SCALE } from "@uang/shared";
import { createId, nowEpoch } from "../ids";
import { getSettings } from "../settings";
import { makeYahooPriceProvider, makeYahooFxProvider, yahooLookup } from "./providers/yahoo";
import { makeFrankfurterProvider } from "./providers/frankfurter";
import { makeAlphaVantageProvider } from "./providers/alphavantage";
import { resolvePriceLatest, resolvePriceSeries, resolveFxLatest, resolveFxSeries } from "./resolver";
import type { InstrumentPriceProvider, FxRateProvider, InstrumentRef, InstrumentLookupResult } from "./types";

const S = Number(SCALE);
const scale = (n: number): number => Math.round(n * S);
const today = (): string => new Date().toISOString().slice(0, 10);

export type RefreshRange = { from?: string; to?: string; backfill?: boolean };
export type RefreshStatus = "updated" | "unsupported" | "failed" | "skipped";
export type RefreshResult = { status: RefreshStatus; source?: string; rowsWritten: number };
export type RefreshSummary = {
  updated: number; unsupported: number; failed: number; rowsWritten: number;
  details: Array<{ id: string; name: string; status: RefreshStatus; source?: string; rows: number }>;
};

export async function buildPriceChain(): Promise<InstrumentPriceProvider[]> {
  const s = await getSettings();
  const chain: InstrumentPriceProvider[] = [makeYahooPriceProvider()];
  if (s?.marketDataApiKey) chain.push(makeAlphaVantageProvider(s.marketDataApiKey));
  return chain;
}

export function buildFxChain(): FxRateProvider[] {
  return [makeFrankfurterProvider(), makeYahooFxProvider()];
}

async function upsertLatestPrice(instrumentId: string, date: string, priceScaled: number, source: string): Promise<void> {
  await db.insert(prices)
    .values({ id: createId(), instrumentId, date, priceScaled, source, createdAt: nowEpoch() })
    .onConflictDoUpdate({ target: [prices.instrumentId, prices.date], set: { priceScaled, source } });
}

async function insertPriceIfAbsent(instrumentId: string, date: string, priceScaled: number, source: string): Promise<boolean> {
  const [existing] = await db.select({ id: prices.id }).from(prices).where(and(eq(prices.instrumentId, instrumentId), eq(prices.date, date)));
  if (existing) return false;
  await db.insert(prices).values({ id: createId(), instrumentId, date, priceScaled, source, createdAt: nowEpoch() });
  return true;
}

async function upsertLatestFx(currency: string, date: string, rateScaled: number, source: string): Promise<void> {
  await db.insert(fxRates)
    .values({ id: createId(), currency, date, rateScaled, source, createdAt: nowEpoch() })
    .onConflictDoUpdate({ target: [fxRates.currency, fxRates.date], set: { rateScaled, source } });
}

async function insertFxIfAbsent(currency: string, date: string, rateScaled: number, source: string): Promise<boolean> {
  const [existing] = await db.select({ id: fxRates.id }).from(fxRates).where(and(eq(fxRates.currency, currency), eq(fxRates.date, date)));
  if (existing) return false;
  await db.insert(fxRates).values({ id: createId(), currency, date, rateScaled, source, createdAt: nowEpoch() });
  return true;
}

async function earliestTxnDate(instrumentId?: string): Promise<string | null> {
  const q = db.select({ d: min(transactions.date) }).from(transactions);
  const rows = instrumentId ? await q.where(eq(transactions.instrumentId, instrumentId)) : await q;
  return rows[0]?.d ?? null;
}

// Latest date we already have a stored price for. Used as the incremental
// backfill anchor: we only re-fetch from the last-known date forward.
async function latestStoredPriceDate(instrumentId: string): Promise<string | null> {
  const rows = await db.select({ d: max(prices.date) }).from(prices).where(eq(prices.instrumentId, instrumentId));
  return rows[0]?.d ?? null;
}

async function latestStoredFxDate(currency: string): Promise<string | null> {
  const rows = await db.select({ d: max(fxRates.date) }).from(fxRates).where(eq(fxRates.currency, currency));
  return rows[0]?.d ?? null;
}

export async function refreshInstrumentPrice(
  instrumentId: string,
  range?: RefreshRange,
  chain?: InstrumentPriceProvider[],
): Promise<RefreshResult> {
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst) return { status: "failed", rowsWritten: 0 };
  if (inst.kind === "currency") return { status: "skipped", rowsWritten: 0 };

  const providers = chain ?? (await buildPriceChain());
  const ref: InstrumentRef = {
    symbol: inst.symbol, isin: inst.isin, currency: inst.currency,
    // `inst.kind` is already narrowed to exclude "currency" by the guard above,
    // so it matches InstrumentRef["kind"] directly.
    kind: inst.kind,
  };

  const isBackfill = !!(range?.from || range?.backfill);
  try {
    if (isBackfill) {
      // Incremental: start from the last date we already have a price for (insert-if-absent
      // skips it), else the earliest transaction date. So we only fetch what's missing to date.
      const start = range?.from ?? (await latestStoredPriceDate(instrumentId)) ?? (await earliestTxnDate(instrumentId));
      if (!start) return refreshInstrumentPrice(instrumentId, undefined, providers);
      const end = range?.to ?? today();
      const got = await resolvePriceSeries(providers, ref, start, end);
      if (!got) return { status: "unsupported", rowsWritten: 0 };
      let rows = 0;
      for (const pt of got.result) {
        if (await insertPriceIfAbsent(instrumentId, pt.date, scale(pt.price), got.source)) rows++;
      }
      return { status: "updated", source: got.source, rowsWritten: rows };
    }
    const got = await resolvePriceLatest(providers, ref);
    if (!got) return { status: "unsupported", rowsWritten: 0 };
    await upsertLatestPrice(instrumentId, got.result.date, scale(got.result.price), got.source);
    return { status: "updated", source: got.source, rowsWritten: 1 };
  } catch {
    return { status: "failed", rowsWritten: 0 };
  }
}

export async function refreshAllPrices(range?: RefreshRange, chain?: InstrumentPriceProvider[]): Promise<RefreshSummary> {
  const providers = chain ?? (await buildPriceChain());
  const list = await db.select().from(instruments);
  const summary: RefreshSummary = { updated: 0, unsupported: 0, failed: 0, rowsWritten: 0, details: [] };
  for (const inst of list) {
    if (inst.kind === "currency") continue;
    const r = await refreshInstrumentPrice(inst.id, range, providers);
    if (r.status === "skipped") continue;
    if (r.status === "updated") summary.updated++;
    else if (r.status === "unsupported") summary.unsupported++;
    else summary.failed++;
    summary.rowsWritten += r.rowsWritten;
    summary.details.push({ id: inst.id, name: inst.name, status: r.status, source: r.source, rows: r.rowsWritten });
  }
  return summary;
}

async function currenciesInUse(base: string): Promise<string[]> {
  const a = await db.selectDistinct({ c: accounts.currency }).from(accounts);
  const i = await db.selectDistinct({ c: instruments.currency }).from(instruments);
  const set = new Set<string>();
  for (const r of [...a, ...i]) if (r.c && r.c !== base) set.add(r.c);
  return [...set];
}

export async function refreshFx(range?: RefreshRange, chain?: FxRateProvider[]): Promise<RefreshSummary> {
  const s = await getSettings();
  const base = s?.baseCurrency ?? "USD";
  const providers = chain ?? buildFxChain();
  const currencies = await currenciesInUse(base);
  const summary: RefreshSummary = { updated: 0, unsupported: 0, failed: 0, rowsWritten: 0, details: [] };

  const isBackfill = !!(range?.from || range?.backfill);
  for (const cur of currencies) {
    try {
      if (isBackfill) {
        const start = range?.from ?? (await latestStoredFxDate(cur)) ?? (await earliestTxnDate());
        const end = range?.to ?? today();
        const got = start ? await resolveFxSeries(providers, cur, base, start, end) : null;
        if (!got) { summary.unsupported++; summary.details.push({ id: cur, name: cur, status: "unsupported", rows: 0 }); continue; }
        let rows = 0;
        for (const pt of got.result) if (await insertFxIfAbsent(cur, pt.date, scale(pt.rate), got.source)) rows++;
        summary.updated++; summary.rowsWritten += rows;
        summary.details.push({ id: cur, name: cur, status: "updated", source: got.source, rows });
      } else {
        const got = await resolveFxLatest(providers, cur, base);
        if (!got) { summary.unsupported++; summary.details.push({ id: cur, name: cur, status: "unsupported", rows: 0 }); continue; }
        await upsertLatestFx(cur, got.result.date, scale(got.result.rate), got.source);
        summary.updated++; summary.rowsWritten += 1;
        summary.details.push({ id: cur, name: cur, status: "updated", source: got.source, rows: 1 });
      }
    } catch {
      summary.failed++; summary.details.push({ id: cur, name: cur, status: "failed", rows: 0 });
    }
  }
  return summary;
}

export async function lookupInstrument(query: string): Promise<InstrumentLookupResult[]> {
  return yahooLookup(query);
}
