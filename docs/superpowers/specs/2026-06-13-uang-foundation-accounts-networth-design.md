# Uang — Foundation + Slice 1: Accounts, Balances, Net Worth & Backfill

**Date:** 2026-06-13
**Status:** Draft for review
**Scope:** Foundation (scaffold, auth, money model, export) + the first usable vertical slice (Accounts & Balances, Net-worth-over-time, Backfill).

---

## 1. Overview & Goals

Uang is a **self-hosted, single-household** personal finance platform. One deployed instance serves one household; the household's members each have a login and share all data. There is no multi-tenant SaaS layer, no public signup, and no external sync — the server is the single source of truth.

This spec covers the foundation plus Slice 1. After Slice 1 you can:

- Create accounts (assets and liabilities) in multiple currencies.
- Set opening balances and **backfill** existing assets/liabilities you already hold ("set current balance to X").
- Record revaluations for non-cash assets (investments, property).
- See total **net worth** rolled up to a base currency.
- See a **graph of net worth over time**.
- Export the whole database as a SQLite file.

Cashflow/budgets (Slice 2) and goals (Slice 3) are deferred to their own spec → plan → build cycles, but the data model is designed so they slot in without rework.

## 2. Scope

**In scope (this spec):**

- TanStack Start app scaffold + Railway deploy with a persistent volume.
- Embedded SQLite (libSQL `file:`) + Drizzle ORM + migrations.
- Auth: first-run admin creation, cookie sessions, "all users equal" (admin can add/remove users). No read-only role.
- Money model: integer minor units, per-account currency, base-currency rollup via an FX-rate table.
- Accounts CRUD; the ledger (`entries`) supporting `opening` / `adjustment` / `revaluation` kinds.
- Net-worth headline + net-worth-over-time graph.
- Backfill flows (opening balance, set-balance-to-X, revaluation).
- Export endpoint (download the SQLite file). Import is **out** of v1 (see Deferred).

**Out of scope / deferred:**

- Transactions with categories, transfers, budgets, cashflow (Slice 2 — `entries.kind = 'transaction'` is reserved but unused here).
- Goals (Slice 3).
- Read-only user role; per-user permissions beyond admin-can-manage-users.
- Import / restore (v1 exports only; restore is a documented manual file-swap on the volume; in-app import is a later slice).
- Automatic FX-rate fetching (rates are entered manually in v1).
- Remote sync / multi-device beyond "every device hits the same server" (inherent and free here).

## 3. Architecture & Stack

| Concern | Choice | Notes |
|---|---|---|
| App framework | **TanStack Start** | Single SSR process; server functions + file-based routing (TanStack Router). One deployable. |
| Client data | **TanStack Query** | Calls server functions; cache + invalidate on mutation. |
| Database | **libSQL embedded** (`@libsql/client`, `file:` URL) | Plain SQLite file; Turso-upgradeable later. |
| ORM / migrations | **Drizzle ORM** + drizzle-kit | Typed schema, SQL-first, lightweight. |
| Auth | Cookie sessions (hand-rolled or a minimal lib) | First-run admin; no public signup. |
| Hosting | **Railway** | SQLite file on a **persistent volume** (e.g. `/data/uang.db`). |
| Money math | Integer minor units + BigInt in TS | No floats anywhere in money paths. |

**Deployment notes:** the SQLite file must live on a Railway **persistent volume** (not the ephemeral container FS). `DATABASE_URL=file:/data/uang.db`. Migrations run on boot. Backups: the export endpoint + periodic volume snapshots.

**Reactivity:** no client store/CRDT. Server is source of truth; TanStack Query fetches and invalidates. The earlier TanStack DB idea is dropped — redundant once there's a server.

## 4. Data Model (Drizzle / SQLite)

All money is stored as **signed integer minor units** in the account's own currency. All `*_at` are unix epoch (integer) UTC. All dates for ledger entries are calendar dates (`TEXT` `YYYY-MM-DD`).

```
settings            -- singleton row (id = 1)
  id                integer pk (always 1)
  household_name    text
  base_currency     text        -- ISO 4217, set on first run
  created_at        integer

users
  id                text pk (uuid)
  email             text unique
  name              text
  password_hash     text
  is_admin          integer (0/1)  -- first user = 1
  created_at        integer

sessions
  id                text pk        -- session token (hashed)
  user_id           text fk -> users.id
  expires_at        integer

accounts
  id                text pk (uuid)
  name              text
  class             text   -- 'asset' | 'liability'  (UI grouping; sign carries math)
  subtype           text   -- 'cash' | 'bank' | 'investment' | 'property' | 'loan' | 'credit_card' | 'other'
  currency          text   -- ISO 4217
  institution       text   nullable
  is_archived       integer (0/1) default 0
  sort_order        integer default 0
  created_at        integer
  created_by        text fk -> users.id

entries               -- the ledger; one source of truth for balances
  id                text pk (uuid)
  account_id        text fk -> accounts.id
  date              text   -- YYYY-MM-DD (the effective date)
  amount_minor      integer -- SIGNED, in account.currency
  kind              text   -- 'opening' | 'adjustment' | 'revaluation' | 'transaction'(reserved)
  note              text   nullable
  created_at        integer
  created_by        text fk -> users.id
  -- (Slice 2 will add: category_id, transfer_group_id, etc.)

fx_rates              -- manual rates: value of 1 unit of `currency` in base currency
  id                text pk (uuid)
  currency          text   -- ISO 4217 (the non-base currency)
  date              text   -- YYYY-MM-DD effective date
  rate_scaled       integer -- rate_to_base * 1e8 (RATE_SCALE = 100_000_000)
  created_at        integer
  -- unique(currency, date)
```

**Currency minor-unit digits** (JPY=0, USD=2, BHD=3, …) are a **static ISO-4217 map in code**, not a table.

## 5. Money & Currency Semantics

- **Account balance** at a date: `balance(account, asOf) = Σ entries.amount_minor WHERE account_id = ? AND date <= asOf`. Pure integer SUM in SQL.
- **Sign convention:** amounts are signed in the account currency. Assets are normally positive; liabilities are normally negative (a credit card you owe carries a negative balance). `class` is for UI grouping only — **the sign carries the math**. Net worth is just the sum across all accounts; liabilities subtract naturally.
- **FX conversion** (account currency → base), done in **TS with BigInt** for exactness:
  ```
  base_minor = round( balance_minor
                      * 10^(base_decimals - acct_decimals)
                      * rate_scaled / RATE_SCALE )
  ```
  Base currency uses `rate_scaled = RATE_SCALE` (rate 1). For a given date, use the **latest fx_rate with date ≤ asOf** (carry-forward). If a non-base currency has **no applicable rate**, net worth flags it (UI warning) and that account is shown unconverted/excluded rather than silently mis-summed.
- **Net worth** at a date: `Σ over accounts convert(balance(account, asOf), account.currency → base, asOf)`.

## 6. Backfill Flows (the heart of onboarding)

All three are the **same mechanic** — insert a ledger entry — differing only by `kind` and intent:

1. **Opening balance (new account, no history):** on account creation, optionally insert an `opening` entry: `amount_minor = openingBalance`, `date = openingDate`. Done.
2. **"Set current balance to X" (backfill an existing asset/liability):** compute `delta = X − balance(account, chosenDate)` and insert an `adjustment` entry of `amount_minor = delta` at `chosenDate`. The derived balance now equals X without inventing fake history.
3. **Revaluation (non-cash assets that drift — investments, property):** same as (2) but `kind = 'revaluation'` — `delta = newValue − balance(account, date)` at the valuation date. These entries are what make the net-worth line move for assets without cashflow.

For liabilities, `X`/`newValue` are negative; the delta math is identical.

## 7. Net Worth Over Time (graph)

- Pick a bucketing (default **monthly**; user can switch to weekly/daily for short ranges) and a date range (default: first entry date → today).
- For each bucket boundary date `D`: compute net worth at `D` (Section 5). Account balances at each `D` come from a single SQL pass (cumulative SUM of entries per account up to each boundary); FX conversion + cross-currency rollup happen in TS with BigInt.
- Dataset is household-sized (hundreds–low-thousands of entries), so this is cheap; no materialized snapshots needed in v1. (If it ever matters, we cache per-bucket net worth — explicitly deferred, not built.)
- Output: `[{ date, netWorthBaseMinor }]` → rendered as a line chart. Headline = the latest point.

## 8. Auth

- **First run:** if `users` is empty, the app routes to an onboarding flow that (a) sets `household_name` + `base_currency`, and (b) creates the **first user as admin** (`is_admin = 1`).
- Subsequent users: an admin adds them (email + name + initial password). No public signup.
- **Sessions:** cookie-based, hashed session token in `sessions`, sane expiry. All server functions require a valid session except onboarding and login.
- **Attribution:** `created_by` on accounts/entries records who did what (used later; cheap to capture now).

## 9. Export

- Server endpoint streams the SQLite file (`Content-Disposition: attachment; filename="uang-YYYY-MM-DD.db"`). Implementation reads the on-disk DB file (ensuring a checkpoint/consistent read). This is a full, lossless backup that can be opened in any SQLite tool or restored by swapping the file on the volume.
- (Optional, time-permitting) a JSON export of accounts + entries + fx_rates for human-readable portability. Not required for v1.

## 10. UI Surfaces (minimal for Slice 1)

- **Onboarding / first-run:** household name, base currency, create admin.
- **Login.**
- **Dashboard:** net-worth headline (base currency) + net-worth-over-time line chart + accounts list grouped by asset/liability with current balances (each converted + native).
- **Account create/edit:** name, class, subtype, currency, institution, optional opening balance + date.
- **Account detail:** list of entries; actions: "Set balance to…", "Record revaluation", add/edit/delete entry.
- **Settings:** manage users (admin), FX rates (add rate for a currency at a date), export button, base currency (display; changing it post-hoc is a documented caveat, not a v1 feature).

## 11. Non-Functional

- **Money safety:** integer minor units end-to-end; BigInt for any multiply/divide (FX). No floats in money paths. Rounding rule documented (round-half-to-even at the final convert step).
- **Migrations:** drizzle-kit; run on boot; forward-only.
- **Persistence:** Railway volume; document the `DATABASE_URL` and volume mount; the app refuses to start writing to an ephemeral path in production.
- **Time zones:** entry dates are calendar dates (no TZ); timestamps are UTC epoch.

## 12. Testing Strategy (TDD)

Write tests first for the pure, high-value logic:

- `balanceAt(entries, asOf)` — integer SUM correctness, boundary dates inclusive.
- `convertToBase(amount, currency, date, rates, baseCurrency)` — BigInt math, differing minor-unit digits (JPY↔USD↔BHD), carry-forward rate selection, missing-rate handling.
- `setBalanceDelta(target, currentBalance)` — backfill delta, including liabilities/negatives.
- `netWorthAt(...)` and `netWorthSeries(...)` — multi-account, multi-currency, with revaluations.
- Integration: auth gating on server functions; first-run flow; export round-trip (export file → open → row counts match).

## 13. Open Questions / Defaults / Deferred

- **Default base currency:** none hardcoded — chosen at first run. *(Confirm at review if you want a preset default.)*
- **FX rates:** manual entry in v1; auto-fetch deferred.
- **Import/restore:** v1 = manual file swap on the volume (documented); in-app import deferred.
- **Read-only role:** deferred (all users equal in v1).
- **Multi-currency per account:** an account holds one currency; cross-currency moves are modeled later (Slice 2 transfers).
- **Net-worth snapshot caching:** deferred until/unless performance requires it.

---

### Deferred slices (own spec cycles)

- **Slice 2 — Cashflow & Budgets:** `entries.kind='transaction'`, categories, transfers (paired entries), monthly budgets vs actuals.
- **Slice 3 — Goals:** mid/long-term targets (savings target by date, net-worth target, debt payoff), on-track tracking against the net-worth series.
