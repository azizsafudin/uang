import { expect, test } from "bun:test";
import { resolvePriceLatest, resolvePriceSeries, resolveFxLatest } from "./resolver";
import type { InstrumentPriceProvider, FxRateProvider, InstrumentRef } from "./types";

const inst: InstrumentRef = { symbol: "X", isin: null, currency: "USD", kind: "stock" };

function priceProvider(name: string, opts: {
  price?: number | null; series?: number[] | null; throws?: boolean; hasSeries?: boolean;
}): InstrumentPriceProvider {
  const p: InstrumentPriceProvider = {
    name,
    async fetchPrice() {
      if (opts.throws) throw new Error("boom");
      return opts.price == null ? null : { price: opts.price, currency: "USD", date: "2026-06-15" };
    },
  };
  if (opts.hasSeries !== false) {
    p.fetchPriceSeries = async () =>
      opts.series == null ? null : opts.series.map((v, i) => ({ price: v, currency: "USD", date: `2026-06-0${i + 1}` }));
  }
  return p;
}

test("latest: first non-null wins; failures advance the chain", async () => {
  const got = await resolvePriceLatest(
    [priceProvider("a", { throws: true }), priceProvider("b", { price: 42 })],
    inst,
  );
  expect(got).toEqual({ result: { price: 42, currency: "USD", date: "2026-06-15" }, source: "b" });
});

test("latest: all fail -> null", async () => {
  const got = await resolvePriceLatest([priceProvider("a", { price: null })], inst);
  expect(got).toBeNull();
});

test("series: probe must pass before series; skips providers without series", async () => {
  const got = await resolvePriceSeries(
    [
      priceProvider("a", { price: null, series: [1, 2] }),
      priceProvider("b", { price: 5, hasSeries: false }),
      priceProvider("c", { price: 9, series: [10, 11] }),
    ],
    inst, "2026-06-01", "2026-06-02",
  );
  expect(got?.source).toBe("c");
  expect(got?.result.length).toBe(2);
});

test("fx latest resolves through the chain", async () => {
  const fx: FxRateProvider = { name: "f", async fetchRate() { return { rate: 0.74, date: "2026-06-15" }; } };
  const got = await resolveFxLatest([fx], "SGD", "USD");
  expect(got).toEqual({ result: { rate: 0.74, date: "2026-06-15" }, source: "f" });
});
