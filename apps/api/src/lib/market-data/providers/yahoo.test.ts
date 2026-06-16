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

test("prefers an explicit resolved symbol over the ISIN (no search) when both are set", async () => {
  // ISIN-mode adds store the chosen listing's resolved symbol AND the ISIN; the
  // resolved symbol must win so a non-default listing pick is honoured on refresh.
  const server = mock((url) => {
    expect(url.pathname.endsWith("/search")).toBe(false);
    expect(decodeURIComponent(url.pathname)).toContain("0P0001OO2F.SI");
    return { chart: { result: [{ meta: { regularMarketPrice: 223.25, currency: "SGD", regularMarketTime: 1_750_000_000 } }] } };
  });
  try {
    const inst: InstrumentRef = { symbol: "0P0001OO2F.SI", isin: "LU2420246139", currency: "SGD", kind: "fund" };
    const r = await makeYahooPriceProvider().fetchPrice(inst);
    expect(r?.price).toBe(223.25);
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

test("yahooLookup returns all priceable candidates, best-scored first", async () => {
  const server = mock((url) => {
    if (url.pathname.endsWith("/search")) {
      return { quotes: [
        { symbol: "0P0001OO2F.SI", score: 20001, isYahooFinance: true, quoteType: "MUTUALFUND", longname: "Amundi Core MSCI EM Fund", exchange: "SES" },
        { symbol: "LU2420246139-SGD.LU", score: 20000, isYahooFinance: true, quoteType: "MUTUALFUND", longname: "Amundi LU Listing", exchange: "LUX" },
      ] };
    }
    const price = decodeURIComponent(url.pathname).includes("0P0001OO2F.SI") ? 223.25 : 229.3;
    return { chart: { result: [{ meta: { regularMarketPrice: price, currency: "SGD", regularMarketTime: 1_750_000_000 } }] } };
  });
  try {
    const r = await yahooLookup("LU2420246139");
    expect(r.length).toBe(2);
    expect(r[0].resolvedSymbol).toBe("0P0001OO2F.SI"); // highest score first
    expect(r[0].name).toBe("Amundi Core MSCI EM Fund");
    expect(r[0].kind).toBe("fund");
    expect(r[0].currency).toBe("SGD");
    expect(r[0].price).toBe(223.25);
    expect(r[0].exchange).toBe("SES");
    expect(r[0].source).toBe("yahoo");
    expect(r[1].resolvedSymbol).toBe("LU2420246139-SGD.LU");
    expect(r[1].price).toBe(229.3);
  } finally { server.stop(true); }
});

test("yahooLookup returns [] when search has no match", async () => {
  const server = mock((url) => {
    if (url.pathname.endsWith("/search")) return { quotes: [] };
    return { chart: { result: [] } };
  });
  try {
    expect(await yahooLookup("NOPE")).toEqual([]);
  } finally { server.stop(true); }
});

test("yahooLookup drops candidates that have no price", async () => {
  const server = mock((url) => {
    if (url.pathname.endsWith("/search")) {
      return { quotes: [
        { symbol: "HASPRICE.SI", score: 2, isYahooFinance: true, quoteType: "EQUITY", shortname: "Has Price" },
        { symbol: "NOPRICE.SI", score: 1, isYahooFinance: true, quoteType: "EQUITY", shortname: "No Price" },
      ] };
    }
    if (decodeURIComponent(url.pathname).includes("HASPRICE.SI")) {
      return { chart: { result: [{ meta: { regularMarketPrice: 10, currency: "USD", regularMarketTime: 1_750_000_000 } }] } };
    }
    return { chart: { result: [{ meta: { currency: "USD" } }] } }; // no regularMarketPrice
  });
  try {
    const r = await yahooLookup("X");
    expect(r.length).toBe(1);
    expect(r[0].resolvedSymbol).toBe("HASPRICE.SI");
  } finally { server.stop(true); }
});
