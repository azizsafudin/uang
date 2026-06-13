# Uang — Foundation + Slice 1: Accounts, Balances, Net Worth, Holdings & Backfill

**Date:** 2026-06-13
**Status:** Draft for review
**Scope:** Foundation (scaffold, auth, money model, export) + the first usable vertical slice: Accounts & Balances, investment **holdings with manual prices**, Net-worth-over-time, Backfill.

---

## 1. Overview & Goals

Uang is a **self-hosted, single-household** personal finance platform. One deployed instance serves one household; the household's members each have a login and share all data. There is no multi-tenant SaaS layer, no public signup, and no external sync — the API server is the single source of truth.

This spec covers the foundation plus Slice 1. After Slice 1 you can:

- Create accounts (assets and liabilities) in multiple currencies.
- Set opening balances and **backfill** existing assets/liabilities you already hold ("set current balance to X").
- Track **investment holdings as lots** (units bought at a price/date), with **manually entered prices**, and see **per-lot appreciation** (unrealized gain per cohort of units).
- Record revaluations for non-priced assets (private shares, property).
- See total **net worth** rolled up to a base currency.
- See a **graph of net worth over time**.
- Export the whole database as a SQLite file.

Cashflow/budgets, automatic investment **price-fetch APIs**, realized-gain cost-basis methods, and goals are deferred to their own spec → plan → build cycles, but the data model is designed so they slot in without rework.

## 2. Scope

**In scope (this spec):**

- TanStack Router **SPA** (Vite) frontend + **TanStack DB** for reactive, optimistic client state.
- **ElysiaJS** (Bun) API backend; **SQLite via libSQL `file:`** + **Drizzle ORM** + migrations.
- **better-auth**: first-run admin creation, sessions, "all users equal" (admin manages users). No read-only role.
- Money model: integer minor units, per-account/per-instrument currency, base-currency rollup via an FX-rate table.
- **Two valuation modes** for accounts:
  - `ledger` — balance = Σ ledger entries (cash, bank, loans, property, private shares).
  - `holdings` — balance = Σ (lot units × manual instrument price) (brokerage, funds, public equities).
- Accounts CRUD; ledger (`entries`: `opening`/`adjustment`/`revaluation`); holdings (`instruments`, `lots`, manual `prices`); per-lot unrealized gain.
- Net-worth headline + net-worth-over-time graph (covers both valuation modes).
- Backfill flows (opening balance, set-balance-to-X, revaluation; for holdings, entering lots + a current price).
- Export endpoint (download the SQLite file).
- Two-service deployment (web + api).

**Out of scope / deferred:**

- **Automatic price fetching** from market-data APIs (scheduled jobs, external API, secrets) — manual price entry only in v1. (See §13.)
- **Realized gains / cost-basis methods** (FIFO/average) — needs sells, which arrive with Slice 2 transactions.
- Transactions with categories, transfers, budgets, cashflow (Slice 2 — `entries.kind='transaction'` reserved but unused here).
- Goals slice.
- Read-only user role; per-user permissions beyond admin-can-manage-users.
- Import / restore (v1 exports only; restore = manual file swap on the volume).
- Automatic FX-rate fetching (rates entered manually in v1).

## 3. Architecture & Stack

Split client/server, two deployables.

| Concern | Choice | Notes |
|---|---|---|
| Frontend | **TanStack Router SPA** (Vite) | Static build, served as its own service. |
| UI / styling | **shadcn/ui + Tailwind CSS** | Radix-based components copied into the repo; Tailwind for styling. Charts via a shadcn-compatible chart lib (Recharts) for the net-worth graph. |
| Client data layer | **TanStack DB** | Query collections backed by the API (optimistic mutations + live reactive queries). |
| Backend | **ElysiaJS on Bun** | REST/RPC API; **Eden Treaty** for end-to-end type-safe client calls. |
| Database | **SQLite via libSQL `file:`** (`@libsql/client`) | Plain SQLite file, Turso-upgradeable. File on the api service's persistent volume. |
| ORM / migrations | **Drizzle ORM** + drizzle-kit | Typed schema, SQL-first. |
| Auth | **better-auth** | Email/password, sessions; signup gated after first user; admin manages users; Drizzle-backed tables. |
| Hosting | **Railway, two services** | `web` (static SPA) + `api` (Bun/Elysia + SQLite **persistent volume**). |
| Money/units math | Integer minor units + BigInt in TS | No floats anywhere in money paths. |

**Deployment notes:**

- **Two Railway services** from one monorepo: `apps/web` (Vite SPA) and `apps/api` (Bun/Elysia). Shared `packages/*` for Drizzle schema + types (and Eden client types).
- SQLite on the **api** persistent volume: `DATABASE_URL=file:/data/uang.db`. Migrations run on api boot. Refuse ephemeral path in production.
- **CORS + cookies:** better-auth uses cookies; web and api are separate origins. Prefer one parent domain (set cookie domain) or configure CORS `credentials` + `SameSite`/`Secure`. Document exact config.
- Backups: export endpoint + periodic volume snapshots.

**Reactivity:** TanStack DB collections (accounts, entries, instruments, lots, prices, fx_rates) are query collections over the Elysia API. Heavy analytics (net-worth series, per-lot valuation) are **server-computed** endpoints the client fetches.

## 4. Data Model (Drizzle / SQLite)

Money = **signed integer minor units** in the relevant currency. `*_at` = unix epoch (int) UTC. Effective dates = `TEXT` `YYYY-MM-DD`. Fixed scales: `RATE_SCALE = PRICE_SCALE = UNIT_SCALE = 100_000_000` (1e8).

better-auth manages `user`/`session`/`account`/`verification` tables (Drizzle adapter); `user` gets an `is_admin` flag. App tables:

```
settings            -- singleton (id = 1)
  id integer pk (1) | household_name text | base_currency text | created_at integer

accounts
  id text pk (uuid) | name text
  class text          -- 'asset' | 'liability'  (UI grouping; sign carries ledger math)
  subtype text        -- 'cash'|'bank'|'investment'|'property'|'loan'|'credit_card'|'other'
  currency text       -- ISO 4217 (reporting/default currency for the account)
  valuation_mode text -- 'ledger' | 'holdings'
  institution text nullable | is_archived int(0/1) default 0 | sort_order int default 0
  created_at integer | created_by text fk -> user.id

entries               -- ledger; source of truth for valuation_mode = 'ledger'
  id text pk (uuid) | account_id text fk -> accounts.id
  date text           -- YYYY-MM-DD effective date
  amount_minor integer-- SIGNED, in account.currency
  kind text           -- 'opening'|'adjustment'|'revaluation'|'transaction'(reserved)
  note text nullable | created_at integer | created_by text fk -> user.id

instruments           -- a tradable thing held in holdings accounts
  id text pk (uuid) | symbol text nullable | isin text nullable
  name text | kind text  -- 'stock'|'etf'|'fund'|'other'
  currency text          -- ISO 4217 (instrument's quote currency)
  created_at integer
  -- (Investments slice adds: external price-source id/mapping)

lots                  -- a cohort of units bought; source of truth for 'holdings' balances
  id text pk (uuid) | account_id text fk -> accounts.id | instrument_id text fk -> instruments.id
  units_scaled integer       -- units * 1e8 (fractional units supported)
  unit_cost_scaled integer   -- cost per unit in instrument currency * 1e8
  fees_minor integer default 0 -- in instrument currency minor units
  trade_date text            -- YYYY-MM-DD
  note text nullable | created_at integer | created_by text fk -> user.id

prices                -- manual price points per instrument (carry-forward)
  id text pk (uuid) | instrument_id text fk -> instruments.id
  date text                  -- YYYY-MM-DD
  price_scaled integer       -- price per unit in instrument currency * 1e8
  source text default 'manual'
  created_at integer
  -- unique(instrument_id, date)

fx_rates              -- manual: value of 1 unit of `currency` in base currency
  id text pk (uuid) | currency text | date text
  rate_scaled integer        -- rate_to_base * 1e8
  created_at integer
  -- unique(currency, date)
```

**Currency minor-unit digits** (JPY=0, USD=2, BHD=3, …): static ISO-4217 map in code.

## 5. Money, Units & Valuation Semantics

All cross-scale arithmetic uses **BigInt**; results round half-to-even to integer minor units.

- **Ledger account balance** at `asOf`: `Σ entries.amount_minor WHERE account_id=? AND date<=asOf` (integer SUM), in account currency. Sign convention: assets normally positive, liabilities negative; net worth just sums.
- **Holdings account valuation** at `asOf`: for each lot with `trade_date <= asOf`, using the **latest price ≤ asOf** (carry-forward) for its instrument:
  ```
  mv_minor   = round( units_scaled * price_scaled * 10^instrDecimals / (UNIT_SCALE*PRICE_SCALE) )
  cost_minor = round( units_scaled * unit_cost_scaled * 10^instrDecimals / (UNIT_SCALE*PRICE_SCALE) ) + fees_minor
  unrealized_gain_minor = mv_minor - cost_minor          -- all in instrument currency
  ```
  Per-lot values are in the **instrument's** currency, converted to base via FX (below). An account's displayed value = Σ its lots' market values converted to base (instruments may differ in currency from the account's reporting currency).
- **FX conversion** (any currency → base), BigInt:
  ```
  base_minor = round( amount_minor * 10^(baseDecimals - srcDecimals) * rate_scaled / RATE_SCALE )
  ```
  Base currency → `rate_scaled = RATE_SCALE`. Use latest `fx_rate` with `date ≤ asOf`. Missing rate → flagged in UI, that amount excluded rather than silently mis-summed. Same rule for missing instrument price.
- **Net worth** at `asOf` = Σ over accounts of (ledger balance OR holdings market value), each converted to base.

## 6. Backfill & Onboarding Flows

- **Ledger accounts** — three same-mechanic flows (insert an entry, differ by `kind`):
  1. **Opening balance** (new account): `opening` entry at an opening date.
  2. **Set balance to X**: `delta = X − balance(asOf)` → `adjustment` entry.
  3. **Revaluation** (private shares, property): same with `kind='revaluation'`.
  Liabilities use negative values; delta math is identical.
- **Holdings accounts** — backfill by **entering lots** (instrument, units, unit cost, trade date, fees) for what you already hold, then adding a **current price** for each instrument. Value derives automatically. To "mark to market" later, add a new `prices` row (no adjustment entry needed). Historical prices can be added to make the net-worth line accurate over time.

## 7. Net Worth Over Time (graph)

- Default bucketing **monthly** (switchable weekly/daily for short ranges); default range = earliest activity → today.
- For each bucket boundary `D`, net worth = Σ accounts:
  - ledger accounts: cumulative SUM of entries with `date ≤ D` (single SQL pass), then FX→base.
  - holdings accounts: Σ lots with `trade_date ≤ D`, valued at latest price `≤ D`, then FX→base.
- Computed **on the API server**; client fetches `[{ date, netWorthBaseMinor }]` and renders a line chart. Headline = latest point. Household-sized data → cheap; no materialized snapshots in v1.

## 8. Auth (better-auth)

- **First run:** no users → onboarding sets `household_name` + `base_currency`, creates **first user as admin**. Open signup **disabled** after first user.
- Admin adds further users (email + name + initial password) via better-auth admin/user management.
- **Sessions:** better-auth cookies; all API routes except auth + onboarding require a valid session (Elysia guard middleware mounts the better-auth handler).
- **Attribution:** `created_by` on accounts/entries/lots.

## 9. Export

- API endpoint streams the SQLite file (`Content-Disposition: attachment; filename="uang-YYYY-MM-DD.db"`) via a consistent/checkpointed read. Lossless backup; openable in any SQLite tool; restorable by swapping the file on the volume. (Optional JSON export later.)

## 10. UI Surfaces (Slice 1)

- **Onboarding / first-run:** household name, base currency, create admin.
- **Login.**
- **Dashboard:** net-worth headline (base) + net-worth-over-time chart + accounts grouped asset/liability with current values (base + native).
- **Account create/edit:** name, class, subtype, currency, institution; **valuation mode** (ledger vs holdings — default holdings for `investment` subtype, ledger otherwise); optional opening balance + date (ledger).
- **Ledger account detail:** entries list; "Set balance to…", "Record revaluation", add/edit/delete entry.
- **Holdings account detail:** lots list with per-lot cost, market value, **unrealized gain**; add/edit/delete lot; "Update price" (manual) per instrument; account total + total gain.
- **Settings:** manage users (admin); FX rates; instrument prices; export; base currency (display).

## 11. Non-Functional

- **Money/units safety:** integer minor units + BigInt for all multiply/divide (FX, valuation). No floats in money paths. Round half-to-even at final convert.
- **Migrations:** drizzle-kit; run on api boot; forward-only.
- **Persistence:** Railway volume on api; document `DATABASE_URL` + mount; refuse ephemeral path in prod.
- **Time:** effective dates are calendar dates (no TZ); timestamps UTC epoch.
- **Type safety:** Eden Treaty / shared types between SPA and Elysia API.

## 12. Testing Strategy (TDD)

Tests first for pure, high-value logic:

- `balanceAt(entries, asOf)` — integer SUM, inclusive boundaries.
- `lotValuation(lot, priceAt, instrDecimals)` — `mv_minor`, `cost_minor`, `unrealized_gain_minor`; fractional units; price carry-forward.
- `convertToBase(amount, currency, date, rates, base)` — BigInt, differing minor-unit digits (JPY↔USD↔BHD), carry-forward, missing-rate handling.
- `setBalanceDelta(target, current)` — backfill delta incl. negatives/liabilities.
- `netWorthAt` / `netWorthSeries` — mixed ledger + holdings, multi-currency, revaluations.
- Integration: auth gating on Elysia routes; first-run flow; export round-trip (row counts match).

## 13. Open Questions / Defaults / Deferred

- **Default base currency:** none hardcoded — chosen at first run.
- **FX rates & instrument prices:** manual in v1; auto-fetch deferred.
- **Import/restore:** v1 = manual file swap; in-app import deferred.
- **Read-only role:** deferred (all users equal).
- **Net-worth snapshot caching:** deferred until performance requires it.

---

### Deferred slices (own spec cycles)

- **Slice 2 — Cashflow & Budgets:** `entries.kind='transaction'`, categories, transfers (paired entries), monthly budgets vs actuals; **sells** enable realized-gain cost-basis (FIFO/average) on lots.
- **Investments enhancement — automatic pricing:** scheduled EOD price fetch from a market-data API (Finnhub / Twelve Data / FMP / EOD Historical Data) writing `prices` rows with `source='api'`. **Stocks & ETFs:** good coverage. **Unit trusts/funds:** partial, region-dependent — manual NAV fallback. **Private shares:** no API → stays ledger/revaluation. Adds instrument↔external-symbol mapping + API secrets.
- **Goals slice:** mid/long-term targets (savings-by-date, net-worth target, debt payoff), on-track tracking against the net-worth series.
