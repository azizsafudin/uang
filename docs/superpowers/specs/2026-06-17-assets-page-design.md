# Assets page — design

**Date:** 2026-06-17
**Status:** Approved (pre-implementation)

## Purpose

Turn the `/assets` stub into a two-tab analytical view of the household's assets:

- **Accounts** — every asset account in one place with allocation breakdowns, a richer/analytical counterpart to the dashboard's Assets section.
- **Holdings** — the investable portfolio rolled up *by instrument* across accounts (the same security held in several brokerages becomes one row), plus cash by currency. This lens exists nowhere else in the app.

Both tabs are scoped by a shared **owner toggle** (household / member), matching the dashboard.

## Out of scope (v1)

- Cost-basis and day-change columns on the Holdings table.
- Editing/creating accounts or holdings from this page (existing flows on dashboard / account detail remain the entry points).
- Liabilities (this page is assets-only; liabilities stay on the dashboard).
- Any new persisted state (no new tables/migrations).

## Page shell

- `AppShell` + `PageHeader` (eyebrow `Holdings`, title `Assets`).
- **Owner toggle** (household / member) reusing the dashboard's owner-selection pattern. Selection applies to both tabs.
- shadcn `Tabs` (`line` variant, as on account detail): **Accounts** · **Holdings**.
- Tab + owner selection live in component state (no URL search params in v1; can be promoted later if deep-linking is wanted).

## Accounts tab

**Data source:** existing `GET /networth?owner=<owner>` — no new API. Filter to `class === "asset"`.

- **Header:** Total assets = Σ `baseMinor` of asset accounts (excluding `missingRate` accounts), for the selected owner.
- **Allocation donut** with a dimension selector — chips: **By type** (subtype) / **Currency** / **Owner** / **Liquidity** (liquid vs illiquid). Each dimension buckets the asset accounts client-side and feeds the donut + legend (bucket label, base value, %).
- **Grouped account list:** reuse the dashboard's grouping (`visibleForOwner`, groups collection, `account-grouping`). Each account row links to `/accounts/$id`, shows its base value and %-of-assets; groups show subtotals. Accounts missing a rate are shown but flagged and excluded from totals/%.

**Reuse:** lean on `DashboardSection` / `section-card` and `account-grouping` helpers where they fit; factor shared bits rather than duplicating. The donut reuses the `goal-donut` / `ui/chart` building blocks.

## Holdings tab

**Data source:** new `GET /holdings?owner=<owner>` (see API below).

- **Header:** Portfolio value = Σ securities market value + Σ counted cash, in base currency, for the selected owner.
- **Allocation donut by asset class:** Stocks / ETFs / Funds / Crypto / Cash (buckets from the response).
- **Securities section:** one row per instrument, rolled up across all in-scope accounts. Columns: Holding (symbol + kind badge + name + account count), Units, Value (base), % of portfolio, Unrealized gain (▲/▼, colored). Row links to `/instruments/$id`. A position missing a price/FX rate is surfaced (flagged, excluded from totals) — mirror the existing `missing` treatment.
- **Cash section:** one row per currency. Counts currency positions **only from accounts whose subtype is `cash`, `bank`, or `investment`**. Columns: currency, account count, Value (base), % of portfolio. Units/Unrealized are `—`.
- Property / Vehicle / Other (and any non–cash-like subtype) do **not** appear on this tab — they live only on the Accounts tab.

## API

### `apps/api/src/lib/holdings.ts`

Pure rollup function, reusing `accountPositions` (lib/positions), `convertMinor` (lib/valuation), `getAllOwnerSets` (lib/owners), and the owner-filter logic from `netWorth`.

```ts
export type HoldingsOpts = { asOf?: string; owner?: string };

export type SecurityHolding = {
  instrumentId: string;
  symbol: string | null;
  name: string;
  kind: "stock" | "etf" | "fund" | "crypto" | "other";
  currency: string;            // instrument currency
  units: number;               // Σ net units across accounts, ×1e8
  valueBaseMinor: number;      // market value converted to base
  unrealizedGainBaseMinor: number;
  accountCount: number;        // distinct in-scope accounts holding it
  missing: boolean;            // any contributing position missing price/FX
};

export type CashHolding = {
  currency: string;
  valueBaseMinor: number;
  accountCount: number;
  missing: boolean;
};

export type Holdings = {
  baseCurrency: string;
  totalBaseMinor: number;             // securities + cash
  byKind: { kind: string; valueBaseMinor: number }[]; // donut buckets (stock/etf/fund/crypto/cash)
  securities: SecurityHolding[];      // sorted by valueBaseMinor desc
  cash: CashHolding[];                // sorted by valueBaseMinor desc
};

export async function holdings(opts?: HoldingsOpts): Promise<Holdings>;
```

**Algorithm:**
1. Resolve base currency + owner sets; select non-archived **asset** accounts; apply the same owner filter as `netWorth` (a member sees only accounts they solely own).
2. For each in-scope account, call `accountPositions(accountId, asOf)`.
3. **Securities** (`kind !== "currency"`): aggregate by `instrumentId` — sum units, convert each `marketValueMinor`/`unrealizedGainMinor` from the instrument currency to base via `convertMinor`, sum, count distinct accounts. A null conversion or `missingPrice` sets `missing` and is excluded from the value totals.
4. **Cash** (`kind === "currency"`): include only when the **account's subtype ∈ {cash, bank, investment}**. Aggregate by currency; convert each to base; count accounts; flag `missing` on null conversion.
5. `byKind` sums securities by kind plus a single `cash` bucket. `totalBaseMinor` = Σ securities value + Σ cash value (excluding missing).

### `apps/api/src/routes/holdings.ts`

Elysia route mirroring `networthRoutes`:

```ts
export const holdingsRoutes = new Elysia()
  .use(authGuard)
  .get("/holdings", async ({ query }) => holdings({ asOf: query.asOf, owner: query.owner }), {
    query: t.Object({ asOf: t.Optional(t.String()), owner: t.Optional(t.String()) }),
  });
```

Register in `apps/api/src/app.ts` with `.use(holdingsRoutes)`. Eden types flow automatically via the `App` export.

## Components (web)

- `apps/web/src/routes/assets.tsx` — page: owner toggle + tabs, fetches `/networth` and `/holdings` (TanStack Query), renders the two tab panels.
- `apps/web/src/components/assets-accounts-tab.tsx` — header, allocation donut + dimension selector, grouped account list.
- `apps/web/src/components/assets-holdings-tab.tsx` — header, asset-class donut, securities table, cash table.
- `apps/web/src/components/allocation-donut.tsx` — small reusable donut + legend over `{ label, valueBaseMinor }[]` (wrapping `ui/chart` / the `goal-donut` approach). Used by both tabs.
- Reuse `Money`, `labels` (`subtypeLabel`, `instrumentKindLabel`), `OwnerPills`, `account-grouping`, and `DashboardSection`/`section-card` where they fit.

## Edge cases

- **No asset accounts / empty holdings:** each tab shows a quiet empty state ("No assets yet" / "No holdings yet"), not a broken chart.
- **Missing price/FX:** flagged inline and excluded from totals and %, consistent with account-detail's `missing` handling.
- **Member owner with shared-only accounts:** shared accounts (≥2 owners) are excluded for a specific member, identical to `netWorth`; totals/% recompute for the visible set.
- **Single-bucket allocation:** donut still renders (one full-circle segment); legend lists the one bucket.
- **Currency-only portfolio (no securities):** Securities section hidden/empty; Cash + donut still render.

## Testing

- **Route tests** (`apps/api/src/routes/holdings.test.ts`): rollup across two accounts holding the same instrument → one security row with summed units/value and `accountCount: 2`; cash counted only for cash/bank/investment subtypes (property excluded); owner filter parity with `netWorth`; `missing` flagging on absent price/FX; base-currency conversion correctness.
- **Web:** typecheck via `cd apps/web && bun run build`.
- **E2E (end of slice):** a focused `assets.spec.ts` — tabs switch, owner toggle filters both tabs, securities row navigates to instrument detail, account row navigates to account detail. Run only the affected spec(s) per the testing workflow.
