# Uang — Net-Worth Series Caching (design)

**Date:** 2026-06-14
**Status:** Draft for review
**Builds on:** the merged net-worth-over-time graph (Plan 5) + holdings (Plan 4). This refines how the chart's series is fetched and cached. No schema change.

---

## 1. Goal

Make the net-worth chart smooth (daily resolution) and range-switching instant, without recomputing overlapping dates on every range change. Fetch the full daily history **once per owner**, cache it in a TanStack DB collection, and have the range presets slice that in-memory series client-side.

This also settles a persistence question: the genuinely expensive future cost is **price-API calls**, and those are cached by the existing `prices` table (immutable `(instrument, date)` history). The *computed* series is cheap to derive from local prices, so it is cached **client-side**, not materialized server-side. No new server table; no cache-invalidation layer.

## 2. Scope

**In scope:**
- `netWorthSeries` gains an optional `interval` (`"week" | "day"`) and an optional `from` (defaults to the earliest data date).
- `GET /networth/series` accepts optional `from` and an `interval` enum.
- A new web module `lib/networth-series-collection.ts`: a per-owner, memoized, read-only TanStack DB collection holding the full daily series.
- `net-worth-chart.tsx` reads the collection via `useLiveQuery` and slices client-side per preset.

**Out of scope / deferred:**
- A materialized per-account timeseries table + cache invalidation (not needed; prices already persisted).
- The **price-sync** service that backfills/updates `prices` from a real pricing API — its own later slice. The series reads `prices` today, so it benefits with no rework.
- Server-side HTTP response caching of the series.

## 3. Backend — series computation

`lib/networth-series.ts`:

```ts
export async function netWorthSeries(opts: {
  from?: string;        // defaults to earliest data date
  to?: string;          // defaults to today
  owner?: string;
  interval?: "week" | "day";   // defaults to "week"
}): Promise<NetWorthSeries>;   // { baseCurrency, points: [{ date, totalBaseMinor }] }
```

- **Step:** generalize `weeklyDates(from, to)` → `seriesDates(from, to, stepDays)`, `stepDays = interval === "day" ? 1 : 7`. Still anchored on `to` and stepping back, returned ascending (the last point stays as-of-`to`, matching the headline).
- **Default `from`:** the **earliest data date** = `min(min(entries.date), min(lots.tradeDate))`. A new helper `earliestDataDate(): Promise<string | null>` runs both `min(...)` queries and returns the lesser (or `null` when there is no data).
  - If `from` is omitted and there is no data → `points: []`, base currency still reported (settings fallback).
- **`from > to`** → `points: []` (unchanged).
- Sequential `netWorth({ asOf, owner })` per date (unchanged). Reads persisted prices via carry-forward, so daily resolution adds no API calls.

`routes/networth-series.ts`:

```
GET /networth/series?from?=YYYY-MM-DD&to?=YYYY-MM-DD&owner?=…&interval?=week|day
```

- `from` optional; `to` optional; `owner` optional; `interval` optional (`t.Optional(t.Union([t.Literal("week"), t.Literal("day")]))`). Still behind `authGuard`.

## 4. Web — `lib/networth-series-collection.ts`

A per-owner memoized collection, matching the `entriesCollection`/`lotsCollection`/`pricesCollection` factory pattern:

```ts
export type SeriesPointRow = {
  date: string;          // YYYY-MM-DD, the collection key
  totalBaseMinor: number;
  baseCurrency: string;  // denormalised (constant across points; simplest read)
};

export function networthSeriesCollection(owner: string): /* Collection<SeriesPointRow,…> */;
```

- `queryKey: ["networth-series", owner]`, `getKey: (p) => p.date`.
- `queryFn` calls `api.networth.series.get({ query: { owner, interval: "day" } })` → maps `points` to `SeriesPointRow[]`, attaching `baseCurrency` to each row.
- Read-only (no `onInsert`/`onUpdate`/`onDelete`).
- Memoised per `owner` in a `Map`, like the other factories. Lives in its own file to avoid colliding with in-progress `collections.ts` edits (can be folded in later).
- **Types modeled explicitly** — no `as any` (project rule). The Eden response is narrowed to the point shape without `any`.

## 5. Web — `net-worth-chart.tsx`

- Replace the `useQuery(fetchSeries…)` call with `useLiveQuery` over `networthSeriesCollection(owner)`, yielding the full daily series ascending by date.
- The existing preset/custom logic computes `{ from, to }`; the chart now **filters the in-memory rows** to that window (`date >= from && date <= to`) instead of refetching. Range changes are instant.
- Map the filtered rows to `{ t: Date.parse(`${date}T00:00:00Z`), net: totalBaseMinor }` for the existing time-scale axis. `baseCurrency` from any row (`rows[0]`).
- Loading/empty: derive from the live-query state (collection initial load) + empty window; keep the existing skeleton and "No data for this range." states.
- The time-axis ticks, tooltip (exact date), and `formatDay` helper are unchanged.

## 6. Testing

- **`routes/networth-series.test.ts`** (vitest, run from `apps/api`): add/adjust for
  - `interval: "day"` → consecutive daily dates, ascending, last point = `to`.
  - `from` omitted → series starts at the earliest data date (seed entries/lots at known dates; assert the first point).
  - `from` omitted with no data → `points: []`, base currency reported.
  - existing `interval: "week"` default + `from > to` → empty still hold.
- **Web:** typecheck-verified via `bun --cwd apps/web run build` (no `as any`).

## 7. Scope guardrails (merge safety)

Additive and disjoint from in-progress work: new file `lib/networth-series-collection.ts`; edits confined to `lib/networth-series.ts`, `routes/networth-series.ts`, `net-worth-chart.tsx`, and the series test. **No** change to `collections.ts`, `valuation.ts`, `holdings.ts`, `app.ts` route mounts, or the DB schema.
