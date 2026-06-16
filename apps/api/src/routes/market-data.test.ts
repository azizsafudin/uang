import { expect, test, beforeEach, afterEach } from "bun:test";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { marketDataRoutes } from "./market-data";
import { settingsRoutes } from "./settings";
import { db } from "../db/client";
import { instruments, prices } from "../db/schema";
import { createId, nowEpoch } from "../lib/ids";
import { eq } from "drizzle-orm";
import { endpoints } from "../lib/market-data/endpoints";

beforeEach(resetDb);
const app = makeApp(marketDataRoutes, settingsRoutes);

const realChart = endpoints.yahooChart;
const realSearch = endpoints.yahooSearch;
afterEach(() => { endpoints.yahooChart = realChart; endpoints.yahooSearch = realSearch; });

function mockYahoo() {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({ chart: { result: [{ meta: { regularMarketPrice: 55, currency: "USD", regularMarketTime: 1_750_000_000 } }] } });
    },
  });
  endpoints.yahooChart = `http://localhost:${server.port}/chart`;
  endpoints.yahooSearch = `http://localhost:${server.port}/search`;
  return server;
}

test("single refresh writes a price row sourced from the provider", async () => {
  const { cookie } = await initAndLogin({ app });
  const id = createId();
  await db.insert(instruments).values({ id, symbol: "AAPL", isin: null, name: "Apple", kind: "stock", currency: "USD", createdAt: nowEpoch() });
  const server = mockYahoo();
  try {
    const res = await app.handle(new Request(`http://localhost/market-data/instrument/${id}/refresh`, {
      method: "POST", headers: { "content-type": "application/json", cookie }, body: "{}",
    }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("updated");
    expect(json.source).toBe("yahoo");
    const rows = await db.select().from(prices).where(eq(prices.instrumentId, id));
    expect(rows.length).toBe(1);
    expect(rows[0].source).toBe("yahoo");
  } finally { server.stop(true); }
});

test("currency instrument is skipped", async () => {
  const { cookie } = await initAndLogin({ app });
  const id = createId();
  await db.insert(instruments).values({ id, symbol: "USD", isin: null, name: "US Dollar", kind: "currency", currency: "USD", createdAt: nowEpoch() });
  const res = await app.handle(new Request(`http://localhost/market-data/instrument/${id}/refresh`, {
    method: "POST", headers: { "content-type": "application/json", cookie }, body: "{}",
  }));
  expect((await res.json()).status).toBe("skipped");
});

test("POST /market-data/test is admin-gated and reports unconfigured", async () => {
  const { cookie } = await initAndLogin({ app });
  const res = await app.handle(new Request("http://localhost/market-data/test", { method: "POST", headers: { cookie } }));
  expect(res.status).toBe(200);
  expect((await res.json()).ok).toBe(false);
});

test("POST /market-data/lookup returns candidates for a resolvable query", async () => {
  const { cookie } = await initAndLogin({ app });
  const server = Bun.serve({ port: 0, fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/search")) {
      return Response.json({ quotes: [{ symbol: "AAPL", score: 1, isYahooFinance: true, quoteType: "EQUITY", shortname: "Apple Inc." }] });
    }
    return Response.json({ chart: { result: [{ meta: { regularMarketPrice: 200, currency: "USD", regularMarketTime: 1_750_000_000 } }] } });
  }});
  endpoints.yahooChart = `http://localhost:${server.port}/chart`;
  endpoints.yahooSearch = `http://localhost:${server.port}/search`;
  try {
    const res = await app.handle(new Request("http://localhost/market-data/lookup", {
      method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ query: "AAPL" }),
    }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.candidates.length).toBe(1);
    expect(json.candidates[0].name).toBe("Apple Inc.");
    expect(json.candidates[0].kind).toBe("stock");
    expect(json.candidates[0].resolvedSymbol).toBe("AAPL");
    expect(json.candidates[0].price).toBe(200);
  } finally { server.stop(true); }
});

test("POST /market-data/lookup returns no candidates when nothing matches", async () => {
  const { cookie } = await initAndLogin({ app });
  const server = Bun.serve({ port: 0, fetch() { return Response.json({ quotes: [] }); } });
  endpoints.yahooChart = `http://localhost:${server.port}/chart`;
  endpoints.yahooSearch = `http://localhost:${server.port}/search`;
  try {
    const res = await app.handle(new Request("http://localhost/market-data/lookup", {
      method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ query: "NOPE" }),
    }));
    expect((await res.json()).candidates).toEqual([]);
  } finally { server.stop(true); }
});
