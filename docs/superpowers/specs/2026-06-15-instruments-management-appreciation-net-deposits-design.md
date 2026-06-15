# Instruments management, appreciation fix, and net-deposits line — design

Date: 2026-06-15

## Problem

Three related gaps in the `uang` app:

1. **No way to manage existing instruments and prices.** Instruments are auto-created
   when logging transactions; there is no UI to list them, see which accounts hold them,
   edit/delete them, or manage their historical prices.
2. **Backdated trades don't appreciate on the net-worth chart.** Logging a backdated buy
   at a price, then setting a higher price today, does not show appreciation. Root cause:
   a trade's price is stored only on the transaction (cost basis); the chart values
   holdings from the separate `prices` table via carry-forward, so a backdated buy with no
   price row contributes $0 until a price exists on/before that date.
3. **The net-worth chart shows only one line.** The user wants two lines: **net deposits**
   (external cash in − out) and **net worth** (= net deposits + appreciation), so the gap
   between them is appreciation.

## Decisions (from brainstorming)

- A trade **is** a price observation at its (possibly backdated) date. Trades seed price
  history; valuation carries the price forward until a newer price exists.
- **Net deposits = external cash in − out.** Standalone cash deposits/withdrawals count;
  cash legs paired with a buy/sell are internal and excluded.
- **Deleting an instrument** warns with a summary of affected accounts/transactions and
  requires explicit destructive confirmation, then cascades.

## Section 1 — Data model changes (API)

**a. Trades seed price history (appreciation fix).**
When `POST /accounts/:id/transactions` logs a transaction for a **non-currency** instrument
with a non-null `unitPriceScaled`, upsert a `prices` row for `(instrumentId, date)` with
`source = "trade"`, using **insert-if-absent** semantics:

- If no price row exists for that `(instrumentId, date)`, insert one (`source="trade"`).
- If a row already exists (manual or earlier trade), **leave it** — a manual price always
  wins, and the first trade of a day sets the observed price.

`PATCH /transactions/:id`: when a trade's `date` or `unitPriceScaled` changes, update its
trade-sourced price row (only rows with `source="trade"`; never overwrite a `manual` row).

**Known limitations (documented, acceptable for WIP):**
- Deleting a transaction does **not** delete its trade-seeded price row. Prices are
  independent market observations; users manage/delete them on the instruments page.
- Multiple trades on the same date: first one sets the observed price (insert-if-absent).

**b. Mark linked transactions (net-deposits support).**
Add a nullable column `linkedTransactionId TEXT` (FK → `transactions.id`) to `transactions`.
Generic name (not `cashLegOf`) to allow future paired/transfer transactions. When a buy/sell
auto-creates a cash leg, set `linkedTransactionId = <main txn id>` on the cash leg.

Migration backfills existing cash legs best-effort: match a currency-instrument transaction
to a non-currency trade in the same `accountId` with identical `createdAt` and `date`. For
this single-user WIP, imperfect matches are acceptable; documented.

**Net deposits** = currency-instrument transactions where `linkedTransactionId IS NULL`
(standalone deposits/withdrawals), signed by `unitsDelta`.

## Section 2 — API endpoints

- **`PATCH /instruments/:id`** (new) — edit `name`, `symbol`, `isin`, `kind`, `currency`.
- **`DELETE /instruments/:id`** (new) — cascade-delete the instrument plus its `prices` and
  `transactions` (including cash legs linked to those transactions). Without `?confirm=true`
  returns **409** with an impact summary `{ accounts: [{ id, name, txCount }], totalTx }`.
  With `?confirm=true`, performs the cascade and returns `{ ok: true }`.
- **`GET /instruments/:id`** (new) — detail: the instrument, its **holders** (accounts with
  non-zero net units → `{ accountId, name, units, marketValueMinor }`), and per-account
  transaction counts (powers the holders list and the delete-impact warning).
- **`GET /instruments`** (extended, additive only) — each instrument gains
  `latestPriceScaled`, `latestPriceDate`, `holderCount`. Existing consumers (TanStack DB
  `instrumentsCollection`) ignore extra fields.
- **Prices** — reuse existing `GET/POST /instruments/:id/prices` and `DELETE /prices/:id`.
- **`GET /networth/series`** (extended) — each point gains `netDepositsBaseMinor` alongside
  `totalBaseMinor`.

## Section 3 — Instruments page UI (web)

- **Sidebar:** add `{ to: "/instruments", label: "Instruments", icon: <CandlestickChart/Coins> }`
  to `NAV` in `nav-main.tsx`.
- **Routes:** `/instruments` (list) and `/instruments/:id` (detail), registered under
  `appLayoutRoute` in `router.tsx`, mirroring the accounts list/detail pattern.
- **List page (`/instruments`):** table — symbol, name, kind, currency, latest price (+date),
  # accounts holding. Row → detail. Currency instruments are listed but flagged as implicit
  price 1.0 (no price management).
- **Detail page (`/instruments/:id`):**
  - Header with instrument fields; **Edit** (dialog) → `PATCH /instruments/:id`.
  - **Delete** (destructive) → fetch impact via `GET /instruments/:id`, show a confirm
    dialog summarizing affected accounts + transaction counts, then `DELETE ?confirm=true`,
    invalidate caches, navigate back to the list.
  - **Holders** section: accounts holding it (units, market value), linking to account detail.
  - **Price history** section: table of prices (date, price) with add/edit/delete (reuses
    price routes + the existing `update-price` pattern). Hidden for `kind="currency"`.
- Mutations use Eden + invalidate `["networth"]`, `["positions", …]`, and refetch the
  instruments collection, following existing conventions.

## Section 4 — Net-worth chart (web)

- **Backend** (`networth-series.ts`): compute `netDepositsBaseMinor` per weekly point.
  Gather external flows once (currency transactions with `linkedTransactionId IS NULL`),
  convert each to base currency at the **flow date's** FX rate (money-weighted contributions),
  then accumulate the cumulative sum for flows with `date <= point.date`.
- **Frontend** (net-worth-over-time chart component): add a second line **Net deposits**
  alongside the existing **Net worth** line. Legend + tooltip showing both values and the
  derived **appreciation = net worth − net deposits**.

## Section 5 — Edge cases & semantics

- FX for net deposits uses the flow-date rate, so FX movement on contributed cash shows up
  as appreciation (consistent with how net worth values are converted as-of date).
- A security buy logged **without** a cash leg won't register as a deposit (no external cash
  flow), so its full value reads as appreciation. The add-transaction dialog encourages cash
  legs; documented limitation.
- Currency instruments are never priced (implicit 1.0); price management is hidden for them.

## Section 6 — Testing

- **Route tests:** `PATCH`/`DELETE /instruments/:id` (cascade + the `confirm` gate + impact
  summary), `GET /instruments/:id` holders, trade-price seeding on `POST .../transactions`
  (insert-if-absent, no clobber of manual), `netDepositsBaseMinor` in `/networth/series`.
- **Lib tests:** `netWorthSeries` net-deposits accumulation; `linkedTransactionId` exclusion
  of cash legs; the backdated-buy → later-price appreciation scenario (carry-forward).
- **Typecheck:** `cd apps/web && bun run build` after API changes.
- **E2E:** run only affected specs at end of slice (instruments, transactions, net-worth).

## Phasing

The work is one coherent slice but can land in phases if useful:
1. Data model + appreciation fix (Section 1a) + net-deposits backend & chart line (4).
2. `linkedTransactionId` column + net-deposits semantics (1b).
3. Instruments management page + endpoints (2, 3).
