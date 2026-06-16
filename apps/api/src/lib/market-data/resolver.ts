import type { InstrumentPriceProvider, FxRateProvider, InstrumentRef, PriceResult, FxResult } from "./types";

export async function resolvePriceLatest(
  chain: InstrumentPriceProvider[],
  inst: InstrumentRef,
): Promise<{ result: PriceResult; source: string } | null> {
  for (const p of chain) {
    try {
      const r = await p.fetchPrice(inst);
      if (r) return { result: r, source: p.name };
    } catch { /* advance */ }
  }
  return null;
}

export async function resolvePriceSeries(
  chain: InstrumentPriceProvider[],
  inst: InstrumentRef,
  start: string,
  end: string,
): Promise<{ result: PriceResult[]; source: string } | null> {
  for (const p of chain) {
    if (!p.fetchPriceSeries) continue;
    try {
      const probe = await p.fetchPrice(inst); // cheap symbol/format validation
      if (!probe) continue;
      const series = await p.fetchPriceSeries(inst, start, end);
      if (series && series.length > 0) return { result: series, source: p.name };
    } catch { /* advance */ }
  }
  return null;
}

export async function resolveFxLatest(
  chain: FxRateProvider[],
  currency: string,
  base: string,
): Promise<{ result: FxResult; source: string } | null> {
  for (const p of chain) {
    try {
      const r = await p.fetchRate(currency, base);
      if (r) return { result: r, source: p.name };
    } catch { /* advance */ }
  }
  return null;
}

export async function resolveFxSeries(
  chain: FxRateProvider[],
  currency: string,
  base: string,
  start: string,
  end: string,
): Promise<{ result: FxResult[]; source: string } | null> {
  for (const p of chain) {
    if (!p.fetchRateSeries) continue;
    try {
      const probe = await p.fetchRate(currency, base);
      if (!probe) continue;
      const series = await p.fetchRateSeries(currency, base, start, end);
      if (series && series.length > 0) return { result: series, source: p.name };
    } catch { /* advance */ }
  }
  return null;
}
