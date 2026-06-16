# Market data providers — instrument prices & FX from free APIs — design

Date: 2026-06-16

## Problem

Instrument prices and FX rates are entirely manual today. Prices come from manual entry
(`prices.source = "manual"`) or are seeded from trades (`source = "trade"`); FX rates are
manually entered into `fx_rates`. There is no way to pull indicative prices or rates from an
external source. We want to fetch **indicative** prices and FX rates from **free** data
sources, on demand, without committing to a single vendor — both the latest value and a
historical series to backfill past dates.

## Goals / non-goals

- **Goal:** fetch indicative instrument prices and FX rates from free providers, triggered
  on demand from the UI, writing into the existing `prices` / `fx_rates` tables.
- **Goal:** provider-agnostic abstraction — providers are swappable and resolved through an
  ordered fallback chain.
- **Goal:** **historical backfill** — fetch a date-range series (not just today's value) so
  past net-worth chart points and as-of FX conversions become accurate. Both a "latest"
  (single today row) and a "backfill range" mode are supported.
- **Non-goal:** real-time / tick data, scheduled background jobs.
- **Non-goal:** covering instruments with no public ticker (e.g. Singapore unit trusts /
  Endowus funds). Those remain manual and are reported as "unsupported".

## Decisions (from brainstorming)

- **Trigger:** on-demand only (UI buttons). No scheduler / cron / background worker.
- **Providers:**
  - **FX chain:** Frankfurter (primary, no key, ECB-backed) → Yahoo (fallback).
  - **Price chain:** **Yahoo (primary, no key)** → Alpha Vantage (keyed alternative). Yahoo
    has far broader free coverage — including ISIN-identified UCITS/Endowus funds that Alpha
    Vantage doesn't index (validated against `LU2420245917`, found on Yahoo, absent on AV).
    Alpha Vantage is the keyed alternative for symbols Yahoo lacks; if no AV key is configured
    the chain is simply Yahoo-only and the app works with zero config.
- **Provider-agnostic:** all fetching goes through interfaces + an ordered resolver, so a
  provider can be swapped or reordered in one place.
- **Symbol mapping:** one canonical instrument identity (`symbol` and/or `isin`); each
  provider adapter resolves it to that provider's convention. **ISIN-first for Yahoo:** when an
  instrument has an `isin`, the Yahoo adapter resolves it via Yahoo's search endpoint
  (`/v1/finance/search?q=<isin>`, best-scored match) → e.g. `LU2420245917` →
  `0P0001OO2D.SI`. Only without an ISIN does it fall back to `symbol` + a currency-derived
  suffix. Untranslatable → "unsupported".
- **Latest vs backfill:** a refresh with no date range writes one row dated today
  (overwriting today's row — most current). A refresh with a date range fetches a series and
  **inserts only missing dates** (never clobbers existing manual/trade/earlier-fetched rows).
- **Gaps/weekends:** providers return trading days only; we do not synthesize weekend/holiday
  rows. Valuation already carries the latest price/rate ≤ date forward, so gaps are fine.
- **Probe before series:** a backfill first fires a cheap single-point request (the provider's
  `fetchPrice`/latest call) to validate the translated symbol returns 2xx before requesting the
  heavier time series. A failed probe means the symbol format is wrong / unsupported for that
  provider, so the resolver advances to the next without spending a large request.
- **Spacing for depth-limited sources:** when a provider caps history (e.g. Alpha Vantage),
  don't take its dense *recent* window; fetch the widest available range and **downsample to
  evenly-spaced points spanning [earliest transaction, now]** (weekly/monthly cadence sized to
  the budget). Carry-forward valuation tolerates the lower resolution, so the whole history is
  covered instead of only the last few months. Unlimited sources (Yahoo, Frankfurter) return
  their natural daily series.
- **API key storage:** Alpha Vantage key lives in app Settings (a new "Market data
  provider" section), mirroring the existing AI-provider key pattern. **Not** `.env`.
- **Provenance:** every written row records which provider answered, in `source`.

## Architecture overview

```
apps/api/src/lib/market-data/
  types.ts          # FxRateProvider, InstrumentPriceProvider, result types
  resolver.ts       # ordered-chain resolution + provider-name tracking
  providers/
    frankfurter.ts  # FX, no key
    yahoo.ts        # FX pairs + instrument quote, no key
    alphavantage.ts # instrument quote, keyed (key from settings)
  index.ts          # builds the chains from current settings
```

Routes call the resolver, which walks the chain and returns the first non-null result tagged
with the answering provider's `name`. That name becomes the `source` on the written row.

## Section 1 — Provider abstraction (API)

```ts
export interface InstrumentRef {
  symbol: string | null;
  isin: string | null;
  currency: string;
  kind: "stock" | "etf" | "fund" | "crypto" | "other"; // never "currency" here
}

export interface PriceResult {
  price: number;        // in the instrument's own currency
  currency: string;     // provider-reported quote currency
  date: string;         // YYYY-MM-DD
}

export interface FxResult {
  rate: number;         // 1 `from` major = rate `to` major
  date: string;         // YYYY-MM-DD
}

export interface InstrumentPriceProvider {
  name: string;                              // "yahoo" | "alphavantage"
  // Resolve the instrument to this provider's symbol. Async because Yahoo resolves
  // an ISIN via its search endpoint. null => unsupported for this provider.
  resolveSymbol(inst: InstrumentRef): Promise<string | null>;
  fetchPrice(inst: InstrumentRef): Promise<PriceResult | null>;            // latest
  // Historical series over [start, end] (YYYY-MM-DD), trading days only.
  // Optional capability: providers that can't serve history omit it.
  fetchPriceSeries?(inst: InstrumentRef, start: string, end: string): Promise<PriceResult[] | null>;
}

export interface FxRateProvider {
  name: string;                              // "frankfurter" | "yahoo"
  fetchRate(from: string, to: string): Promise<FxResult | null>;          // latest
  fetchRateSeries?(from: string, to: string, start: string, end: string): Promise<FxResult[] | null>;
}
```

**Resolver semantics:** walk the chain in order; a provider returning `null` (unsupported /
not found) or throwing (network / parse error) advances to the next. The resolver returns
`{ result, providerName } | null`. Errors are caught per-provider and do not abort the chain.
A provider that throws is logged but treated like a `null` for control flow.

**Series resolution:** for backfill, the resolver only considers providers that implement the
`*Series` method; a provider lacking it (or returning `null`) is skipped to the next in the
chain. The whole range is served by the **first** provider that returns a non-empty series —
results are not stitched across providers (keeps provenance clean: one `source` per backfill).
Provider series support: Frankfurter (FX) ✓, Yahoo (FX + price) ✓, Alpha Vantage (price) ✓
(free-tier limited — see limitations).

**Probe-then-series:** for each candidate provider the resolver first calls the cheap
single-point method (`fetchPrice` / `fetchRate`) as a **symbol/format probe**. A non-2xx or
empty probe → the translated symbol is wrong/unsupported for that provider → advance to the
next without issuing the large series request. Only on a successful probe does it call
`fetchPriceSeries` / `fetchRateSeries`. This validates the per-adapter symbol translation
cheaply and fails fast in the bulk path.

**Spacing (depth-limited providers):** an adapter whose source caps history declares a
`maxPoints` (e.g. Alpha Vantage ≈ 100). Its `*Series` requests the widest available range,
then **downsamples to ≤ `maxPoints` evenly-spaced dates across `[start, end]`** (the requested
range = earliest transaction → today) rather than returning the dense tail. A small shared
helper does the spacing so adapters stay thin. Providers with no cap return the full daily
series and ignore spacing.

**Symbol resolution** (each adapter's `resolveSymbol`), in priority order:
1. **ISIN via search (Yahoo).** If the instrument has an `isin`, the Yahoo adapter calls
   `/v1/finance/search?q=<isin>` and takes the best-scored `isYahooFinance` quote
   (e.g. `LU2420245917` → `0P0001OO2D.SI`). This is what makes ISIN-only fund holdings
   (Endowus etc.) resolvable. Alpha Vantage has no ISIN search, so for AV an ISIN-only
   instrument resolves to `null` (unsupported).
2. **Already provider-formatted symbol.** If `symbol` carries a known suffix (`.SI`, `.L`)
   or a crypto `-` (e.g. `BTC-USD`), pass it through.
3. **Symbol + default suffix.** Else derive from currency/kind: crypto →
   `"<SYMBOL>-<currency>"`; non-USD equity → currency-derived exchange suffix where
   unambiguous (SGD → `.SI` for Yahoo). Ambiguous (currency → multiple exchanges, no suffix)
   → `null` rather than guess.

A `null` from every price provider → the instrument is reported "unsupported" and left
manual. The user can always enter a fully-suffixed symbol which passes through unchanged.

**Resolution caching:** a Yahoo ISIN search is an extra network round-trip, so the resolved
provider symbol is memoized **in-memory for the duration of a refresh run** (keyed by
instrument id) — a bulk refresh searches each ISIN at most once. (Persisting the resolved
symbol on the instrument is a possible later optimization, out of scope here.)

## Section 2 — On-demand routes (`/market-data`)

A new route module `apps/api/src/routes/market-data.ts`, all operations grouped under
`/market-data`. Each refresh route accepts an **optional** body `{ from?: string, to?: string }`
(YYYY-MM-DD). Omitted → **latest mode** (one row, today). Present → **backfill mode** (series
over `[from, to]`, `to` defaulting to today).

- `POST /market-data/instrument/:id/refresh` — refresh one instrument.
  - 404 if instrument missing; no-op for `kind: "currency"` (price is implicitly 1.0).
  - Latest: resolve via price chain, upsert today's `prices` row.
  - Backfill: resolve the series via the price chain's `fetchPriceSeries`; insert-if-absent a
    `prices` row per returned date with `source = providerName`.
  - Returns `{ ok, status: "updated" | "unsupported" | "failed", count?, source?, dateRange? }`.
- `POST /market-data/instruments/refresh` — refresh all non-currency instruments that have a
  `symbol` (latest or backfill, same body). Returns a summary:
  `{ updated: number, unsupported: number, failed: number, rowsWritten: number, details: [...] }`.
- `POST /market-data/fx/refresh` — refresh FX for every currency in active use (distinct
  account + instrument currencies that differ from `settings.baseCurrency`).
  - Latest: resolve `base → C`, upsert today's `fx_rates` row.
  - Backfill: resolve the `base → C` series, insert-if-absent a row per date.
  - `rateScaled = rate × SCALE`, `source = providerName`. Returns
    `{ updated, unsupported, failed, rowsWritten, details }`.
- `POST /market-data/test` — admin-only; performs a sample Alpha Vantage fetch using the
  stored key and returns `{ ok, message? }` (mirrors `/settings/ai/test`).

**Default backfill range (UI convenience):** when the user clicks "Backfill history" the web
client supplies `from` = the earliest relevant date — the instrument's first transaction date
(per-instrument refresh) or the earliest transaction across the household (bulk / FX). The
server treats `from`/`to` as given; computing the default lives in the client so the route
stays simple.

**Upsert semantics (differ by mode):** unique indexes already exist on
`prices (instrument_id, date)` and `fx_rates (currency, date)`.
- **Latest mode** overwrites the row for *today's* date — re-running is idempotent and a fresh
  quote is the more current observation.
- **Backfill mode** uses **insert-if-absent** per date: it fills missing dates only and never
  clobbers an existing row of any source (manual, trade, or an earlier fetch). This protects
  hand-entered prices and keeps backfill safe to re-run.

**Rate limits:** Yahoo (the price primary) needs no key and has generous informal limits, so
the common path costs nothing against a quota. Alpha Vantage (the keyed alternative) only runs
when Yahoo returns nothing for an instrument, and its free tier is ~25 requests/day, ~5/min.
The bulk route does not parallelize aggressively; a small sequential loop is sufficient for a
personal-scale instrument count. Backfill fetches **one resolve + one probe + one series
request per instrument/currency** (not one-per-day), so a full history backfill is roughly as
many requests as a latest refresh — the request budget scales with instrument count, not date
range. When Alpha Vantage *does* serve a backfill (Yahoo missed the symbol), its capped depth
is handled by spacing (see "Spacing") rather than skipping it.

## Section 3 — Schema changes

Two additive changes (one migration):

1. **`fx_rates.source`** — add `text("source").notNull().default("manual")`, matching the
   existing `prices.source`. Lets FX rows record provenance (`"frankfurter"` / `"yahoo"` /
   `"manual"`). Existing rows backfill to `"manual"` via the default.
2. **`settings.marketDataApiKey`** — add `text("market_data_api_key")` (nullable) to the
   singleton `settings` row, alongside `aiApiKey`. Holds the Alpha Vantage key. Write-only,
   never returned to the client.

`prices.source` already exists — no change; providers just write their `name`.

## Section 4 — Settings: "Market data provider" section

Mirror the AI-provider pattern exactly.

**`GET /settings`** — add `marketDataApiKeySet: boolean` to the response (`!!s?.marketDataApiKey`).
Never return the key itself.

**`PATCH /settings`** — accept `marketDataApiKey?: string` in the body schema.
- Admin-only: the existing `touchesAi` guard is extended (or a parallel `touchesMarketData`
  check) so non-admins get `403 admin_only` when touching the key.
- Write-only: only persist when `typeof body.marketDataApiKey === "string" && length > 0`;
  an empty/omitted value preserves the stored key.

**Server helper** — `loadMarketDataConfig()` (in `apps/api/src/lib/settings.ts` or a new
`apps/api/src/lib/market-data/config.ts`) reads the key from settings and returns
`{ alphaVantageApiKey?: string }`. The chain builder uses it to decide whether to include the
Alpha Vantage provider.

**Web UI** (`apps/web/src/routes/settings.tsx`) — a new
`<Section eyebrow="Market data" title="Market data provider">` styled like the AI section:
- `useState` for `marketDataApiKey` (input) and `marketDataApiKeySet` (loaded flag), seeded
  from `settingsQ.data` in the existing `useEffect`.
- A single `type="password"` `Input` with the "(set — leave blank to keep)" label when set,
  placeholder `••••••••`.
- `saveMarketData()` mutation that only sends the key when non-empty, then clears the input
  and invalidates the `settings` query.
- Save + "Test connection" buttons; Test calls `POST /market-data/test` and shows ok/failure.
- Copy notes that the app works with **no key** — Yahoo (instrument prices) and Frankfurter
  (FX) are key-free. The Alpha Vantage key is an **optional alternative** that's only consulted
  for instruments Yahoo can't resolve.

## Section 5 — Web: refresh UI

- **Instrument detail** (`apps/web/src/routes/instrument-detail.tsx`): a "Refresh price"
  button (latest) beside the existing manual price entry, plus a "Backfill history" action
  (sends `from` = the instrument's first transaction date). On success show the fetched
  price / rows-written, a source badge (provider name), and the date(range); invalidate the
  prices collection/query. For `kind: "currency"` both are hidden.
- **Instruments list** (`apps/web/src/routes/instruments.tsx`): "Refresh all prices" and
  "Refresh FX" buttons, each with a "latest" default and a "Backfill history" option. Each
  shows a summary toast, e.g. `Updated 8 · 2 unsupported · 1 failed · 412 rows`, and
  invalidates the relevant collections.
- Unsupported instruments (tickerless funds) are surfaced in the summary, not treated as
  errors.

## Eden / types wiring

The new `/market-data` routes are added to the Elysia app and flow through the existing Eden
treaty export (`apps/api/src/eden.ts` → `apps/web/src/lib/api.ts`), giving the web client
`api["market-data"].instrument({ id }).refresh.post()` etc. with end-to-end types. The
extended `/settings` fields ride the existing settings wiring.

## Error handling

- Per-provider errors (network, parse, HTTP non-2xx, rate-limit) are caught in the resolver
  and advance the chain; only an all-providers-failed outcome is "failed" for that item.
- Bulk routes never abort on a single item; they accumulate `{ updated, unsupported, failed }`.
- A missing Alpha Vantage key is not an error — the price chain is built without AV.
- All `/market-data` write/test routes are admin-gated like the AI settings.

## Testing

- **Adapter unit tests** (`apps/api/src/lib/market-data/providers/*.test.ts`): each provider
  parsed against saved JSON fixtures — latest **and** series shapes (success, not-found,
  rate-limit). `resolveSymbol` cases: **ISIN → Yahoo search match** (mocked search response,
  best-score pick), US passthrough, SGD `.SI`, crypto `BTC-USD`, ambiguous → null, and AV
  returns null for ISIN-only instruments.
- **Resolver test:** primary returns null/throws → falls through to fallback; both fail →
  null. Series resolution skips providers lacking `*Series` and does not stitch across
  providers. **Probe gate:** a failed probe skips the series call entirely and advances the
  chain. **Spacing helper:** N raw points downsample to ≤ `maxPoints` evenly-spaced dates
  across the range (boundary cases: fewer points than cap → unchanged; cap = 1 → endpoints).
- **Route tests** (`apps/api/src/routes/market-data.test.ts`): with mocked providers —
  latest refresh upserts today's `prices` row with the right `source`; **backfill inserts a
  series and does NOT overwrite an existing manual/trade row** (insert-if-absent); bulk
  summary counts incl. `rowsWritten`; FX refresh upserts `fx_rates`; currency instruments
  are skipped; admin gate on `/market-data/test`.
- **Settings tests:** extend `settings-ai.test.ts`-style coverage — `marketDataApiKeySet`
  boolean in GET, write-only preserve-on-empty, admin-only PATCH.
- Per the testing workflow: unit/route tests during iteration; affected E2E specs at end of
  slice.

## Known limitations (acceptable for WIP)

- Symbol resolution will miss some non-US, multi-exchange symbols that lack an ISIN; the
  workaround is to enter a fully-suffixed symbol. Documented in the instrument edit UI copy.
- Instruments with neither a usable ticker nor an ISIN that Yahoo indexes stay manual.
  (Many ISIN-identified funds, incl. Endowus/Amundi, *do* resolve via Yahoo search — see
  `LU2420245917` → `0P0001OO2D.SI`.)
- Indicative prices only — quote currency/precision/staleness are provider-dependent; values
  may differ from official EOD marks.
- **Historical depth is provider-bound:** Yahoo (primary) serves dense daily history for free.
  Alpha Vantage (the keyed alternative, used only when Yahoo misses a symbol) caps free history
  (~100 points); spacing spreads those across the full range as a *sparse* series (lower
  resolution, full coverage) rather than dense-recent. Frankfurter FX history starts ~1999 (ECB).
- **Yahoo is now the price primary and unofficial (no SLA).** Broader coverage (incl.
  ISIN-resolved funds) at the cost of depending on an unofficial endpoint on the common path;
  the provider abstraction keeps the blast radius to one adapter, and AV is the keyed alternative.
- **Backfill won't correct an existing wrong row:** insert-if-absent never overwrites, so a
  bad manual/trade price on a date blocks a fetched value for that date. Deleting the row and
  re-backfilling is the workaround (prices are managed on the instruments page).
