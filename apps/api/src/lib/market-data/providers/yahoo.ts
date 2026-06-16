import { endpoints } from "../endpoints";
import type { InstrumentPriceProvider, FxRateProvider, InstrumentRef, PriceResult, FxResult, InstrumentLookupResult } from "../types";

// Yahoo blocks the default fetch UA; send a browser-like one.
const HEADERS = { "User-Agent": "Mozilla/5.0" };

// currency -> Yahoo exchange suffix, used only when the symbol has no suffix and no
// ISIN is available. Deliberately small: where a currency maps to many exchanges we
// don't guess (return null = unsupported, leave it manual).
const SUFFIX: Record<string, string> = { SGD: ".SI", GBP: ".L", HKD: ".HK", AUD: ".AX", JPY: ".T" };

type Chart = {
  chart?: { result?: Array<{
    meta?: { regularMarketPrice?: number; currency?: string; regularMarketTime?: number };
    timestamp?: number[];
    indicators?: { quote?: Array<{ close?: Array<number | null> }> };
  }> };
};

type ChartResult = NonNullable<NonNullable<Chart["chart"]>["result"]>[number];

function isoFromEpoch(sec: number | undefined): string {
  return new Date((sec ?? 0) * 1000).toISOString().slice(0, 10);
}

async function chartFetch(fetchImpl: typeof fetch, sym: string, query: string): Promise<ChartResult | null> {
  const res = await fetchImpl(`${endpoints.yahooChart}/${encodeURIComponent(sym)}?${query}`, { headers: HEADERS });
  if (!res.ok) return null;
  const body = await res.json() as Chart;
  return body.chart?.result?.[0] ?? null;
}

export function makeYahooPriceProvider(fetchImpl: typeof fetch = fetch): InstrumentPriceProvider {
  // Memoize ISIN/symbol -> resolved Yahoo symbol for the lifetime of this provider
  // instance (one refresh run searches each ISIN at most once). null = unsupported.
  const cache = new Map<string, string | null>();

  async function resolve(inst: InstrumentRef): Promise<string | null> {
    const key = `${inst.isin ?? ""}|${inst.symbol ?? ""}|${inst.currency}|${inst.kind}`;
    if (cache.has(key)) return cache.get(key)!;
    const sym = await resolveUncached(inst);
    cache.set(key, sym);
    return sym;
  }

  async function resolveUncached(inst: InstrumentRef): Promise<string | null> {
    if (inst.isin) {
      const res = await fetchImpl(`${endpoints.yahooSearch}?q=${encodeURIComponent(inst.isin)}&quotesCount=6&newsCount=0`, { headers: HEADERS });
      if (res.ok) {
        const body = await res.json() as { quotes?: Array<{ symbol?: string; score?: number; isYahooFinance?: boolean }> };
        const best = (body.quotes ?? [])
          .filter((q) => q.isYahooFinance && typeof q.symbol === "string")
          .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
        if (best?.symbol) return best.symbol;
      }
    }
    if (inst.symbol) {
      if (/[.\-]/.test(inst.symbol)) return inst.symbol;       // already provider-formatted
      if (inst.kind === "crypto") return `${inst.symbol}-${inst.currency}`;
      if (inst.currency === "USD") return inst.symbol;          // US listing, no suffix
      const suffix = SUFFIX[inst.currency];
      return suffix ? `${inst.symbol}${suffix}` : null;         // ambiguous -> unsupported
    }
    return null;
  }

  return {
    name: "yahoo",
    async fetchPrice(inst) {
      const sym = await resolve(inst);
      if (!sym) return null;
      const r = await chartFetch(fetchImpl, sym, "range=5d&interval=1d");
      const meta = r?.meta;
      if (!meta || typeof meta.regularMarketPrice !== "number") return null;
      return { price: meta.regularMarketPrice, currency: meta.currency ?? inst.currency, date: isoFromEpoch(meta.regularMarketTime) };
    },
    async fetchPriceSeries(inst, start, end) {
      const sym = await resolve(inst);
      if (!sym) return null;
      const p1 = Math.floor(Date.parse(start) / 1000);
      const p2 = Math.floor(Date.parse(end) / 1000) + 86_400;
      const r = await chartFetch(fetchImpl, sym, `period1=${p1}&period2=${p2}&interval=1d`);
      const ts = r?.timestamp;
      const closes = r?.indicators?.quote?.[0]?.close;
      if (!ts || !closes) return null;
      const currency = r?.meta?.currency ?? inst.currency;
      const out: PriceResult[] = [];
      for (let i = 0; i < ts.length; i++) {
        const c = closes[i];
        if (typeof c === "number") out.push({ price: c, currency, date: isoFromEpoch(ts[i]) });
      }
      return out;
    },
  };
}

function kindFromQuoteType(t: string | undefined): InstrumentLookupResult["kind"] {
  switch (t) {
    case "EQUITY": return "stock";
    case "ETF": return "etf";
    case "MUTUALFUND": return "fund";
    case "CRYPTOCURRENCY": return "crypto";
    default: return "other";
  }
}

// Resolve a free-form query (ticker or ISIN) to a preview: best Yahoo match's
// name/type, plus its latest price/currency from the chart endpoint. Returns null
// unless we get BOTH a name and a price (so a preview always shows a price and the
// later "Update prices" can reproduce it).
export async function yahooLookup(query: string, fetchImpl: typeof fetch = fetch): Promise<InstrumentLookupResult | null> {
  const q = query.trim();
  if (!q) return null;
  const res = await fetchImpl(`${endpoints.yahooSearch}?q=${encodeURIComponent(q)}&quotesCount=6&newsCount=0`, { headers: HEADERS });
  if (!res.ok) return null;
  const body = await res.json() as {
    quotes?: Array<{ symbol?: string; score?: number; isYahooFinance?: boolean; quoteType?: string; shortname?: string; longname?: string }>;
  };
  const best = (body.quotes ?? [])
    .filter((x) => x.isYahooFinance && typeof x.symbol === "string")
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
  if (!best?.symbol) return null;
  const name = best.longname ?? best.shortname;
  if (!name) return null;
  const r = await chartFetch(fetchImpl, best.symbol, "range=5d&interval=1d");
  const meta = r?.meta;
  if (!meta || typeof meta.regularMarketPrice !== "number") return null;
  return {
    resolvedSymbol: best.symbol,
    name,
    currency: meta.currency ?? "USD",
    kind: kindFromQuoteType(best.quoteType),
    price: meta.regularMarketPrice,
    date: isoFromEpoch(meta.regularMarketTime),
    source: "yahoo",
  };
}

export function makeYahooFxProvider(fetchImpl: typeof fetch = fetch): FxRateProvider {
  return {
    name: "yahoo",
    async fetchRate(currency, base) {
      if (currency === base) return null;
      const r = await chartFetch(fetchImpl, `${currency}${base}=X`, "range=5d&interval=1d");
      const meta = r?.meta;
      if (!meta || typeof meta.regularMarketPrice !== "number") return null;
      return { rate: meta.regularMarketPrice, date: isoFromEpoch(meta.regularMarketTime) };
    },
    async fetchRateSeries(currency, base, start, end) {
      if (currency === base) return null;
      const p1 = Math.floor(Date.parse(start) / 1000);
      const p2 = Math.floor(Date.parse(end) / 1000) + 86_400;
      const r = await chartFetch(fetchImpl, `${currency}${base}=X`, `period1=${p1}&period2=${p2}&interval=1d`);
      const ts = r?.timestamp;
      const closes = r?.indicators?.quote?.[0]?.close;
      if (!ts || !closes) return null;
      const out: FxResult[] = [];
      for (let i = 0; i < ts.length; i++) {
        const c = closes[i];
        if (typeof c === "number") out.push({ rate: c, date: isoFromEpoch(ts[i]) });
      }
      return out;
    },
  };
}
