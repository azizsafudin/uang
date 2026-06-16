import { endpoints } from "../endpoints";
import type { FxRateProvider, FxResult } from "../types";

// Frankfurter (frankfurter.app): free, no key, ECB-backed daily rates.
// We query from=foreign,to=base so rates[base] = base-major per 1 foreign-major,
// which is exactly fx_rates.rateScaled / SCALE.
export function makeFrankfurterProvider(fetchImpl: typeof fetch = fetch): FxRateProvider {
  return {
    name: "frankfurter",
    async fetchRate(currency, base) {
      if (currency === base) return null;
      const res = await fetchImpl(`${endpoints.frankfurter}/latest?from=${currency}&to=${base}`);
      if (!res.ok) return null;
      const body = await res.json() as { date?: string; rates?: Record<string, number> };
      const rate = body.rates?.[base];
      if (typeof rate !== "number" || !body.date) return null;
      return { rate, date: body.date };
    },
    async fetchRateSeries(currency, base, start, end) {
      if (currency === base) return null;
      const res = await fetchImpl(`${endpoints.frankfurter}/${start}..${end}?from=${currency}&to=${base}`);
      if (!res.ok) return null;
      const body = await res.json() as { rates?: Record<string, Record<string, number>> };
      if (!body.rates) return null;
      const out: FxResult[] = [];
      for (const [date, m] of Object.entries(body.rates)) {
        const rate = m[base];
        if (typeof rate === "number") out.push({ rate, date });
      }
      out.sort((a, b) => a.date.localeCompare(b.date));
      return out;
    },
  };
}
