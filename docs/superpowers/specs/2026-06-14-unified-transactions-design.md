# Unified Transactions Design

**Date:** 2026-06-14  
**Status:** Approved for implementation

## Summary

Replace the split ledger/holdings model with a single unified model where every account holds a portfolio of instruments. Cash (SGD, USD, etc.) is just another instrument. All account activity is recorded as signed unit changes on instruments via a single `transactions` table. No backward compatibility required — project is WIP with no users.

---

## Core Mental Model

Every account is a portfolio. It holds quantities of instruments. An instrument is anything with a quantity and a price — a currency, a stock, an ETF, a fund, or anything else. Cash is modeled as a currency instrument whose price is always 1.0 in its own denomination.

**Account value = Σ (units held per instrument × current price × FX rate to display currency)**

A cash-only savings account holds only a currency instrument (e.g. SGD). An investment account holds stocks and possibly cash instruments. Both use the same data model and the same UI shell.

---

## What Goes Away

| Removed | Replaced by |
|---|---|
| `entries` table | `transactions` table |
| `lots` table | `transactions` table |
| `kind` column (opening / adjustment / revaluation / transaction) | No kind — all rows are the same |
| `valuationMode` on accounts (ledger / holdings) | Removed — all accounts unified |
| `POST /accounts/:id/set-balance` | User adds a plain signed transaction |
| `POST /accounts/:id/revalue` | Removed — FX handled at net worth layer only |
| `GET /accounts/:id/entries` | `GET /accounts/:id/transactions` |
| `GET /accounts/:id/holdings` | `GET /accounts/:id/positions` |
| All `/entries/:id` and `/lots/:id` routes | `/transactions/:id` routes |
| Opening balance field on account creation | User adds first transaction manually |
| `LedgerDetail` and `HoldingsDetail` components | Single `AccountHistory` component |

---

## Schema

### `instruments` (extended)

Add `kind: "currency"` to the existing `kind` enum. Currency instruments are auto-seeded on demand — whenever a transaction references a currency (via `accounts.currency` on creation, or any currency symbol used in a transaction), the API ensures a matching instrument record exists. Users never need to manually create currency instruments.

```
instruments:
  id           TEXT PK
  symbol       TEXT        -- "SGD", "AAPL", "BTC"
  isin         TEXT
  name         TEXT NOT NULL  -- "Singapore Dollar", "Apple Inc."
  kind         TEXT NOT NULL  -- "currency" | "stock" | "etf" | "fund" | "crypto" | "other"
  currency     TEXT NOT NULL  -- denomination currency (for stocks: trading currency; for currency instruments: itself)
  created_at   TEXT NOT NULL
```

### `transactions` (new — replaces entries + lots)

```
transactions:
  id                TEXT PK
  account_id        TEXT NOT NULL  FK → accounts
  instrument_id     TEXT NOT NULL  FK → instruments
  date              TEXT NOT NULL  -- YYYY-MM-DD, backdating allowed
  units_delta       INTEGER NOT NULL  -- signed, ×1e8 (positive = acquire, negative = dispose)
  unit_price_scaled INTEGER        -- price per unit at trade time ×1e8 (for cost basis; 1e8 for currencies)
  fees_minor        INTEGER DEFAULT 0  -- fees in instrument's denomination currency minor units
  notes             TEXT
  created_at        TEXT NOT NULL
  created_by        TEXT NOT NULL
```

`units_delta` uses the same `SCALE = 1e8` convention as the existing `unitsScaled` and `priceScaled` columns. For currency instruments, **1 unit = 1 major currency unit** (e.g. 1 SGD, not 1 cent). A deposit of 500 SGD is stored as `500n * SCALE`. The `unit_price_scaled` for a currency instrument is always `SCALE` (i.e. 1.0), since 1 SGD is worth 1 SGD. This keeps the value formula uniform: `units_delta × unit_price_scaled / SCALE` gives the amount in the instrument's currency for all instrument kinds.

Transactions are fully editable after creation — all fields can be updated via `PATCH /transactions/:id`.

### `accounts` (modified)

- Remove `valuation_mode` column
- `currency` stays — used as the account's display currency (value shown in this currency)
- No `opening_balance_minor` or `opening_date` on creation payload

### Unchanged

- `prices` — market prices for non-currency instruments
- `fxRates` — exchange rates (serve as "prices" for currency instruments when converting to base)
- `accountOwners` — ownership unchanged

### Computed (not stored)

| Concept | How computed |
|---|---|
| Current position per instrument | `SUM(units_delta) GROUP BY instrument_id WHERE account_id = ?` |
| Weighted avg cost basis | `SUM(units_delta × unit_price WHERE units_delta > 0) / SUM(units_delta WHERE units_delta > 0)` |
| Unrealized gain | `(current_price − avg_cost) × units_held` |
| Realized gain (on sell) | `(unit_price_at_sell − avg_cost_at_sell) × units_sold` |
| Account value | `Σ (position × current_price × fx_to_display_currency)` |

---

## API

### New transaction routes

```
GET    /accounts/:id/transactions     list, sorted date desc
POST   /accounts/:id/transactions     create one transaction
PATCH  /transactions/:id              edit (date, units_delta, unit_price_scaled, fees_minor, notes)
DELETE /transactions/:id              delete
```

### New positions route (replaces /holdings)

```
GET /accounts/:id/positions
→ [{
    instrument: { id, symbol, name, kind, currency },
    units,               -- ×1e8
    avg_cost_scaled,     -- weighted average cost ×1e8
    current_price_scaled,
    market_value_minor,  -- in instrument's currency minor units
    unrealized_gain_minor
  }]
```

### Instruments

```
GET    /instruments
POST   /instruments             (non-currency instruments only; currencies auto-seeded)
PATCH  /instruments/:id
GET    /instruments/:id/prices
POST   /instruments/:id/prices
```

### Removed routes

`POST /accounts/:id/set-balance`, `POST /accounts/:id/revalue`, all `/entries/*`, all `/lots/*`

### Net worth (same routes, simpler implementation)

`GET /networth` and `GET /networth/series` are unchanged in interface. The implementation in `valuation.ts` loses the `valuationMode` branch — every account is computed the same way via positions.

---

## UI

### Account detail page

Single `AccountHistory` component replaces the `LedgerDetail` / `HoldingsDetail` split. Structure:

**Header:** account name, display currency, total value (in `accounts.currency`)

**Positions section** (eyebrow + card):
- One row per instrument held (units > 0)
- Columns: instrument name + kind badge, units held, value in display currency, unrealized gain/loss
- Currency instruments show a `cash` badge; non-currency show `stock`/`etf`/etc.
- No gain/loss shown for currency instruments (always `—`)

**History section** (eyebrow + card + "Add transaction" button):
- One row per transaction, sorted date desc
- Each row: icon (direction), instrument name, units delta, value equivalent in display currency, date
- Click row to edit (opens same form pre-filled)
- Hover reveals delete button

### Add transaction form

Single form that adapts based on the selected instrument's kind:

**Currency instrument selected:**
- Instrument picker (searchable; currencies listed first)
- Amount field — signed number, positive to add, negative to subtract; text turns green/red to confirm direction
- Date (pre-filled today, editable for backdating)
- Notes (optional)

**Non-currency instrument selected (stock, ETF, etc.):**
- Instrument picker
- Buy / Sell toggle (determines sign of `units_delta`)
- Units field
- Price per unit field (with instrument's currency label)
- Fees field (optional)
- Date
- Notes
- **"Also record cash outflow/inflow"** checkbox (checked by default): auto-creates a linked currency transaction for the cash leg. Shows the computed amount and a currency instrument picker (e.g. "−1,823.00 USD from US Dollar (USD)"). If checked, submitting the form creates two transactions atomically.

---

## FX and Valuation

Account-level FX revaluation entries are removed. The net worth layer handles all currency conversion — the same way holdings accounts already work today. Account balances always stay in native instrument units; conversion to display/base currency happens at query time via `fxRates`.

---

## Migration

No migration needed — fresh schema. Drop `entries` and `lots` tables, add `transactions`, extend `instruments` with `kind: "currency"`. Existing data can be discarded (WIP, no users).
