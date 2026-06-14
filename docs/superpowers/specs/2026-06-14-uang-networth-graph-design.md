# Uang — Net Worth Over Time (graph) (design)

**Date:** 2026-06-14
**Status:** Draft for review
**Builds on:** the merged foundation + Plan 2 (accounts, ledger, FX, net-worth headline) + the account-ownership slice (owner filter on `netWorth`). This is a new slice not covered by the original spec.
**Parallel work:** developed alongside the holdings/investment-valuation slice (`slice4-holdings`). This slice treats `netWorth({ asOf, owner })` as a **stable contract** and is purely additive, so the two branches barely touch. Once holdings merges, investment accounts flow into the graph automatically with no rework here.

---

## 1. Goal

Show how household (or per-member) net worth has changed over time as a chart on the dashboard. The curve is **historical actuals** computed from existing ledger entries and FX rates — no new data is captured.

After this slice you can:
- See a weekly net-worth trend line on the dashboard, directly under the headline number.
- Switch the visible range via presets: **YTD · 1M · 6M · 1Y · 3Y · Custom** (default **1Y**).
- Have the chart follow the existing **household / member** toggle, so the curve always matches the headline's vantage point.

## 2. Scope

**In scope:** a read-only `GET /networth/series` endpoint; a new `lib/networth-series.ts` that loops the existing `netWorth` contract at weekly dates; a `net-worth-chart.tsx` dashboard component using the shadcn `chart` (Recharts); range presets + custom date range; owner passthrough; API tests for the series.

**Out of scope / deferred:**
- **Goals** (target net-worth line) — a later slice; will reuse this chart as a `ReferenceLine`.
- **Projections** (forward extrapolation) — its own later brainstorm; will append computed future points to the same `points[]`.
- Non-weekly granularity (daily/monthly). Every preset is weekly; no `interval` param.
- Any change to `valuation.ts`, `routes/networth.ts`, or the owner toggle.
- Bucketed-SQL optimization (see §7) — deferred until a real dataset proves the loop too slow.

## 3. Series semantics

- **Spacing:** weekly. The latest point is anchored on `to` (defaults to today), stepping **back** by 7 days until the date would fall before `from`, then reversed to ascending order. Anchoring on `to` guarantees the rightmost point equals the dashboard headline exactly.
- **Point value:** `netWorth({ asOf: date, owner }).totalBaseMinor` for each weekly date — the net worth *as of* that date, using the latest FX rate with `date <= asOf` (existing behavior).
- **Currency:** `baseCurrency` from the same computation (household base currency from `settings`).
- **Missing FX as-of a date:** accounts lacking an FX rate at that week are excluded from that week's total, exactly as the dashboard already does. The point is still emitted; the trend stays consistent with the headline's handling.

## 4. API

```
GET /networth/series?from=YYYY-MM-DD&to=YYYY-MM-DD&owner=<id|household>
→ { baseCurrency: string, points: Array<{ date: string; totalBaseMinor: number }> }
```

- `from` — required (ISO `YYYY-MM-DD`). Computed by the frontend from the active preset.
- `to` — optional; defaults to **today**.
- `owner` — optional; `household` (or absent) = whole household, else a `userId`. Passed straight through to `netWorth` (same filter as the headline).
- `from > to` → `{ baseCurrency, points: [] }` (no error).
- Behind the existing `authGuard`, like all other routes.
- Eden treaty surfaces it to the web client as `api.networth.series.get`.

## 5. Server module — `lib/networth-series.ts`

```ts
export type NetWorthPoint = { date: string; totalBaseMinor: number };
export type NetWorthSeries = { baseCurrency: string; points: NetWorthPoint[] };

export async function netWorthSeries(opts: {
  from: string;
  to?: string;          // defaults to today
  owner?: string;
}): Promise<NetWorthSeries>;
```

- Generate the weekly date list (§3), then **sequentially** `await netWorth({ asOf, owner })` per date — sequential keeps SQLite load gentle and ordering trivial.
- Collect `{ date, totalBaseMinor }` per week; take `baseCurrency` from any one result (or `settings` when `points` is empty).
- The route file `routes/networth-series.ts` is a thin Elysia handler validating the query and calling `netWorthSeries`. Registered next to `networthRoutes`.

## 6. Frontend — `components/net-worth-chart.tsx`

- Uses the shadcn **`chart`** component (Recharts), added via the **shadcn CLI** (project convention). Render an **area chart** of `totalBaseMinor` over the weekly `date` axis (filled area reads well for a slow-moving trend).
- **Props:** `owner: string` (passed down from the dashboard's existing toggle state).
- **Local state:** active preset (default `"1Y"`); for `Custom`, a `from`/`to` pair via two date inputs revealed only when `Custom` is selected.
- **Preset → range:** `YTD` = Jan 1 of the current year; `1M`/`6M`/`1Y`/`3Y` = today minus that span; `Custom` = the two inputs. All set `to = today` (except Custom).
- **Data:** `useQuery({ queryKey: ["networth-series", owner, from, to], queryFn: () => api.networth.series.get({ query: { from, to, owner } }) })`. Refetches when the owner toggle or range changes.
- **Display:** tooltip shows the point's date + `formatMoney(totalBaseMinor, baseCurrency)`; chart handles negative values (baseline at 0). Y-axis kept compact/minimal to match the dashboard's restraint.
- **Placement:** on `dashboard.tsx`, between the hero headline `section` and the Assets/Liabilities groups.

## 7. Performance note

The loop issues O(weeks × accounts) balance queries per load — e.g. `3Y` ≈ 156 weeks. For a personal dataset (tens of accounts) this is fast enough and React-Query-cached per `(owner, from, to)`. If a real dataset ever feels slow, the optimization is a bucketed running-balance SQL query (computed once, weekly FX join) — deliberately **deferred** because it would reimplement valuation and bypass the `netWorth` contract (losing the free holdings integration).

## 8. Testing

- **`routes/networth-series.test.ts`** (vitest, matching the API's existing test style):
  - Seed entries across several weeks; assert point count, weekly spacing, ascending order.
  - Rightmost point equals current `netWorth().totalBaseMinor`.
  - `to` defaults to today; explicit `to` respected.
  - `owner` filter restricts to that member's personal accounts (mirrors the headline).
  - `from > to` → `points: []`.
- **Web:** typecheck-verified only, matching the repo's API-tested / web-untested pattern.

## 9. Scope guardrails (merge safety)

Purely additive: **no** edits to `valuation.ts`, `routes/networth.ts`, or the owner toggle. New files only (`lib/networth-series.ts`, `routes/networth-series.ts`, `components/net-worth-chart.tsx`, the shadcn `chart` component) plus two insertion points (register the route; mount the chart in `dashboard.tsx`). Merge surface with `slice4-holdings` is effectively zero — and `valuation.ts`, if it conflicts at all, is owned by whoever merges second.
