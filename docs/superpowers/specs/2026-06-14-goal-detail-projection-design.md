# Goal detail page + projection chart — Design

**Date:** 2026-06-14
**Status:** Approved (design)
**Feature:** Make each goal clickable into a dedicated detail page showing a donut progress chart and a time-series projection (history → on-plan vs eligible-accounts trajectory toward target). Move per-goal Edit/Delete into a 3-dot (⋮) menu.

Builds on the just-shipped Goals slice (`/goals` list, `goals` table, `GET /goals/analysis`, shared engine in `packages/shared/src/goals.ts`).

---

## 1. Navigation & list changes

- New route `/goals/$id` (guarded by `requireInitializedAndAuthed`, mirrors `/accounts/$id`).
- On `/goals`, each goal card body becomes a click target navigating to `/goals/$id`. The action controls (currently an inline "Edit" button + "✕" delete) are replaced by a **⋮ dropdown** (shadcn `dropdown-menu`, added via CLI) with **Edit** and **Delete** (destructive). The ⋮ button stops click propagation so it doesn't trigger card navigation.
- `GoalForm` gains optional controlled-open props (`open` / `onOpenChange`) and an option to render without its own trigger, so the menu's "Edit" item can open it. Default behavior (self-triggering "New goal" button) is unchanged.

## 2. Detail page contents (`/goals/$id`)

1. **Header** — goal name, "{target} by {date}", on-track/behind badge, ⋮ menu (Edit/Delete). Back link to `/goals`.
2. **Donut card** — recharts `PieChart` donut: two slices, **allocated** vs **remaining** (`max(0, target − allocated)`), `progressPct` centered. Beside it: allocated, target, and required-monthly figures.
3. **Projection chart** — a single monthly date x-axis from **today − historyMonths** through the **target date**:
   - **Past (≤ today):** `actual` = this goal's allocated value as of each past month-end (re-run allocation on `netWorth({asOf})` balances).
   - **Future (≥ today):** two lines —
     - **On-plan** = `compoundMonthlyMinor(allocatedToday, planRate, m) + annuityFutureValueMinor(requiredMonthly, planRate, m)` (today's allocation grown at the contribution-return rate plus the accumulating required contributions).
     - **Eligible** = Σ over this goal's allocation lines of `compoundMonthlyMinor(lineAllocated, lineGrowthRateBps, m)` (the allocated capital left to grow at each account's own rate, no new contributions).
   - The `actual`, `onPlan`, and `eligible` series all share the **today** point (= `allocatedToday`) so the lines join.
   - Client draws a horizontal **target** reference line and a **target-date** marker.

`planRate` = `settings.contributionGrowthRateBps`. `requiredMonthly` and the on-plan/eligible numbers reuse the existing analysis math so the figure shown matches the `/goals` list. The on-plan line therefore lands at ≈ target by the target date (small drift from per-account-annual vs plan-rate-monthly is acceptable and not surfaced).

## 3. Data — new server endpoint

`GET /goals/:id/projection?historyMonths=12` → handled by a new `goalProjection(goalId, historyMonths)` in `apps/api/src/lib/goals.ts`, reusing the shared engine and `netWorth`. Returns:

```ts
{
  baseCurrency: string;
  goal: { id; name; term; targetDate; currency };
  targetMinor: number;          // base currency
  allocatedMinor: number;       // today
  progressPct: number;
  requiredMonthlyMinor: number;
  onTrack: boolean;
  aheadByMinor: number;
  series: Array<{ date: string; actual: number | null; onPlan: number | null; eligible: number | null }>;
}
```

- Not found → 404.
- **Point bounding:** past points are monthly (≤ `historyMonths`, default 12). Future points step by `max(1, ceil(monthsToTarget / 120))` months so a far-dated goal stays under ~120 future points (the final point is always the target date). Each past point costs one `netWorth({asOf})` + allocation; bounded and on-demand.
- A goal created recently simply has fewer past points (allocation as-of dates before any data is 0 — that's fine).

## 4. Architecture / reuse

- All goal math stays server-side in `lib/goals.ts` over the pure `packages/shared/src/goals.ts` engine (`allocateGoals`, `compoundMonthlyMinor`, `annuityFutureValueMinor`, `goalOnTrack`) — same pattern as `analyzeGoals`. `goalProjection` shares the existing helpers (`yearOf`, `monthsBetween`, `targetInBaseMinor`, `toAllocAccounts`); extract any shared private logic rather than duplicating.
- Web: new `apps/web/src/routes/goals.tsx` detail component (or `goal-detail.tsx`), a `goal-projection-chart.tsx` (Recharts, styled like `projection-chart.tsx`), and a donut. `dropdown-menu` added via shadcn CLI. No `as any`.

## 5. Testing

- **API:** `lib/goals.test.ts` gains a `goalProjection` test — seed accounts + a goal, assert: series has past+future points, `actual` at today == `allocatedMinor`, `onPlan`/`eligible` defined only from today forward, future `onPlan` ≥ `eligible` when a contribution is required, last point at target date, 404 for unknown id (route test).
- **Web:** type-check (`tsc -b`); manual smoke (the repo has no web component tests).

## 6. Out of scope

Editing assumptions from the detail page (use Settings / account assumptions); separate total-vs-accessible split on the goal chart (one eligible line only); goal markers on the global `/projections` curve (already deferred).
