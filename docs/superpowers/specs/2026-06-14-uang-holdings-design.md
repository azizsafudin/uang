# Uang — Investment Holdings & Per-Lot Appreciation (design)

**Date:** 2026-06-14
**Status:** Draft for review
**Builds on:** the merged foundation + Plan 2 (accounts, ledger, FX, net-worth headline) + Plan 3 (account ownership). The `instruments`, `lots`, and `prices` tables and the `accounts.valuation_mode` field already exist in the schema (added in the foundation, unused until now). This slice makes `valuation_mode='holdings'` real.

---

## 1. Goal

Let the household track investment accounts as **lots** — cohorts of units bought at a price on a date — valued with **manually entered prices**, and see **per-lot unrealized gain** (market value − cost). A holdings account's value rolls into net worth alongside ledger accounts, and is **as-of-aware** (point-in-time correct) so the future net-worth-over-time graph includes investments automatically.

After this slice you can:
- Create an account with `valuation_mode='holdings'`.
- Add lots to it (pick or create an instrument inline; enter units, unit cost, trade date, fees).
- Enter manual prices per instrument (today's price, plus optional dated history); prices carry forward.
- See, per lot, its cost, market value, and unrealized gain; and the account's total value + total gain.
- Have holdings accounts appear in the dashboard net worth (base currency), honoring the slice-3 owner rules.

## 2. Scope

**In scope:** holdings account creation; instruments (global, create inline from the lot form); lots CRUD (add/edit/delete); manual prices (upsert per instrument+date, dated history); the holdings valuation engine (`lotValuation`, carry-forward pricing, instrument→base FX, missing-price/rate flagging); integration into `netWorth` (mixed ledger + holdings, as-of-aware); a holdings detail view (lots table with per-lot gain, add/edit/delete lot, update price); the account-form valuation-mode toggle.

**Out of scope / deferred (their own cycles):** automatic price fetching from market-data APIs; realized-gain cost-basis methods (FIFO/average); the net-worth-over-time graph itself (separate slice — this slice only guarantees `netWorth(asOf)` already values holdings correctly); per-instrument external-source mappings.

## 3. Data model (no migration)

All three tables already exist (`apps/api/src/db/schema.ts`); this slice adds **no DDL**. For reference:

```
instruments  -- a tradable thing, global/shared across accounts
  id, symbol (nullable), isin (nullable), name, kind ('stock'|'etf'|'fund'|'other'),
  currency (ISO 4217, the instrument's quote currency), created_at

lots         -- a cohort of units bought; source of truth for 'holdings' balances
  id, account_id -> accounts.id, instrument_id -> instruments.id,
  units_scaled (units × 1e8), unit_cost_scaled (cost/unit in instrument ccy × 1e8),
  fees_minor (instrument ccy minor units, default 0), trade_date (YYYY-MM-DD),
  note (nullable), created_at, created_by

prices       -- manual price points per instrument (carry-forward)
  id, instrument_id -> instruments.id, date (YYYY-MM-DD),
  price_scaled (price/unit in instrument ccy × 1e8), source (default 'manual'),
  created_at, UNIQUE(instrument_id, date)
```

**Scales (existing):** `UNIT_SCALE = PRICE_SCALE = RATE_SCALE = 1e8` (exported as `SCALE` from `@uang/shared`). Instrument minor-unit decimals come from `currencyDecimals(instrument.currency)`.

## 4. Valuation (the engine) — new `apps/api/src/lib/holdings.ts`

**Per-instrument price (carry-forward):**
`instrumentPriceScaled(instrumentId, asOf?)` → the `price_scaled` of the latest `prices` row with `date ≤ asOf` (or latest overall if `asOf` absent); `null` if none. Mirrors the existing `latestFxRateScaled`.

**Per-lot valuation** (all amounts in the **instrument's** currency, `instrDec = currencyDecimals(instrument.currency)`):
```
mv_minor   = round( units_scaled × price_scaled × 10^instrDec / (UNIT_SCALE × PRICE_SCALE) )
cost_minor = round( units_scaled × unit_cost_scaled × 10^instrDec / (UNIT_SCALE × PRICE_SCALE) ) + fees_minor
gain_minor = mv_minor − cost_minor
```
`lotValuation(lot, priceScaled, instrDec)` → `{ mvMinor, costMinor, gainMinor }`. BigInt math at the edge (`toBig`/`fromBig`), serialized as JS numbers at the boundary (household magnitudes stay < 2^53). Fractional units supported (units are scaled integers).

**Holdings account valuation:**
`holdingsAccountValuation(accountId, asOf?, base)` →
- For each lot with `trade_date ≤ asOf`: look up its instrument's carry-forward price ≤ asOf.
  - Missing price → that lot contributes 0 and the account is flagged (`missing = true`); the lot is shown but excluded from totals (same rule as a missing FX rate).
  - Else compute `lotValuation`, then convert `mvMinor` and `costMinor` from the **instrument's currency to base directly** via the FX table (`convertToBase`, the same path ledger accounts use). Missing FX rate for the instrument currency → flag + exclude that lot.
- Returns `{ baseMinor, gainBaseMinor, missing, lots: [...per-lot breakdown...] }`, where `baseMinor = Σ mv→base` and `gainBaseMinor = Σ gain→base` over included lots.

**Net-worth integration:** `netWorth(opts)` branches per account on `valuation_mode`:
- `'ledger'` → existing `accountBalanceMinor` path (unchanged).
- `'holdings'` → `holdingsAccountValuation`; the account's `baseMinor` is its holdings base total, `missingRate` is the holdings `missing` flag.
Owner filtering, the `ownerIds`/`shared` tagging (slice 3), and `asOf` all continue to apply uniformly. Because holdings valuation honors `asOf` (price ≤ date, lot `trade_date ≤ date`), the future net-worth-over-time graph values holdings with no extra work.

**Display rule:** a holdings account's total is reported in **base currency** (single instrument→base hop). Per-lot cost/market-value/gain are shown in each **instrument's** currency on the detail page. The holdings account's own `currency` field is informational (instruments carry their own currencies). In the `netWorth` per-account entry, a holdings account's `balanceMinor` equals its `baseMinor` (no instrument→account conversion).

## 5. API

All endpoints behind the existing `authGuard`. Money/units serialized as JS numbers (scaled ints for units/prices, minor units for money).

- **`POST /accounts`** — remove the `holdings_not_supported_in_v2` rejection; accept `valuationMode: 'holdings'`. Holdings accounts ignore `openingBalanceMinor` (no opening entry). `ownerIds` handling unchanged (slice 3).
- **`GET /instruments`** — list all instruments.
- **`POST /instruments`** — create `{ name, kind, currency, symbol?, isin? }` → `{ id }`. (Inline-create target from the lot form.)
- **`GET /accounts/:id/lots`** — lots for an account (raw rows).
- **`POST /accounts/:id/lots`** — create `{ instrumentId, unitsScaled, unitCostScaled, feesMinor?, tradeDate, note? }` → `{ id }`. `instrumentId` must exist (422 otherwise).
- **`PATCH /lots/:id`** — edit `{ unitsScaled?, unitCostScaled?, feesMinor?, tradeDate?, note?, instrumentId? }`.
- **`DELETE /lots/:id`** — remove a lot.
- **`GET /instruments/:id/prices`** — price history for an instrument.
- **`POST /instruments/:id/prices`** — upsert `{ date, priceScaled }` (insert or replace on `UNIQUE(instrument_id, date)`); `source='manual'`.
- **`DELETE /prices/:id`** — remove a price point.
- **`GET /accounts/:id/holdings`** — the detail-page payload: `{ totalBaseMinor, totalGainBaseMinor, missing, baseCurrency, lots: [{ lotId, instrument, unitsScaled, unitCostScaled, feesMinor, tradeDate, note, priceScaled, mvMinor, costMinor, gainMinor, instrumentCurrency, mvBaseMinor, missingPrice }] }`.

## 6. UI

**Account form (create)** — add a **valuation mode** control (Ledger / Holdings). Default **Holdings** when subtype is *investment*, Ledger otherwise. When Holdings: hide the opening-balance fields (holdings start empty; value comes from lots). `ownerIds` picker unchanged.

**Account detail — branches on `valuation_mode`:**
- *Ledger* (existing): entries history + Set-balance/Revalue. Unchanged.
- *Holdings* (new): header shows **total value** and **total unrealized gain** (base). A **lots table** — one row per lot: instrument (symbol/name), units, unit cost, **market value**, **unrealized gain** (instrument currency, gain colored), trade date. Row actions: **edit lot**, **delete lot**. An **Add lot** dialog: pick an existing instrument *or create one inline* (symbol, name, currency, kind), then units / unit cost / trade date / fees / note. An **Update price** affordance per instrument (set today's price; optional past-dated price) — missing-price lots are visibly flagged. Changing lots/prices refetches the holdings payload + net worth.

**Data layer:** new TanStack DB collections following the existing `entriesCollection` factory pattern:
- `instrumentsCollection` (global), `lotsCollection(accountId)`, `pricesCollection(instrumentId)`.
- The holdings detail payload (`GET /accounts/:id/holdings`) is fetched via react-query (server-computed, like `networth`).

## 7. Components / boundaries

- `apps/api/src/lib/holdings.ts` — `instrumentPriceScaled`, `lotValuation`, `holdingsAccountValuation`. Pure-ish, unit-tested in isolation.
- `apps/api/src/lib/valuation.ts` — `netWorth` gains the per-account holdings branch (delegates to `holdings.ts`).
- `apps/api/src/routes/instruments.ts`, `apps/api/src/routes/lots.ts`, `apps/api/src/routes/prices.ts`, plus a `GET /accounts/:id/holdings` handler (in the holdings/lots route module). Mounted in `app.ts`.
- Web: `lots-table`, `add-lot-dialog` (with inline instrument create), `update-price` control; holdings collections; the account-detail page branches on mode.

## 8. Testing

- **`lotValuation` (unit):** fractional units; fees added to cost; instrument-currency decimals (e.g. JPY 0-dec vs USD 2-dec); gain sign (loss when price < cost).
- **`holdings.ts` (unit):** carry-forward price (latest ≤ asOf; none → flagged/excluded); lot excluded when `trade_date > asOf`; mixed instrument currencies converted to base; missing FX rate flags + excludes.
- **`netWorth` (unit):** mixed ledger + holdings totals; as-of correctness across dates (a price added later doesn't affect an earlier asOf); owner filter + `shared` still correct for holdings accounts.
- **Routes:** create holdings account (opening balance ignored); create instrument; add/edit/delete lot (422 on unknown instrument); upsert price (replace on same date); `GET /accounts/:id/holdings` totals + per-lot breakdown; 401 without auth.
- **Web:** build is the gate; manual E2E for add-lot (inline instrument), update-price, per-lot gain, and the holdings total appearing in the dashboard.

## 9. Defaults / decisions

- **Instruments:** global/shared; created **inline** from the add-lot form (no separate manager).
- **Prices:** current price + optional dated history; carry-forward (latest ≤ date); upsert per `(instrument, date)`.
- **FX:** instrument currency → base **directly** (one hop); account `currency` informational for holdings.
- **Holdings total display:** base currency; per-lot figures in instrument currency.
- **Full feature:** edit-lot, delete-lot, `isin`, dated price history all included (nothing cut).
- **Owners:** holdings accounts carry owners exactly like ledger accounts (slice 3 rules unchanged).
- **No migration:** schema already has `instruments`/`lots`/`prices` and `valuation_mode`.
