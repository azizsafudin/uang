# Market Data Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fetch indicative instrument prices and FX rates from free providers (Yahoo, Frankfurter, Alpha Vantage) on demand, with a provider-agnostic resolver chain, latest + historical-backfill modes, and the Alpha Vantage key stored in Settings.

**Architecture:** A `apps/api/src/lib/market-data/` module defines two provider interfaces and small adapters (Yahoo, Frankfurter, Alpha Vantage), a resolver that walks an ordered chain (probe-then-series), and orchestration functions that upsert into the existing `prices`/`fx_rates` tables. New `/market-data` routes call the orchestration. Web adds refresh/backfill buttons and a Settings section for the AV key.

**Tech Stack:** Bun, Elysia, Drizzle (libsql/SQLite), Eden treaty, React + TanStack Query/DB. Fixed-point money math via `@uang/shared` (`SCALE = 1e8`).

**Spec:** `docs/superpowers/specs/2026-06-16-market-data-providers-design.md`

**Key design notes for the implementer:**
- **No `as any`.** Parse external JSON with a *specific* type assertion (e.g. `await res.json() as { date?: string; rates?: Record<string, number> }`) — that is allowed; `as any` is banned. Route handler context may use the existing `({ body, set }: any)` convention only.
- **Symbol resolution lives inside the Yahoo adapter** (not in the shared interface). The resolver uses `fetchPrice` as the cheap probe before `fetchPriceSeries` — a `null` probe means "unsupported by this provider," so the chain advances. This satisfies the spec's "probe before series" and keeps the interface minimal.
- **fx_rates semantics:** `rateScaled = (base-major per 1 foreign-major) × SCALE`, stored under `currency = <foreign>`. So to refresh currency `C` against base `B`, ask the provider for "1 `C` = ? `B`" (Frankfurter `from=C&to=B`; Yahoo pair `C B =X`).
- **Money scaling:** `priceScaled = Math.round(price * 1e8)`, `rateScaled = Math.round(rate * 1e8)`.
- Run API typecheck after server changes via `cd apps/web && bun run build` (tsgo) — `bun test` does not strict-typecheck.

---

## File Structure

**Create (API):**
- `apps/api/src/lib/market-data/types.ts` — provider interfaces + result types
- `apps/api/src/lib/market-data/endpoints.ts` — mutable base-URL table (test seam)
- `apps/api/src/lib/market-data/spacing.ts` — pure downsample helper
- `apps/api/src/lib/market-data/providers/frankfurter.ts` — FX provider
- `apps/api/src/lib/market-data/providers/yahoo.ts` — price + FX provider (ISIN search)
- `apps/api/src/lib/market-data/providers/alphavantage.ts` — keyed price provider
- `apps/api/src/lib/market-data/resolver.ts` — chain resolution (probe-then-series)
- `apps/api/src/lib/market-data/index.ts` — chain builders + refresh orchestration
- `apps/api/src/routes/market-data.ts` — `/market-data` routes
- Tests alongside each (`*.test.ts`)

**Modify (API):**
- `apps/api/src/db/schema.ts` — `fx_rates.source`, `settings.marketDataApiKey`
- `apps/api/drizzle/` — generated migration
- `apps/api/src/lib/settings.ts` — `loadMarketDataConfig()`
- `apps/api/src/routes/settings.ts` — `marketDataApiKeySet` (GET), `marketDataApiKey`/`clearMarketData` (PATCH)
- `apps/api/src/app.ts` — mount `marketDataRoutes`

**Modify (Web):**
- `apps/web/src/routes/settings.tsx` — "Market data provider" section
- `apps/web/src/routes/instrument-detail.tsx` — Refresh price + Backfill buttons
- `apps/web/src/routes/instruments.tsx` — Refresh all / Refresh FX (+ backfill) buttons

---

## Task 1: Schema + migration + settings wiring

**Files:**
- Modify: `apps/api/src/db/schema.ts:4-20` (settings), `:110-116` (fxRates)
- Modify: `apps/api/src/lib/settings.ts`
- Modify: `apps/api/src/routes/settings.ts`
- Create: migration under `apps/api/drizzle/`
- Test: `apps/api/src/routes/settings-marketdata.test.ts`

- [ ] **Step 1: Add the schema columns**

In `apps/api/src/db/schema.ts`, add `marketDataApiKey` to the `settings` table after `aiApiKey` (line 18):

```ts
  aiApiKey: text("ai_api_key"),
  // Market data provider (Alpha Vantage). Optional keyed alternative for instrument
  // prices; Yahoo (no key) is the primary. Key is never returned to the client.
  marketDataApiKey: text("market_data_api_key"),
  createdAt: integer("created_at").notNull(),
```

And add `source` to the `fxRates` table (after `rateScaled`, line 114):

```ts
export const fxRates = sqliteTable("fx_rates", {
  id: text("id").primaryKey(),
  currency: text("currency").notNull(),
  date: text("date").notNull(),
  rateScaled: integer("rate_scaled").notNull(),
  source: text("source").notNull().default("manual"),
  createdAt: integer("created_at").notNull(),
}, (t) => [uniqueIndex("fx_rates_currency_date_uq").on(t.currency, t.date)]);
```

- [ ] **Step 2: Generate and apply the migration**

Run: `cd apps/api && bun run db:generate`
Expected: a new `drizzle/00NN_*.sql` is created containing approximately:

```sql
ALTER TABLE `fx_rates` ADD `source` text DEFAULT 'manual' NOT NULL;
ALTER TABLE `settings` ADD `market_data_api_key` text;
```

Then apply to the dev DB: `bun run db:migrate`
Expected: prints `migrations applied`. (Adding columns is non-interactive; if drizzle-kit prompts about anything, abort and re-check the schema edits.)

- [ ] **Step 3: Add `loadMarketDataConfig` to the settings lib**

In `apps/api/src/lib/settings.ts`, append:

```ts
// Market-data provider config from the singleton settings row. Alpha Vantage is
// the only keyed provider; Yahoo/Frankfurter need no key.
export async function loadMarketDataConfig(): Promise<{ alphaVantageApiKey?: string }> {
  const s = await getSettings();
  return { alphaVantageApiKey: s?.marketDataApiKey ?? undefined };
}
```

- [ ] **Step 4: Wire the settings route (GET flag + PATCH write-only key)**

In `apps/api/src/routes/settings.ts` GET handler, add to the returned object (after `aiApiKeySet`):

```ts
      aiApiKeySet: !!s?.aiApiKey,
      marketDataApiKeySet: !!s?.marketDataApiKey,
    };
```

In the PATCH handler, extend the admin gate and update logic. Replace the `touchesAi` block + update assembly with:

```ts
      const touchesAi =
        body.aiBaseUrl !== undefined || body.aiModel !== undefined
        || body.aiApiKey !== undefined || body.clearAi === true;
      const touchesMarketData =
        body.marketDataApiKey !== undefined || body.clearMarketData === true;
      if ((touchesAi || touchesMarketData) && !isAdmin) {
        set.status = 403;
        return { error: "admin_only" };
      }
      const update: Record<string, unknown> = {};
      if (body.contributionGrowthRateBps !== undefined) update.contributionGrowthRateBps = body.contributionGrowthRateBps;
      if (body.projectionEndAge !== undefined) update.projectionEndAge = body.projectionEndAge;
      if (body.dashboardTiles !== undefined) update.dashboardTiles = JSON.stringify(body.dashboardTiles);
      if (body.aiBaseUrl !== undefined) update.aiBaseUrl = body.aiBaseUrl || null;
      if (body.aiModel !== undefined) update.aiModel = body.aiModel || null;
      // Empty/omitted aiApiKey preserves the stored key (write-only field).
      if (typeof body.aiApiKey === "string" && body.aiApiKey.length > 0) update.aiApiKey = body.aiApiKey;
      // Same write-only rule for the market-data key.
      if (typeof body.marketDataApiKey === "string" && body.marketDataApiKey.length > 0) update.marketDataApiKey = body.marketDataApiKey;
      if (body.clearMarketData === true) update.marketDataApiKey = null;
      // Explicit disconnect: wipe the whole provider, including the stored key.
      if (body.clearAi === true) {
        update.aiBaseUrl = null;
        update.aiModel = null;
        update.aiApiKey = null;
      }
```

And extend the body schema (`t.Object({ ... })`) with:

```ts
        aiApiKey: t.Optional(t.String()),
        clearAi: t.Optional(t.Boolean()),
        marketDataApiKey: t.Optional(t.String()),
        clearMarketData: t.Optional(t.Boolean()),
      }),
```

- [ ] **Step 5: Write the settings test**

Create `apps/api/src/routes/settings-marketdata.test.ts`:

```ts
import { expect, test, beforeEach } from "bun:test";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { settingsRoutes } from "./settings";
import { usersRoutes } from "./users";

beforeEach(resetDb);
const app = makeApp(settingsRoutes);
const appWithUsers = makeApp(settingsRoutes, usersRoutes);

async function memberCookie(adminCookie: string): Promise<string> {
  await appWithUsers.handle(new Request("http://localhost/users", {
    method: "POST", headers: { "content-type": "application/json", cookie: adminCookie },
    body: JSON.stringify({ email: "member@test.com", name: "Member", password: "anothersecret1" }),
  }));
  const signin = await appWithUsers.handle(new Request("http://localhost/api/auth/sign-in/email", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "member@test.com", password: "anothersecret1" }),
  }));
  return signin.headers.get("set-cookie") ?? "";
}

test("PATCH sets market-data key; GET returns marketDataApiKeySet not the key; empty preserves", async () => {
  const { cookie } = await initAndLogin({ app });
  await app.handle(new Request("http://localhost/settings", {
    method: "PATCH", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ marketDataApiKey: "AV-KEY" }),
  }));
  const got = await (await app.handle(new Request("http://localhost/settings", { headers: { cookie } }))).json();
  expect(got.marketDataApiKeySet).toBe(true);
  expect("marketDataApiKey" in got).toBe(false);

  // PATCH without the key must not wipe it
  await app.handle(new Request("http://localhost/settings", {
    method: "PATCH", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ projectionEndAge: 80 }),
  }));
  const got2 = await (await app.handle(new Request("http://localhost/settings", { headers: { cookie } }))).json();
  expect(got2.marketDataApiKeySet).toBe(true);
});

test("clearMarketData wipes the stored key", async () => {
  const { cookie } = await initAndLogin({ app });
  await app.handle(new Request("http://localhost/settings", {
    method: "PATCH", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ marketDataApiKey: "AV-KEY" }),
  }));
  await app.handle(new Request("http://localhost/settings", {
    method: "PATCH", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ clearMarketData: true }),
  }));
  const got = await (await app.handle(new Request("http://localhost/settings", { headers: { cookie } }))).json();
  expect(got.marketDataApiKeySet).toBe(false);
});

test("non-admin gets 403 setting the market-data key", async () => {
  const { cookie: adminCookie } = await initAndLogin({ app: appWithUsers });
  const cookie = await memberCookie(adminCookie);
  const denied = await appWithUsers.handle(new Request("http://localhost/settings", {
    method: "PATCH", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ marketDataApiKey: "x" }),
  }));
  expect(denied.status).toBe(403);
  expect((await denied.json()).error).toBe("admin_only");
});
```

- [ ] **Step 6: Run the tests**

Run: `cd apps/api && bun test src/routes/settings-marketdata.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle apps/api/src/lib/settings.ts apps/api/src/routes/settings.ts apps/api/src/routes/settings-marketdata.test.ts
git commit -m "feat(api): market-data key in settings + fx_rates.source column"
```

---

## Task 2: Spacing helper (pure)

**Files:**
- Create: `apps/api/src/lib/market-data/spacing.ts`
- Test: `apps/api/src/lib/market-data/spacing.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/lib/market-data/spacing.test.ts`:

```ts
import { expect, test } from "bun:test";
import { spaceSeries } from "./spacing";

test("returns input unchanged when at or under the cap", () => {
  const pts = [1, 2, 3];
  expect(spaceSeries(pts, 5)).toEqual([1, 2, 3]);
  expect(spaceSeries(pts, 3)).toEqual([1, 2, 3]);
});

test("downsamples to evenly-spaced points including both endpoints", () => {
  const pts = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]; // n=10
  const out = spaceSeries(pts, 5);
  expect(out.length).toBe(5);
  expect(out[0]).toBe(0);              // first endpoint
  expect(out[out.length - 1]).toBe(9); // last endpoint
});

test("cap of 1 returns the most recent (last) point", () => {
  expect(spaceSeries([0, 1, 2, 3], 1)).toEqual([3]);
});

test("cap of 0 or less returns empty", () => {
  expect(spaceSeries([1, 2, 3], 0)).toEqual([]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && bun test src/lib/market-data/spacing.test.ts`
Expected: FAIL — `Cannot find module './spacing'`.

- [ ] **Step 3: Implement**

Create `apps/api/src/lib/market-data/spacing.ts`:

```ts
// Downsample an already-sorted series to at most `maxPoints` evenly-spaced
// elements, always keeping the first and last (endpoints). Used by depth-limited
// providers (e.g. Alpha Vantage) so a sparse series still spans the full range.
export function spaceSeries<T>(points: T[], maxPoints: number): T[] {
  if (maxPoints <= 0) return [];
  if (points.length <= maxPoints) return points;
  if (maxPoints === 1) return [points[points.length - 1]];
  const n = points.length;
  const seen = new Set<number>();
  const out: T[] = [];
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.round((i * (n - 1)) / (maxPoints - 1));
    if (!seen.has(idx)) {
      seen.add(idx);
      out.push(points[idx]);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && bun test src/lib/market-data/spacing.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/market-data/spacing.ts apps/api/src/lib/market-data/spacing.test.ts
git commit -m "feat(api): spaceSeries downsample helper for market-data backfill"
```

---

## Task 3: Provider types + endpoints + Frankfurter (FX)

**Files:**
- Create: `apps/api/src/lib/market-data/types.ts`
- Create: `apps/api/src/lib/market-data/endpoints.ts`
- Create: `apps/api/src/lib/market-data/providers/frankfurter.ts`
- Test: `apps/api/src/lib/market-data/providers/frankfurter.test.ts`

- [ ] **Step 1: Define the interfaces and endpoints (no test yet)**

Create `apps/api/src/lib/market-data/types.ts`:

```ts
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
  // "1 `currency` = ? `base`" → base-major per 1 foreign-major. null if unsupported.
  fetchRate(currency: string, base: string): Promise<FxResult | null>;
  fetchRateSeries?(currency: string, base: string, start: string, end: string): Promise<FxResult[] | null>;
}
```

Create `apps/api/src/lib/market-data/endpoints.ts`:

```ts
// Provider base URLs. Mutable so tests can point a provider at a local mock server
// (see *.test.ts). Production uses the real hosts.
export const endpoints = {
  yahooChart: "https://query1.finance.yahoo.com/v8/finance/chart",
  yahooSearch: "https://query1.finance.yahoo.com/v1/finance/search",
  frankfurter: "https://api.frankfurter.app",
  alphavantage: "https://www.alphavantage.co/query",
};
```

- [ ] **Step 2: Write the failing Frankfurter test**

Create `apps/api/src/lib/market-data/providers/frankfurter.test.ts`:

```ts
import { expect, test, afterEach } from "bun:test";
import { endpoints } from "../endpoints";
import { makeFrankfurterProvider } from "./frankfurter";

const realBase = endpoints.frankfurter;
afterEach(() => { endpoints.frankfurter = realBase; });

function mock(handler: (req: Request) => Response) {
  const server = Bun.serve({ port: 0, fetch: handler });
  endpoints.frankfurter = `http://localhost:${server.port}`;
  return server;
}

test("fetchRate returns base-per-foreign and the date", async () => {
  const server = mock((req) => {
    expect(new URL(req.url).searchParams.get("from")).toBe("SGD");
    expect(new URL(req.url).searchParams.get("to")).toBe("USD");
    return Response.json({ amount: 1, base: "SGD", date: "2026-06-15", rates: { USD: 0.74 } });
  });
  try {
    const p = makeFrankfurterProvider();
    const r = await p.fetchRate("SGD", "USD");
    expect(r).toEqual({ rate: 0.74, date: "2026-06-15" });
  } finally { server.stop(true); }
});

test("fetchRateSeries returns sorted points", async () => {
  const server = mock(() =>
    Response.json({ rates: { "2026-06-02": { USD: 0.75 }, "2026-06-01": { USD: 0.74 } } }),
  );
  try {
    const p = makeFrankfurterProvider();
    const s = await p.fetchRateSeries!("SGD", "USD", "2026-06-01", "2026-06-02");
    expect(s).toEqual([
      { rate: 0.74, date: "2026-06-01" },
      { rate: 0.75, date: "2026-06-02" },
    ]);
  } finally { server.stop(true); }
});

test("same currency returns null", async () => {
  const p = makeFrankfurterProvider();
  expect(await p.fetchRate("USD", "USD")).toBeNull();
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd apps/api && bun test src/lib/market-data/providers/frankfurter.test.ts`
Expected: FAIL — `Cannot find module './frankfurter'`.

- [ ] **Step 4: Implement Frankfurter**

Create `apps/api/src/lib/market-data/providers/frankfurter.ts`:

```ts
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
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd apps/api && bun test src/lib/market-data/providers/frankfurter.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/market-data/types.ts apps/api/src/lib/market-data/endpoints.ts apps/api/src/lib/market-data/providers/frankfurter.ts apps/api/src/lib/market-data/providers/frankfurter.test.ts
git commit -m "feat(api): market-data provider types + Frankfurter FX adapter"
```

---

## Task 4: Yahoo provider (price + FX + ISIN search)

**Files:**
- Create: `apps/api/src/lib/market-data/providers/yahoo.ts`
- Test: `apps/api/src/lib/market-data/providers/yahoo.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/lib/market-data/providers/yahoo.test.ts`:

```ts
import { expect, test, afterEach } from "bun:test";
import { endpoints } from "../endpoints";
import { makeYahooPriceProvider, makeYahooFxProvider } from "./yahoo";
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
    // chart: highest-score symbol wins
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
    expect(url.pathname.endsWith("/search")).toBe(false); // never searches
    return { chart: { result: [{ meta: { regularMarketPrice: 10, currency: "USD", regularMarketTime: 1_750_000_000 } }] } };
  });
  try {
    const inst: InstrumentRef = { symbol: "D05.SI", isin: null, currency: "SGD", kind: "stock" };
    const r = await makeYahooPriceProvider().fetchPrice(inst);
    expect(r?.price).toBe(10);
  } finally { server.stop(true); }
});

test("ambiguous non-USD symbol with no suffix and no ISIN is unsupported", async () => {
  const inst: InstrumentRef = { symbol: "FOO", isin: null, currency: "SGD", kind: "stock" };
  // currency SGD has a suffix rule (.SI), so this resolves; use a currency with no rule:
  const noRule: InstrumentRef = { symbol: "FOO", isin: null, currency: "CHF", kind: "stock" };
  expect(await makeYahooPriceProvider().fetchPrice(noRule)).toBeNull();
  void inst;
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && bun test src/lib/market-data/providers/yahoo.test.ts`
Expected: FAIL — `Cannot find module './yahoo'`.

- [ ] **Step 3: Implement Yahoo**

Create `apps/api/src/lib/market-data/providers/yahoo.ts`:

```ts
import { endpoints } from "../endpoints";
import type { InstrumentPriceProvider, FxRateProvider, InstrumentRef, PriceResult, FxResult } from "../types";

// Yahoo blocks the default fetch UA; send a browser-like one.
const HEADERS = { "User-Agent": "Mozilla/5.0" };

// currency → Yahoo exchange suffix, used only when the symbol has no suffix and no
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

function isoFromEpoch(sec: number | undefined): string {
  return new Date((sec ?? 0) * 1000).toISOString().slice(0, 10);
}

async function chartFetch(fetchImpl: typeof fetch, sym: string, query: string): Promise<Chart["chart"] extends infer C ? NonNullable<C>["result"] extends infer R ? R extends Array<infer E> ? E | null : null : null : null> {
  const res = await fetchImpl(`${endpoints.yahooChart}/${encodeURIComponent(sym)}?${query}`, { headers: HEADERS });
  if (!res.ok) return null;
  const body = await res.json() as Chart;
  return body.chart?.result?.[0] ?? null;
}

export function makeYahooPriceProvider(fetchImpl: typeof fetch = fetch): InstrumentPriceProvider {
  // Memoize ISIN/symbol → resolved Yahoo symbol for the lifetime of this provider
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
      return suffix ? `${inst.symbol}${suffix}` : null;         // ambiguous → unsupported
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
```

> Note: the `chartFetch` return type above is awkward. If tsgo complains, simplify its signature to `Promise<NonNullable<NonNullable<Chart["chart"]>["result"]>[number] | null>` — i.e. extract the element type explicitly. Define a named type:
> ```ts
> type ChartResult = NonNullable<NonNullable<Chart["chart"]>["result"]>[number];
> async function chartFetch(fetchImpl: typeof fetch, sym: string, query: string): Promise<ChartResult | null> { ... }
> ```
> Use this named-type version; it is the intended form. (Replace the inline conditional-type signature with it.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && bun test src/lib/market-data/providers/yahoo.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/market-data/providers/yahoo.ts apps/api/src/lib/market-data/providers/yahoo.test.ts
git commit -m "feat(api): Yahoo price + FX adapter with ISIN search resolution"
```

---

## Task 5: Alpha Vantage provider (keyed price)

**Files:**
- Create: `apps/api/src/lib/market-data/providers/alphavantage.ts`
- Test: `apps/api/src/lib/market-data/providers/alphavantage.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/lib/market-data/providers/alphavantage.test.ts`:

```ts
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
  const big: Record<string, Record<string, string>> = {};
  for (let d = 1; d <= 200; d++) {
    const day = String(d).padStart(2, "0");
    big[`2026-01-${day > "28" ? "28" : day}`] = { "4. close": String(100 + d) };
  }
  // Use distinct dates across two months to exceed the cap.
  const series: Record<string, Record<string, string>> = {};
  for (let i = 0; i < 150; i++) {
    const date = new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
    series[date] = { "4. close": String(100 + i) };
  }
  const server = mock(() => ({ "Time Series (Daily)": series }));
  try {
    const s = await makeAlphaVantageProvider("KEY").fetchPriceSeries!(stock, "2025-01-01", "2025-12-31");
    expect(s).not.toBeNull();
    expect(s!.length).toBeLessThanOrEqual(100); // capped/spaced
    expect(s!.length).toBeGreaterThan(1);
    // sorted ascending
    expect(s![0].date < s![s!.length - 1].date).toBe(true);
  } finally { server.stop(true); }
  void big;
});

test("rate-limit note (no Global Quote) returns null", async () => {
  const server = mock(() => ({ Information: "rate limited" }));
  try {
    expect(await makeAlphaVantageProvider("KEY").fetchPrice(stock)).toBeNull();
  } finally { server.stop(true); }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && bun test src/lib/market-data/providers/alphavantage.test.ts`
Expected: FAIL — `Cannot find module './alphavantage'`.

- [ ] **Step 3: Implement Alpha Vantage**

Create `apps/api/src/lib/market-data/providers/alphavantage.ts`:

```ts
import { endpoints } from "../endpoints";
import { spaceSeries } from "../spacing";
import type { InstrumentPriceProvider, InstrumentRef, PriceResult } from "../types";

// Alpha Vantage free tier caps daily history depth; cap + space the series so it
// still spans the full requested range (sparse but complete).
const MAX_POINTS = 100;

// AV has no ISIN lookup and uses bare/suffixed tickers. ISIN-only instruments are
// unsupported (resolve to null → resolver advances to the next provider).
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && bun test src/lib/market-data/providers/alphavantage.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/market-data/providers/alphavantage.ts apps/api/src/lib/market-data/providers/alphavantage.test.ts
git commit -m "feat(api): Alpha Vantage keyed price adapter with spacing"
```

---

## Task 6: Resolver (probe-then-series chains)

**Files:**
- Create: `apps/api/src/lib/market-data/resolver.ts`
- Test: `apps/api/src/lib/market-data/resolver.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/lib/market-data/resolver.test.ts`:

```ts
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

test("latest: all fail → null", async () => {
  const got = await resolvePriceLatest([priceProvider("a", { price: null })], inst);
  expect(got).toBeNull();
});

test("series: probe must pass before series; skips providers without series", async () => {
  // a: has series but probe (fetchPrice) returns null → skipped
  // b: no series method → skipped
  // c: probe ok + series → wins
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && bun test src/lib/market-data/resolver.test.ts`
Expected: FAIL — `Cannot find module './resolver'`.

- [ ] **Step 3: Implement the resolver**

Create `apps/api/src/lib/market-data/resolver.ts`:

```ts
import type { InstrumentPriceProvider, FxRateProvider, InstrumentRef, PriceResult, FxResult } from "./types";

export async function resolvePriceLatest(
  chain: InstrumentPriceProvider[],
  inst: InstrumentRef,
): Promise<{ result: PriceResult; source: string } | null> {
  for (const p of chain) {
    try {
      const r = await p.fetchPrice(inst);
      if (r) return { result: r, source: p.name };
    } catch { /* advance */ }
  }
  return null;
}

export async function resolvePriceSeries(
  chain: InstrumentPriceProvider[],
  inst: InstrumentRef,
  start: string,
  end: string,
): Promise<{ result: PriceResult[]; source: string } | null> {
  for (const p of chain) {
    if (!p.fetchPriceSeries) continue;
    try {
      const probe = await p.fetchPrice(inst); // cheap symbol/format validation
      if (!probe) continue;
      const series = await p.fetchPriceSeries(inst, start, end);
      if (series && series.length > 0) return { result: series, source: p.name };
    } catch { /* advance */ }
  }
  return null;
}

export async function resolveFxLatest(
  chain: FxRateProvider[],
  currency: string,
  base: string,
): Promise<{ result: FxResult; source: string } | null> {
  for (const p of chain) {
    try {
      const r = await p.fetchRate(currency, base);
      if (r) return { result: r, source: p.name };
    } catch { /* advance */ }
  }
  return null;
}

export async function resolveFxSeries(
  chain: FxRateProvider[],
  currency: string,
  base: string,
  start: string,
  end: string,
): Promise<{ result: FxResult[]; source: string } | null> {
  for (const p of chain) {
    if (!p.fetchRateSeries) continue;
    try {
      const probe = await p.fetchRate(currency, base);
      if (!probe) continue;
      const series = await p.fetchRateSeries(currency, base, start, end);
      if (series && series.length > 0) return { result: series, source: p.name };
    } catch { /* advance */ }
  }
  return null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && bun test src/lib/market-data/resolver.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/market-data/resolver.ts apps/api/src/lib/market-data/resolver.test.ts
git commit -m "feat(api): market-data resolver chains (probe-then-series)"
```

---

## Task 7: Refresh orchestration

**Files:**
- Create: `apps/api/src/lib/market-data/index.ts`
- Test: `apps/api/src/lib/market-data/index.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/lib/market-data/index.test.ts`:

```ts
import { expect, test, beforeEach } from "bun:test";
import { resetDb } from "../test-helpers";
import { db } from "../../db/client";
import { instruments, prices, fxRates, accounts, settings } from "../../db/schema";
import { createId, nowEpoch } from "../ids";
import { refreshInstrumentPrice, refreshFx } from "./index";
import type { InstrumentPriceProvider, FxRateProvider } from "./types";

beforeEach(resetDb);

const fakePrice: InstrumentPriceProvider = {
  name: "fake",
  async fetchPrice() { return { price: 100, currency: "USD", date: "2026-06-15" }; },
  async fetchPriceSeries() {
    return [
      { price: 90, currency: "USD", date: "2026-06-10" },
      { price: 100, currency: "USD", date: "2026-06-15" },
    ];
  },
};

async function seedInstrument(kind = "stock"): Promise<string> {
  const id = createId();
  await db.insert(instruments).values({ id, symbol: "X", isin: null, name: "X", kind: kind as "stock", currency: "USD", createdAt: nowEpoch() });
  return id;
}

test("latest refresh upserts today's row with the provider source", async () => {
  const id = await seedInstrument();
  const r = await refreshInstrumentPrice(id, undefined, [fakePrice]);
  expect(r.status).toBe("updated");
  expect(r.source).toBe("fake");
  const rows = await db.select().from(prices).where(eq(prices.instrumentId, id));
  expect(rows.length).toBe(1);
  expect(rows[0].priceScaled).toBe(100 * 1e8);
  expect(rows[0].source).toBe("fake");
});

test("backfill inserts a series but never overwrites an existing manual row", async () => {
  const id = await seedInstrument();
  // Pre-existing manual price on 2026-06-10
  await db.insert(prices).values({ id: createId(), instrumentId: id, date: "2026-06-10", priceScaled: 1, source: "manual", createdAt: nowEpoch() });
  const r = await refreshInstrumentPrice(id, { backfill: true, from: "2026-06-01" }, [fakePrice]);
  expect(r.status).toBe("updated");
  expect(r.rowsWritten).toBe(1); // only 2026-06-15 is new
  const manual = (await db.select().from(prices).where(and(eq(prices.instrumentId, id), eq(prices.date, "2026-06-10"))))[0];
  expect(manual.priceScaled).toBe(1);     // untouched
  expect(manual.source).toBe("manual");
});

test("currency instruments are skipped", async () => {
  const id = await seedInstrument("currency");
  const r = await refreshInstrumentPrice(id, undefined, [fakePrice]);
  expect(r.status).toBe("skipped");
});

test("refreshFx writes base-per-foreign for in-use currencies", async () => {
  await db.insert(settings).values({ id: 1, householdName: "H", baseCurrency: "USD", createdAt: nowEpoch() });
  await db.insert(accounts).values({ id: createId(), name: "A", class: "asset", subtype: "cash", currency: "SGD", createdAt: nowEpoch(), createdBy: "x" });
  const fakeFx: FxRateProvider = { name: "fx", async fetchRate() { return { rate: 0.74, date: "2026-06-15" }; } };
  const summary = await refreshFx(undefined, [fakeFx]);
  expect(summary.updated).toBe(1);
  const rows = await db.select().from(fxRates);
  expect(rows[0].currency).toBe("SGD");
  expect(rows[0].rateScaled).toBe(Math.round(0.74 * 1e8));
  expect(rows[0].source).toBe("fx");
});
```

Add the missing drizzle imports at the top of the test:

```ts
import { and, eq } from "drizzle-orm";
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && bun test src/lib/market-data/index.test.ts`
Expected: FAIL — `Cannot find module './index'`.

- [ ] **Step 3: Implement the orchestration**

Create `apps/api/src/lib/market-data/index.ts`:

```ts
import { db } from "../../db/client";
import { instruments, prices, fxRates, accounts } from "../../db/schema";
import { and, eq, min } from "drizzle-orm";
import { SCALE } from "@uang/shared";
import { createId, nowEpoch } from "../ids";
import { getSettings } from "../settings";
import { transactions } from "../../db/schema";
import { makeYahooPriceProvider, makeYahooFxProvider } from "./providers/yahoo";
import { makeFrankfurterProvider } from "./providers/frankfurter";
import { makeAlphaVantageProvider } from "./providers/alphavantage";
import { resolvePriceLatest, resolvePriceSeries, resolveFxLatest, resolveFxSeries } from "./resolver";
import type { InstrumentPriceProvider, FxRateProvider, InstrumentRef } from "./types";

const S = Number(SCALE);
const scale = (n: number) => Math.round(n * S);
const today = (): string => new Date().toISOString().slice(0, 10);

export type RefreshRange = { from?: string; to?: string; backfill?: boolean };
export type RefreshResult = { status: "updated" | "unsupported" | "failed" | "skipped"; source?: string; rowsWritten: number };
export type RefreshSummary = {
  updated: number; unsupported: number; failed: number; rowsWritten: number;
  details: Array<{ id: string; name: string; status: RefreshResult["status"]; source?: string; rows: number }>;
};

// ---- chain builders ----

export async function buildPriceChain(): Promise<InstrumentPriceProvider[]> {
  const s = await getSettings();
  const chain: InstrumentPriceProvider[] = [makeYahooPriceProvider()];
  if (s?.marketDataApiKey) chain.push(makeAlphaVantageProvider(s.marketDataApiKey));
  return chain;
}

export function buildFxChain(): FxRateProvider[] {
  return [makeFrankfurterProvider(), makeYahooFxProvider()];
}

// ---- upsert helpers ----

async function upsertLatestPrice(instrumentId: string, date: string, priceScaled: number, source: string): Promise<void> {
  await db.insert(prices)
    .values({ id: createId(), instrumentId, date, priceScaled, source, createdAt: nowEpoch() })
    .onConflictDoUpdate({ target: [prices.instrumentId, prices.date], set: { priceScaled, source } });
}

async function insertPriceIfAbsent(instrumentId: string, date: string, priceScaled: number, source: string): Promise<boolean> {
  const [existing] = await db.select({ id: prices.id }).from(prices).where(and(eq(prices.instrumentId, instrumentId), eq(prices.date, date)));
  if (existing) return false;
  await db.insert(prices).values({ id: createId(), instrumentId, date, priceScaled, source, createdAt: nowEpoch() });
  return true;
}

async function upsertLatestFx(currency: string, date: string, rateScaled: number, source: string): Promise<void> {
  await db.insert(fxRates)
    .values({ id: createId(), currency, date, rateScaled, source, createdAt: nowEpoch() })
    .onConflictDoUpdate({ target: [fxRates.currency, fxRates.date], set: { rateScaled, source } });
}

async function insertFxIfAbsent(currency: string, date: string, rateScaled: number, source: string): Promise<boolean> {
  const [existing] = await db.select({ id: fxRates.id }).from(fxRates).where(and(eq(fxRates.currency, currency), eq(fxRates.date, date)));
  if (existing) return false;
  await db.insert(fxRates).values({ id: createId(), currency, date, rateScaled, source, createdAt: nowEpoch() });
  return true;
}

// Earliest transaction date for an instrument (or across all transactions if no id).
async function earliestTxnDate(instrumentId?: string): Promise<string | null> {
  const q = db.select({ d: min(transactions.date) }).from(transactions);
  const rows = instrumentId ? await q.where(eq(transactions.instrumentId, instrumentId)) : await q;
  return rows[0]?.d ?? null;
}

// ---- price refresh ----

export async function refreshInstrumentPrice(
  instrumentId: string,
  range?: RefreshRange,
  chain?: InstrumentPriceProvider[],
): Promise<RefreshResult> {
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!inst) return { status: "failed", rowsWritten: 0 };
  if (inst.kind === "currency") return { status: "skipped", rowsWritten: 0 };

  const providers = chain ?? (await buildPriceChain());
  const ref: InstrumentRef = {
    symbol: inst.symbol, isin: inst.isin, currency: inst.currency,
    kind: inst.kind === "currency" ? "other" : inst.kind,
  };

  const isBackfill = !!(range?.from || range?.backfill);
  try {
    if (isBackfill) {
      const start = range?.from ?? (await earliestTxnDate(instrumentId));
      if (!start) {
        // No history anchor — fall back to a latest refresh.
        return refreshInstrumentPrice(instrumentId, undefined, providers);
      }
      const end = range?.to ?? today();
      const got = await resolvePriceSeries(providers, ref, start, end);
      if (!got) return { status: "unsupported", rowsWritten: 0 };
      let rows = 0;
      for (const pt of got.result) {
        if (await insertPriceIfAbsent(instrumentId, pt.date, scale(pt.price), got.source)) rows++;
      }
      return { status: "updated", source: got.source, rowsWritten: rows };
    }
    const got = await resolvePriceLatest(providers, ref);
    if (!got) return { status: "unsupported", rowsWritten: 0 };
    await upsertLatestPrice(instrumentId, got.result.date, scale(got.result.price), got.source);
    return { status: "updated", source: got.source, rowsWritten: 1 };
  } catch {
    return { status: "failed", rowsWritten: 0 };
  }
}

export async function refreshAllPrices(range?: RefreshRange, chain?: InstrumentPriceProvider[]): Promise<RefreshSummary> {
  const providers = chain ?? (await buildPriceChain());
  const list = await db.select().from(instruments);
  const summary: RefreshSummary = { updated: 0, unsupported: 0, failed: 0, rowsWritten: 0, details: [] };
  for (const inst of list) {
    if (inst.kind === "currency") continue;
    const r = await refreshInstrumentPrice(inst.id, range, providers);
    if (r.status === "skipped") continue;
    if (r.status === "updated") summary.updated++;
    else if (r.status === "unsupported") summary.unsupported++;
    else summary.failed++;
    summary.rowsWritten += r.rowsWritten;
    summary.details.push({ id: inst.id, name: inst.name, status: r.status, source: r.source, rows: r.rowsWritten });
  }
  return summary;
}

// ---- fx refresh ----

async function currenciesInUse(base: string): Promise<string[]> {
  const a = await db.selectDistinct({ c: accounts.currency }).from(accounts);
  const i = await db.selectDistinct({ c: instruments.currency }).from(instruments);
  const set = new Set<string>();
  for (const r of [...a, ...i]) if (r.c && r.c !== base) set.add(r.c);
  return [...set];
}

export async function refreshFx(range?: RefreshRange, chain?: FxRateProvider[]): Promise<RefreshSummary> {
  const s = await getSettings();
  const base = s?.baseCurrency ?? "USD";
  const providers = chain ?? buildFxChain();
  const currencies = await currenciesInUse(base);
  const summary: RefreshSummary = { updated: 0, unsupported: 0, failed: 0, rowsWritten: 0, details: [] };

  const isBackfill = !!(range?.from || range?.backfill);
  for (const cur of currencies) {
    try {
      if (isBackfill) {
        const start = range?.from ?? (await earliestTxnDate());
        const end = range?.to ?? today();
        const got = start ? await resolveFxSeries(providers, cur, base, start, end) : null;
        if (!got) { summary.unsupported++; summary.details.push({ id: cur, name: cur, status: "unsupported", rows: 0 }); continue; }
        let rows = 0;
        for (const pt of got.result) if (await insertFxIfAbsent(cur, pt.date, scale(pt.rate), got.source)) rows++;
        summary.updated++; summary.rowsWritten += rows;
        summary.details.push({ id: cur, name: cur, status: "updated", source: got.source, rows });
      } else {
        const got = await resolveFxLatest(providers, cur, base);
        if (!got) { summary.unsupported++; summary.details.push({ id: cur, name: cur, status: "unsupported", rows: 0 }); continue; }
        await upsertLatestFx(cur, got.result.date, scale(got.result.rate), got.source);
        summary.updated++; summary.rowsWritten += 1;
        summary.details.push({ id: cur, name: cur, status: "updated", source: got.source, rows: 1 });
      }
    } catch {
      summary.failed++; summary.details.push({ id: cur, name: cur, status: "failed", rows: 0 });
    }
  }
  return summary;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && bun test src/lib/market-data/index.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/market-data/index.ts apps/api/src/lib/market-data/index.test.ts
git commit -m "feat(api): market-data refresh orchestration (price + fx, latest + backfill)"
```

---

## Task 8: Routes + app mount

**Files:**
- Create: `apps/api/src/routes/market-data.ts`
- Modify: `apps/api/src/app.ts:21-52`
- Test: `apps/api/src/routes/market-data.test.ts`

- [ ] **Step 1: Implement the routes**

Create `apps/api/src/routes/market-data.ts`:

```ts
import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { settings } from "../db/schema";
import { eq } from "drizzle-orm";
import { authGuard } from "../lib/auth-guard";
import { refreshInstrumentPrice, refreshAllPrices, refreshFx } from "../lib/market-data";
import { makeAlphaVantageProvider } from "../lib/market-data/providers/alphavantage";

const range = t.Optional(t.Object({
  from: t.Optional(t.String()),
  to: t.Optional(t.String()),
  backfill: t.Optional(t.Boolean()),
}));

export const marketDataRoutes = new Elysia({ prefix: "/market-data" })
  .use(authGuard)
  .post("/instrument/:id/refresh", async ({ params, body }: any) =>
    refreshInstrumentPrice(params.id, body ?? undefined), { body: range })
  .post("/instruments/refresh", async ({ body }: any) =>
    refreshAllPrices(body ?? undefined), { body: range })
  .post("/fx/refresh", async ({ body }: any) =>
    refreshFx(body ?? undefined), { body: range })
  .post("/test", async ({ isAdmin, set }: any) => {
    if (!isAdmin) { set.status = 403; return { error: "admin_only" }; }
    const s = (await db.select().from(settings).where(eq(settings.id, 1)))[0];
    if (!s?.marketDataApiKey) return { ok: false, message: "No Alpha Vantage key configured" };
    try {
      const r = await makeAlphaVantageProvider(s.marketDataApiKey)
        .fetchPrice({ symbol: "IBM", isin: null, currency: "USD", kind: "stock" });
      return r ? { ok: true } : { ok: false, message: "No data (rate-limited or invalid key)" };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : "request failed" };
    }
  });
```

- [ ] **Step 2: Mount in the app**

In `apps/api/src/app.ts`, add the import after line 21 (`import { pricesRoutes } ...`):

```ts
import { marketDataRoutes } from "./routes/market-data";
```

And add to the `createApiApp()` chain after `.use(pricesRoutes)`:

```ts
    .use(pricesRoutes)
    .use(marketDataRoutes)
    .use(groupsRoutes);
```

- [ ] **Step 3: Write the route test**

Create `apps/api/src/routes/market-data.test.ts`:

```ts
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

// Mock Yahoo (the default price-chain primary) so the route does no real network.
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
  expect((await res.json()).ok).toBe(false); // no key configured
});
```

- [ ] **Step 4: Run the route + full api tests**

Run: `cd apps/api && bun test src/routes/market-data.test.ts`
Expected: PASS (3 tests).

Run: `cd apps/api && bun test`
Expected: the whole API suite still passes.

- [ ] **Step 5: Typecheck the API surface (via web build)**

Run: `cd apps/web && bun run build`
Expected: build succeeds (tsgo strict-typechecks the shared API types). Fix any `as any` or type errors before continuing.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/market-data.ts apps/api/src/app.ts apps/api/src/routes/market-data.test.ts
git commit -m "feat(api): /market-data routes for on-demand price + fx refresh"
```

---

## Task 9: Settings UI — Market data provider section

**Files:**
- Modify: `apps/web/src/routes/settings.tsx`

- [ ] **Step 1: Add state + handlers**

In `apps/web/src/routes/settings.tsx`, inside `SettingsPage`, after the AI state block (after line 172 `const [aiTestMsg, setAiTestMsg] = useState("");`), add:

```ts
  // Market data provider (Alpha Vantage key)
  const [mdApiKey, setMdApiKey] = useState("");
  const [mdApiKeySet, setMdApiKeySet] = useState(false);
  const [mdTestMsg, setMdTestMsg] = useState("");
```

In the existing `useEffect` that seeds AI inputs (after line 190), add inside the `if (settingsData && "aiBaseUrl" in settingsData) {` block:

```ts
      setMdApiKeySet(!!(settingsData as { marketDataApiKeySet?: boolean }).marketDataApiKeySet);
```

After the `removeAi` function (after line 231), add:

```ts
  async function saveMarketData() {
    const payload: { marketDataApiKey?: string } = {};
    if (mdApiKey) payload.marketDataApiKey = mdApiKey;
    const { error } = await api.settings.patch(payload);
    if (error) { setMdTestMsg("Save failed"); return; }
    setMdApiKey("");
    setMdApiKeySet(mdApiKeySet || !!mdApiKey);
    setMdTestMsg("Saved");
    await qc.invalidateQueries({ queryKey: ["settings"] });
  }

  async function testMarketData() {
    setMdTestMsg("Testing…");
    const { data } = await api["market-data"].test.post();
    if (data && "ok" in data) {
      setMdTestMsg(data.ok ? "Connection ok" : `Failed: ${"message" in data && typeof data.message === "string" ? data.message : "error"}`);
    } else {
      setMdTestMsg("Failed: error");
    }
  }

  async function removeMarketData() {
    const { error } = await api.settings.patch({ clearMarketData: true });
    if (error) { setMdTestMsg("Couldn't remove the key"); return; }
    setMdApiKey(""); setMdApiKeySet(false); setMdTestMsg("Key removed");
    await qc.invalidateQueries({ queryKey: ["settings"] });
  }
```

- [ ] **Step 2: Add the Section to the JSX**

In the returned JSX, immediately after the AI `</Section>` (line 490) and before `<RestoreSection />`, insert:

```tsx
        <Section
          eyebrow="Market data"
          title="Market data provider"
          description="Optional. Prices come from Yahoo and FX from Frankfurter — both free, no key needed. Add an Alpha Vantage API key only to use it as a fallback for instruments Yahoo can't resolve."
        >
          <div className="grid gap-3 sm:max-w-lg">
            <Field
              label={
                <>
                  Alpha Vantage API key{" "}
                  {mdApiKeySet && (
                    <Label className="text-muted-foreground font-normal">
                      (set — leave blank to keep)
                    </Label>
                  )}
                </>
              }
            >
              <Input
                type="password"
                value={mdApiKey}
                onChange={(e) => setMdApiKey(e.target.value)}
                placeholder={mdApiKeySet ? "••••••••" : "optional"}
                data-testid="md-api-key"
              />
            </Field>
            <div className="flex items-center gap-2">
              <Button onClick={saveMarketData} data-testid="md-save">Save</Button>
              <Button variant="outline" onClick={testMarketData} data-testid="md-test">
                Test connection
              </Button>
              {mdApiKeySet && (
                <Button
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={() => confirm({
                    title: "Remove Alpha Vantage key?",
                    description: "This deletes the stored key. Instrument prices will use Yahoo only.",
                    confirmLabel: "Remove",
                    onConfirm: removeMarketData,
                  })}
                  data-testid="md-remove"
                >
                  Remove
                </Button>
              )}
              {mdTestMsg && <span className="text-sm text-muted-foreground">{mdTestMsg}</span>}
            </div>
          </div>
        </Section>
```

- [ ] **Step 3: Typecheck/build**

Run: `cd apps/web && bun run build`
Expected: build succeeds. If `api["market-data"]` is not typed, re-check Task 8 mounted `marketDataRoutes` in `createApiApp()`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/settings.tsx
git commit -m "feat(web): Market data provider settings section (Alpha Vantage key)"
```

---

## Task 10: Instrument detail — Refresh + Backfill buttons

**Files:**
- Modify: `apps/web/src/routes/instrument-detail.tsx`

- [ ] **Step 1: Add refresh state + handler**

In `apps/web/src/routes/instrument-detail.tsx`, after the edit-form state (after line 65 `const [kind, setKind] = useState("");`), add:

```ts
  const [refreshMsg, setRefreshMsg] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  async function refreshPrice(backfill: boolean) {
    setRefreshing(true);
    setRefreshMsg(backfill ? "Backfilling…" : "Refreshing…");
    const { data, error } = await api["market-data"].instrument({ id }).refresh.post(backfill ? { backfill: true } : {});
    if (error || !data) { setRefreshMsg("Failed"); setRefreshing(false); return; }
    if (data.status === "updated") setRefreshMsg(`Updated · ${data.rowsWritten} row(s) · ${data.source ?? ""}`);
    else if (data.status === "unsupported") setRefreshMsg("No free source for this symbol");
    else setRefreshMsg("Failed");
    await pricesCollection(id).utils.refetch();
    await qc.invalidateQueries({ queryKey: ["instrument", id] });
    await qc.invalidateQueries({ queryKey: ["instruments"] });
    await qc.invalidateQueries({ queryKey: ["networth"] });
    setRefreshing(false);
  }
```

> Note: `pricesCollection(id).utils.refetch()` re-pulls the price list. If `.utils.refetch` is unavailable on the collection type, use `await qc.invalidateQueries({ queryKey: ["prices", id] })` instead (the query-db collection is keyed by `["prices", id]`).

- [ ] **Step 2: Add the buttons to the Price history header**

In the Price history section, replace the header `div` (lines 159-162) with:

```tsx
          <div className="mb-3 flex items-center justify-between gap-2">
            <Eyebrow>Price history</Eyebrow>
            <div className="flex items-center gap-2">
              {refreshMsg && <span className="text-xs text-muted-foreground">{refreshMsg}</span>}
              <Button variant="outline" size="sm" disabled={refreshing} onClick={() => refreshPrice(false)} data-testid="refresh-price">
                Refresh price
              </Button>
              <Button variant="outline" size="sm" disabled={refreshing} onClick={() => refreshPrice(true)} data-testid="backfill-price">
                Backfill history
              </Button>
              <UpdatePrice instrumentId={id} label="Add price" />
            </div>
          </div>
```

- [ ] **Step 3: Build**

Run: `cd apps/web && bun run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/instrument-detail.tsx
git commit -m "feat(web): refresh + backfill price buttons on instrument detail"
```

---

## Task 11: Instruments list — Refresh all / Refresh FX

**Files:**
- Modify: `apps/web/src/routes/instruments.tsx`

- [ ] **Step 1: Add imports + state + handlers**

Replace the import block (lines 1-6) and add the hooks. New imports:

```tsx
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/app-layout";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { instrumentsCollection } from "@/lib/collections";
import { api } from "@/lib/api";
import { SCALE } from "@uang/shared";
```

Inside `InstrumentsPage`, after the `rows` line (line 18), add:

```tsx
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function refreshAll(backfill: boolean) {
    setBusy(true); setMsg(backfill ? "Backfilling prices…" : "Refreshing prices…");
    const { data } = await api["market-data"].instruments.refresh.post(backfill ? { backfill: true } : {});
    if (data && "updated" in data) setMsg(`Prices: ${data.updated} updated · ${data.unsupported} unsupported · ${data.failed} failed · ${data.rowsWritten} rows`);
    else setMsg("Prices: failed");
    await qc.invalidateQueries({ queryKey: ["instruments"] });
    await qc.invalidateQueries({ queryKey: ["networth"] });
    setBusy(false);
  }

  async function refreshFx(backfill: boolean) {
    setBusy(true); setMsg(backfill ? "Backfilling FX…" : "Refreshing FX…");
    const { data } = await api["market-data"].fx.refresh.post(backfill ? { backfill: true } : {});
    if (data && "updated" in data) setMsg(`FX: ${data.updated} updated · ${data.unsupported} unsupported · ${data.failed} failed · ${data.rowsWritten} rows`);
    else setMsg("FX: failed");
    await qc.invalidateQueries({ queryKey: ["fx"] });
    await qc.invalidateQueries({ queryKey: ["networth"] });
    setBusy(false);
  }
```

- [ ] **Step 2: Add the toolbar under the header**

Immediately after `<PageHeader eyebrow="Holdings" title="Instruments" />` (line 22), insert:

```tsx
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => refreshAll(false)} data-testid="refresh-all-prices">
          Refresh all prices
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => refreshAll(true)}>
          Backfill prices
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => refreshFx(false)} data-testid="refresh-fx">
          Refresh FX
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => refreshFx(true)}>
          Backfill FX
        </Button>
        {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
      </div>
```

- [ ] **Step 3: Build**

Run: `cd apps/web && bun run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/instruments.tsx
git commit -m "feat(web): refresh-all prices + FX buttons on instruments page"
```

---

## Task 12: End-of-slice verification

**Files:** none (verification only)

- [ ] **Step 1: Full API test suite**

Run: `cd apps/api && bun test`
Expected: all pass.

- [ ] **Step 2: Web build (strict typecheck)**

Run: `cd apps/web && bun run build`
Expected: success, no `as any`.

- [ ] **Step 3: Affected E2E (if instruments/settings specs exist)**

Run: `bun run e2e -- instruments.spec.ts settings.spec.ts`
(Adjust to the actual spec names in `e2e/`; see `e2e/README.md`. If no such specs exist, skip and note it.)
Expected: pass.

- [ ] **Step 4: Manual smoke (optional, requires an AV key + network)**

Start the app, open an instrument with an ISIN (e.g. the Amundi fund `LU2420245917`), click "Refresh price" → expect a Yahoo-sourced SGD price row. Click "Backfill history" → expect multiple rows. On Settings, paste an Alpha Vantage key, Save, Test connection.

---

## Self-Review (completed during planning)

- **Spec coverage:** provider abstraction (Task 3), Frankfurter/Yahoo/Alpha Vantage adapters (3/4/5), ISIN→Yahoo-search resolution (4), Yahoo-primary price chain (7 `buildPriceChain`), probe-then-series + spacing (6/2/5), latest vs backfill insert-if-absent (7), `/market-data` routes incl. `/test` (8), `fx_rates.source` + `settings.marketDataApiKey` (1), Settings UI key section mirroring AI pattern (9), refresh/backfill UI (10/11). All spec sections map to a task.
- **Type consistency:** `RefreshRange`/`RefreshResult`/`RefreshSummary` defined in Task 7 are the shapes consumed by routes (8) and web (10/11). Provider interface (`fetchPrice`/`fetchPriceSeries`/`fetchRate`/`fetchRateSeries`) consistent across Tasks 3-7. `endpoints` table used identically in adapters and tests.
- **Placeholders:** none — every code step is complete. External JSON uses specific-type assertions, never `as any`; route context uses the sanctioned `({ ... }: any)` convention only.
- **Known follow-up (documented, not a gap):** backfill default-start is computed server-side from the earliest transaction date (refinement over the spec's client-side computation) — simpler and keeps the web layer from needing transaction dates.
