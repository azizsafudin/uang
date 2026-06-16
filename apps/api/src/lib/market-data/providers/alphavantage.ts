import { endpoints } from "../endpoints";
import { spaceSeries } from "../spacing";
import type { InstrumentPriceProvider, InstrumentRef, PriceResult } from "../types";

// Alpha Vantage free tier caps daily history depth; cap + space the series so it
// still spans the full requested range (sparse but complete).
const MAX_POINTS = 100;

// AV has no ISIN lookup and uses bare/suffixed tickers. ISIN-only instruments are
// unsupported (resolve to null -> resolver advances to the next provider).
function avSymbol(inst: InstrumentRef): string | null {
  return inst.symbol ?? null;
}

export function makeAlphaVantageProvider(apiKey: string, fetchImpl: typeof fetch = fetch): InstrumentPriceProvider {
  return {
    name: "alphavantage",
    async fetchPrice(inst) {
      const sym = avSymbol(inst);
      if (!sym) return null;
      const res = await fetchImpl(`${endpoints.alphavantage}?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(sym)}&apikey=${apiKey}`);
      if (!res.ok) return null;
      const body = await res.json() as { "Global Quote"?: Record<string, string> };
      const q = body["Global Quote"];
      const priceStr = q?.["05. price"];
      const date = q?.["07. latest trading day"];
      if (!priceStr || !date) return null;
      const price = Number(priceStr);
      if (!Number.isFinite(price)) return null;
      return { price, currency: inst.currency, date };
    },
    async fetchPriceSeries(inst, start, end) {
      const sym = avSymbol(inst);
      if (!sym) return null;
      const res = await fetchImpl(`${endpoints.alphavantage}?function=TIME_SERIES_DAILY&outputsize=full&symbol=${encodeURIComponent(sym)}&apikey=${apiKey}`);
      if (!res.ok) return null;
      const body = await res.json() as { "Time Series (Daily)"?: Record<string, Record<string, string>> };
      const series = body["Time Series (Daily)"];
      if (!series) return null;
      const all: PriceResult[] = [];
      for (const [date, m] of Object.entries(series)) {
        if (date < start || date > end) continue;
        const close = Number(m["4. close"]);
        if (Number.isFinite(close)) all.push({ price: close, currency: inst.currency, date });
      }
      all.sort((a, b) => a.date.localeCompare(b.date));
      return spaceSeries(all, MAX_POINTS);
    },
  };
}
