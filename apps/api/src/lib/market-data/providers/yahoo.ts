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

// Resolve a free-form query (ticker or ISIN) to candidate listings: every Yahoo
// match with a name, each enriched with its latest price/currency from the chart
// endpoint (fetched in parallel). Candidates without a price are dropped (so every
// returned option is priceable and the later "Update prices" can reproduce it).
// Sorted best-scored first; the caller decides which listing to use.
export async function yahooLookup(query: string, fetchImpl: typeof fetch = fetch): Promise<InstrumentLookupResult[]> {
  const q = query.trim();
  if (!q) return [];
  const res = await fetchImpl(`${endpoints.yahooSearch}?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`, { headers: HEADERS });
  if (!res.ok) return [];
  const body = await res.json() as {
    quotes?: Array<{ symbol?: string; score?: number; isYahooFinance?: boolean; quoteType?: string; shortname?: string; longname?: string; exchange?: string }>;
  };
  const quotes = (body.quotes ?? [])
    .filter((x) => x.isYahooFinance && typeof x.symbol === "string" && (x.longname || x.shortname))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const enriched = await Promise.all(quotes.map(async (qt): Promise<InstrumentLookupResult | null> => {
    const r = await chartFetch(fetchImpl, qt.symbol!, "range=5d&interval=1d");
    const meta = r?.meta;
    if (!meta || typeof meta.regularMarketPrice !== "number") return null;
    return {
      resolvedSymbol: qt.symbol!,
      name: (qt.longname ?? qt.shortname)!,
      currency: meta.currency ?? "USD",
      kind: kindFromQuoteType(qt.quoteType),
      price: meta.regularMarketPrice,
      date: isoFromEpoch(meta.regularMarketTime),
      exchange: qt.exchange ?? "",
      source: "yahoo",
    };
  }));
  return enriched.filter((x): x is InstrumentLookupResult => x !== null);
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
