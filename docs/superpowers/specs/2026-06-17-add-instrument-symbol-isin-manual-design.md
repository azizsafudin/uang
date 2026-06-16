# Add-instrument with Symbol / ISIN / Manual modes

Date: 2026-06-17

## Problem

Instruments are created only inside the **Add-transaction** dialog, via inline
fields *Name / Symbol (optional) / Currency / Kind*. There is **no ISIN field**.

Users therefore type an ISIN into the *Symbol* box. Real production data: three
Amundi funds have `isin` empty and the ISIN sitting in `symbol`
(`LU2420246139`, `LU2420245917`, `LU2420246055`). The Yahoo resolver only runs a
provider *search* when `inst.isin` is set; for a bare `symbol` it appends an
exchange suffix (`.SI` for SGD), producing `LU2420246139.SI` — which Yahoo does
not recognise ("No data found"). The refresh marks the instrument `unsupported`,
no price is written, and the UI shows "—". This is the reported "Update prices
isn't working" bug, and its root cause is **data entry**: there is no guided way
to declare "this identifier is an ISIN".

## Goals

1. Guided instrument creation with three modes: **Symbol**, **ISIN**, **Manual**.
2. Symbol/ISIN modes look the identifier up via the market-data provider and show
   a **read-only preview** (name, currency, kind, latest price). The identifier is
   the source of truth; looked-up fields are **not editable**.
3. **Manual** mode (secondary / hidden behind a toggle) for instruments with no
   provider data: *Name, Currency, Kind*; priced manually afterwards.
4. New standalone **"Add instrument"** entry point on `/instruments` (creates an
   instrument with no transaction).
5. Reuse the same form component inside the Add-transaction "New instrument…" path.

### Non-goals

- **No change** to the Yahoo resolver logic.
- **No migration** of existing data — the user fixes the three funds by hand
  (edit instrument → move the value into the ISIN field; the edit dialog already
  exposes Symbol + ISIN and they are editable while no provider price exists).
- **No editing** of looked-up name/currency/kind. Manual mode is the escape hatch.

## Data model — unchanged

The `instruments` table already has `symbol`, `isin`, `name`, `kind`, `currency`,
and `POST /instruments` already accepts an optional `isin`. **No schema change.**

## Backend: lookup endpoint

New auth-guarded route `POST /market-data/lookup`.

- **Body:** `{ query: string }` — the symbol or ISIN, trimmed and upper-cased.
- **Logic** (`lookupInstrument(query)` in `apps/api/src/lib/market-data`, Yahoo-only):
  1. Yahoo search `?q=<query>` → quotes filtered to `isYahooFinance` with a
     `symbol`, sorted by `score` desc; take the top.
  2. If none → `{ found: false }`.
  3. Chart fetch (`range=5d&interval=1d`) for the top symbol → `price`, `currency`,
     `date`.
  4. Map `quoteType` → kind: `EQUITY`→`stock`, `ETF`→`etf`, `MUTUALFUND`→`fund`,
     `CRYPTOCURRENCY`→`crypto`, else `other`.
  5. Return `{ found: true, resolvedSymbol, name, currency, kind, price, date,
     source: "yahoo" }`.
- A result counts as **found only if it yields both a name and a price** — that
  guarantees the preview always shows a price and that "Update prices" will be
  able to reproduce it. Otherwise `{ found: false }` (→ nudge to Manual).
- Implemented by extending the Yahoo provider with a `lookup(query)` method
  (reuses the existing `chartFetch`, search code, `HEADERS`, and `endpoints`),
  plus a new `InstrumentLookupResult` type. Alpha Vantage is **not** wired into
  lookup (it can't resolve these funds).

## Frontend

### Shared component `NewInstrumentForm`

A single component used by both entry points. It owns the mode toggle, the
lookup/preview, and the manual fields, and **publishes a validated spec** to its
parent (it does not create anything itself — creation happens on the parent's
submit, per the "create on final Add" decision):

```ts
type NewInstrumentSpec =
  | { name: string; kind: Kind; currency: string; symbol: string | null; isin: string | null };
// lookup(Symbol): symbol = resolvedSymbol, isin = null
// lookup(ISIN):   isin   = entered ISIN,  symbol = null
// manual:         symbol = null, isin = null
```

- Prop `onResolved(spec: NewInstrumentSpec | null)` — publishes the current valid
  spec, or `null` while incomplete. The parent stores it and creates on submit.

**UI**
- Segmented toggle **Symbol · ISIN** (default Symbol), plus a secondary
  *"Can't find it? Add manually"* button that switches to Manual mode.
- **Lookup modes:** identifier input + **Find** button → `POST /market-data/lookup`.
  - *found* → read-only **preview card** (name · kind · currency · price as of
    date); publishes the spec (storing the **resolved** symbol for Symbol mode, so
    the preview price equals what the later refresh fetches — avoids e.g.
    Swiss `NESN` → `NESN.SW` mismatches).
  - *not found / error* → inline "No match found. Try Manual entry…"; publishes
    `null`.
  - Editing the identifier after a successful Find clears the preview until the
    next Find.
  - ISIN mode applies a light client-side format hint (`^[A-Z]{2}[A-Z0-9]{9}[0-9]$`).
- **Manual mode:** *Name*, *Currency* (defaulted), *Kind* select; publishes a
  spec with `symbol`/`isin` null once name + currency are valid.

### Standalone "Add instrument" on `/instruments`

- An **"Add instrument"** button beside "Update prices".
- Opens a `ResponsiveDialog` with `<NewInstrumentForm>` + Add/Cancel.
- **On Add:** `POST /instruments` from the spec → id; if it was a lookup spec,
  call the existing `POST /market-data/instrument/:id/refresh { backfill: true }`
  to populate prices (gracefully grabs the latest price when there are no
  transactions). Refetch the instruments collection; close.
- A standalone instrument has 0 holders until a transaction references it — fine;
  the list already renders `holderCount`.

### Add-transaction integration

- Replace the inline `instrumentId === NEW_INSTRUMENT` field block with
  `<NewInstrumentForm>`. The dialog keeps the resolved spec in state.
- The trade fields (Side/Units/Price/Fees) appear once a spec is resolved (the
  spec's `currency` drives the price label).
- **On submit (NEW_INSTRUMENT):** create the instrument from the spec → id; run
  the existing trade-leg logic with that id (units/price/fees + optional cash
  leg); then, for lookup specs, call refresh `{ backfill: true }` so the
  instrument shows a provider price series in addition to the trade price.
- The **Add** button is disabled until the spec is resolved (non-null) and the
  trade fields are valid.

## Error handling

- Lookup network error → treated as "not found" with a retry-able inline message.
- Duplicate symbol on create → API `409 duplicate_symbol` → "An instrument with
  this symbol already exists."
- Backfill failure after create → the instrument is still created; show a subtle
  note; price stays "—" until the next "Update prices".

## Testing

- **API unit:** Yahoo `lookup` (mock search + chart) — found maps
  `quoteType`→kind with currency/price from chart; not-found path (no quote, or
  quote without a price).
- **API route:** `POST /market-data/lookup` happy path + not-found.
- **Web:** `NewInstrumentForm` behaviour — mode toggle, Find→preview, not-found
  nudge, manual publish; disabled Add until resolved.
- **E2E (affected only):** add an instrument via ISIN on `/instruments` → after
  "Update prices" it shows a price; add via Add-transaction creates instrument +
  transaction together. Likely specs: `instruments.spec.ts`, `transactions.spec.ts`.

## Affected files

- **api:** `lib/market-data/providers/yahoo.ts` (+`lookup`), `lib/market-data/types.ts`
  (+`InstrumentLookupResult`), `routes/market-data.ts` (+`/lookup`), Eden types.
- **web:** new `components/new-instrument-form.tsx`; new
  `components/add-instrument-dialog.tsx`; edits to `routes/instruments.tsx` and
  `components/add-transaction-dialog.tsx`; `lib/api` types.
