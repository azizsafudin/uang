import { expect, test, afterEach } from "bun:test";
import { endpoints } from "../endpoints";
import { makeYahooPriceProvider, makeYahooFxProvider, yahooLookup } from "./yahoo";
import type { InstrumentRef } from "../types";

const realChart = endpoints.yahooChart;
const realSearch = endpoints.yahooSearch;
afterEach(() => { endpoints.yahooChart = realChart; endpoints.yahooSearch = realSearch; });

// One mock server answering both /search and /chart/<sym>.
function mock(handler: (url: URL) => unknown) {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const body = handler(url);
      return body === null ? new Response("nf", { status: 404 }) : Response.json(body);
    },
  });
  endpoints.yahooChart = `http://localhost:${server.port}/chart`;
  endpoints.yahooSearch = `http://localhost:${server.port}/search`;
  return server;
}

const fund: InstrumentRef = { symbol: null, isin: "LU2420245917", currency: "SGD", kind: "fund" };

test("resolves an ISIN via search then fetches the latest price", async () => {
  const server = mock((url) => {
    if (url.pathname.endsWith("/search")) {
      return { quotes: [
        { symbol: "LU2420245917-SGD.LU", score: 20000, isYahooFinance: true },
        { symbol: "0P0001OO2D.SI", score: 20003, isYahooFinance: true },
      ] };
    }
    expect(decodeURIComponent(url.pathname)).toContain("0P0001OO2D.SI");
    return { chart: { result: [{ meta: { regularMarketPrice: 230.51, currency: "SGD", regularMarketTime: 1_750_000_000 } }] } };
  });
  try {
    const r = await makeYahooPriceProvider().fetchPrice(fund);
    expect(r?.price).toBe(230.51);
    expect(r?.currency).toBe("SGD");
    expect(r?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  } finally { server.stop(true); }
});

test("passes a suffixed symbol through without searching", async () => {
  const server = mock((url) => {
    expect(url.pathname.endsWith("/search")).toBe(false);
    return { chart: { result: [{ meta: { regularMarketPrice: 10, currency: "USD", regularMarketTime: 1_750_000_000 } }] } };
  });
  try {
    const inst: InstrumentRef = { symbol: "D05.SI", isin: null, currency: "SGD", kind: "stock" };
    const r = await makeYahooPriceProvider().fetchPrice(inst);
    expect(r?.price).toBe(10);
  } finally { server.stop(true); }
});

test("non-USD symbol with no suffix, no ISIN, and no suffix rule is unsupported", async () => {
  const noRule: InstrumentRef = { symbol: "FOO", isin: null, currency: "CHF", kind: "stock" };
  expect(await makeYahooPriceProvider().fetchPrice(noRule)).toBeNull();
});

test("fetchPriceSeries maps timestamps and closes", async () => {
  const server = mock((url) => {
    if (url.pathname.endsWith("/search")) return { quotes: [{ symbol: "AAA.SI", score: 1, isYahooFinance: true }] };
    return { chart: { result: [{
      meta: { currency: "SGD" },
      timestamp: [1_748_000_000, 1_748_086_400],
      indicators: { quote: [{ close: [100, 101] }] },
    }] } };
  });
  try {
    const s = await makeYahooPriceProvider().fetchPriceSeries!(fund, "2025-01-01", "2025-12-31");
    expect(s?.length).toBe(2);
    expect(s?.[0].price).toBe(100);
  } finally { server.stop(true); }
});

test("FX provider quotes a currency pair", async () => {
  const server = mock((url) => {
    expect(decodeURIComponent(url.pathname)).toContain("SGDUSD=X");
    return { chart: { result: [{ meta: { regularMarketPrice: 0.74, currency: "USD", regularMarketTime: 1_750_000_000 } }] } };
  });
  try {
    const r = await makeYahooFxProvider().fetchRate("SGD", "USD");
    expect(r?.rate).toBe(0.74);
  } finally { server.stop(true); }
});

test("yahooLookup resolves a query to name, kind, currency, symbol and price", async () => {
  const server = mock((url) => {
    if (url.pathname.endsWith("/search")) {
      return { quotes: [
        { symbol: "0P0001OO2F.SI", score: 20001, isYahooFinance: true, quoteType: "MUTUALFUND", longname: "Amundi Core MSCI EM Fund" },
        { symbol: "LU2420246139-SGD.LU", score: 20000, isYahooFinance: true, quoteType: "MUTUALFUND", longname: "x" },
      ] };
    }
    expect(decodeURIComponent(url.pathname)).toContain("0P0001OO2F.SI");
    return { chart: { result: [{ meta: { regularMarketPrice: 223.25, currency: "SGD", regularMarketTime: 1_750_000_000 } }] } };
  });
  try {
    const r = await yahooLookup("LU2420246139");
    expect(r?.name).toBe("Amundi Core MSCI EM Fund");
    expect(r?.kind).toBe("fund");
    expect(r?.currency).toBe("SGD");
    expect(r?.resolvedSymbol).toBe("0P0001OO2F.SI");
    expect(r?.price).toBe(223.25);
    expect(r?.source).toBe("yahoo");
  } finally { server.stop(true); }
});

test("yahooLookup returns null when search has no match", async () => {
  const server = mock((url) => {
    if (url.pathname.endsWith("/search")) return { quotes: [] };
    return { chart: { result: [] } };
  });
  try {
    expect(await yahooLookup("NOPE")).toBeNull();
  } finally { server.stop(true); }
});

test("yahooLookup returns null when the resolved symbol has no price", async () => {
  const server = mock((url) => {
    if (url.pathname.endsWith("/search")) return { quotes: [{ symbol: "X.Y", score: 1, isYahooFinance: true, quoteType: "EQUITY", shortname: "X" }] };
    return { chart: { result: [{ meta: { currency: "USD" } }] } }; // no regularMarketPrice
  });
  try {
    expect(await yahooLookup("X")).toBeNull();
  } finally { server.stop(true); }
});
