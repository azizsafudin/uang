// An instrument reduced to what a price provider needs. `kind` excludes "currency"
// (currencies are priced at 1.0 and never sent to a provider).
export interface InstrumentRef {
  symbol: string | null;
  isin: string | null;
  currency: string;
  kind: "stock" | "etf" | "fund" | "crypto" | "other";
}

export interface PriceResult {
  price: number;    // in the instrument's own currency
  currency: string; // provider-reported quote currency
  date: string;     // YYYY-MM-DD
}

export interface FxResult {
  rate: number; // base-major per 1 foreign-major
  date: string; // YYYY-MM-DD
}

export interface InstrumentPriceProvider {
  name: string;
  // Latest quote. Returns null when this provider can't resolve/serve the instrument.
  // Also used by the resolver as a cheap symbol/format probe before fetchPriceSeries.
  fetchPrice(inst: InstrumentRef): Promise<PriceResult | null>;
  // Historical series over [start, end] (YYYY-MM-DD), trading days only. Optional:
  // a provider that can't serve history omits it.
  fetchPriceSeries?(inst: InstrumentRef, start: string, end: string): Promise<PriceResult[] | null>;
}

export interface FxRateProvider {
  name: string;
  // "1 `currency` = ? `base`" -> base-major per 1 foreign-major. null if unsupported.
  fetchRate(currency: string, base: string): Promise<FxResult | null>;
  fetchRateSeries?(currency: string, base: string, start: string, end: string): Promise<FxResult[] | null>;
}

export interface InstrumentLookupResult {
  resolvedSymbol: string;
  name: string;
  currency: string;
  kind: "stock" | "etf" | "fund" | "crypto" | "other";
  price: number;
  date: string;  // YYYY-MM-DD
  source: string;
}
