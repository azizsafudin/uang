import { expect, test, afterEach } from "bun:test";
import { endpoints } from "../endpoints";
import { makeAlphaVantageProvider } from "./alphavantage";
import type { InstrumentRef } from "../types";

const real = endpoints.alphavantage;
afterEach(() => { endpoints.alphavantage = real; });

function mock(handler: (url: URL) => unknown) {
  const server = Bun.serve({ port: 0, fetch: (req) => Response.json(handler(new URL(req.url))) });
  endpoints.alphavantage = `http://localhost:${server.port}/query`;
  return server;
}

const stock: InstrumentRef = { symbol: "IBM", isin: null, currency: "USD", kind: "stock" };

test("fetchPrice parses GLOBAL_QUOTE", async () => {
  const server = mock((url) => {
    expect(url.searchParams.get("function")).toBe("GLOBAL_QUOTE");
    expect(url.searchParams.get("apikey")).toBe("KEY");
    return { "Global Quote": { "05. price": "123.45", "07. latest trading day": "2026-06-15" } };
  });
  try {
    const r = await makeAlphaVantageProvider("KEY").fetchPrice(stock);
    expect(r).toEqual({ price: 123.45, currency: "USD", date: "2026-06-15" });
  } finally { server.stop(true); }
});

test("ISIN-only instrument is unsupported (AV has no ISIN lookup)", async () => {
  const inst: InstrumentRef = { symbol: null, isin: "LU2420245917", currency: "SGD", kind: "fund" };
  const r = await makeAlphaVantageProvider("KEY").fetchPrice(inst);
  expect(r).toBeNull();
});

test("series filters to range and downsamples", async () => {
  const series: Record<string, Record<string, string>> = {};
  for (let i = 0; i < 150; i++) {
    const date = new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
    series[date] = { "4. close": String(100 + i) };
  }
  const server = mock(() => ({ "Time Series (Daily)": series }));
  try {
    const s = await makeAlphaVantageProvider("KEY").fetchPriceSeries!(stock, "2025-01-01", "2025-12-31");
    expect(s).not.toBeNull();
    expect(s!.length).toBeLessThanOrEqual(100);
    expect(s!.length).toBeGreaterThan(1);
    expect(s![0].date < s![s!.length - 1].date).toBe(true);
  } finally { server.stop(true); }
});

test("rate-limit note (no Global Quote) returns null", async () => {
  const server = mock(() => ({ Information: "rate limited" }));
  try {
    expect(await makeAlphaVantageProvider("KEY").fetchPrice(stock)).toBeNull();
  } finally { server.stop(true); }
});
