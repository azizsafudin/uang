# Goal Spend / Decumulation + Waterfall — Design

**Date:** 2026-06-15
**Status:** Approved (design); pending implementation plan
**Feature:** Let a goal *spend* money at/after its target date (one-time, recurring flat, or a % withdrawal rate), and let a completed goal's freed contribution + surplus **cascade** to the next-priority goal — modelled by a month-by-month multi-goal cashflow simulation.

Builds on the merged Goals slice (`/goals`, allocation, per-goal contributions, projections). This is the decumulation piece deferred in the original projections design (§8).

---

## 1. Motivation

Today goals only *accumulate* toward a target, and each goal is projected independently. Two gaps:
1. **No spending.** A goal is really "buy a car" (spend a lump once) or "retire" (draw an income). We can't model money leaving.
2. **No rollover.** Finishing an earlier goal should free its savings (and any overshoot) to accelerate the next goal. Today goal B never benefits from goal A completing.

Both require modelling money *over time*, so the per-goal closed-form math is replaced by a single simulation.

---

## 2. Locked decisions (confirmed 2026-06-15)

- **Spend shapes:** one-time **and** recurring.
- **% withdrawal:** percent of the pot's **current balance, per year** (self-adjusting SWR; never fully depletes).
- **Waterfall cascade:** a finished goal's **freed monthly contribution AND its surplus/overshoot** flow to the next-priority remaining goal.
- **Spend starts at the goal's `targetDate`** (no separate spend date; a spend goal therefore requires a target date).
- **Scope:** per-goal outputs now. A household *combined* decumulation curve is deferred (§7).

---

## 3. Data model — `goals` new columns (migration)

| Column | Type | Meaning |
|---|---|---|
| `spendType` | text enum `'none' \| 'once' \| 'monthly' \| 'percent'` (default `'none'`) | How the goal spends at/after `targetDate`. `'none'` = pure accumulation (surplus still cascades). |
| `spendAmountMinor` | int \| null | For `'once'` (lump at `targetDate`) and `'monthly'` (flat $/month from `targetDate`). |
| `spendRateBps` | int \| null | For `'percent'` (annual % of current balance, e.g. `400` = 4%/yr from `targetDate`). |

Constraint (enforced in the route + form, not the DB): `spendType != 'none'` requires a non-null `targetDate`.

---

## 4. Engine — month-by-month multi-goal simulation (`packages/shared`)

A new pure function, e.g. `simulateGoals({ goals, accounts, planRateBps, fromMonth, horizonMonths })`, replacing the closed-form internals of `analyzeGoals`/`goalProjection`. Money is base-currency minor units, BigInt, banker's rounding (same discipline as the rest of `shared`).

**Priority order:** soonest `targetDate`, then smallest `targetAmountMinor`, then `id`; indefinite goals (no date) last. (Same comparator the list/allocation already use.)

**Initialisation:** allocate today's net worth across goals with the existing liquidity-aware eligibility (`allocateGoals`) → each goal's starting `balance`; remainder is unallocated/free (untouched by the sim).

**Each month `m` (0 → horizon):**
1. **Grow:** every goal `balance *= (1 + i)` where `i` = `planRateBps`/12/10000 (nominal monthly, as today).
2. **Contribute:** every *not-yet-reached* goal adds its own `monthlyContributionMinor`. A running **freed pool** (sum of finished goals' contributions) is added to the **soonest** not-yet-reached goal on top of its own.
3. **Reach:** if a not-yet-reached goal's `balance >= targetMinor` → record its **reach month**, cap `balance` at target, add `(balance − target)` **surplus** to the next not-yet-reached goal, and from next month add this goal's contribution to the freed pool.
4. **Spend** (only at/after the goal's `targetDate` month):
   - `once`: at the `targetDate` month, subtract `spendAmountMinor` (clamped to balance); the removed money is consumed; any remaining balance cascades to the next not-yet-reached goal (it's now surplus to this goal's purpose).
   - `monthly`: subtract `spendAmountMinor` each month (clamped at 0).
   - `percent`: each 12th month from `targetDate`, subtract `roundDiv(balance * spendRateBps, 10000)` (% of *current* balance).
   Consumed money leaves the simulation; the pot keeps growing at the plan rate underneath.

**Horizon:** `max(latest targetDate, today)` extended by a drawdown display window (default 30 years) so recurring spends are visible; future points are step-bounded (~≤120) as today.

**Determinism / purity:** no `Date.now()` in `shared`; the server passes `fromMonth`/`horizonMonths`/dates. Reuses existing `monthsToReachMinor`-style logic, now read off the simulation rather than closed-form.

---

## 5. Outputs (per goal, from the server `lib/goals.ts`)

The server gathers inputs (today's `netWorth`, members, settings, goals) and runs `simulateGoals`, then per goal returns:
- `series`: monthly `{ date, actual|null, projected|null }` — `actual` = realized balance for past months (re-allocated on `netWorth({asOf})` as today), `projected` = simulated balance forward, so the chart shows **accumulate → drawdown**.
- `reachDate` (now earlier, reflecting cascaded inflows), `onTrack` (balance ≥ target by `targetDate`), `allocatedMinor`, `progressPct`, `monthlyContributionMinor`, `requiredMonthlyMinor`, `sources` (unchanged shape).
- For recurring spends, a derived **income** figure: `monthly` → `spendAmountMinor`×12/yr; `percent` → `rate%` × balance-at-target/yr. Returned as `annualIncomeMinor | null` for display.

`analyzeGoals` (list) keeps its current response shape plus `spendType`; the heavy series stays on `goalProjection` (now sim-backed).

---

## 6. UI

- **Goal form:** a **Spend** section — a `spendType` select (None / One-time / Monthly / % of balance); when not None, an amount field (once/monthly) or a rate % field (percent). Validation: spend requires a target date.
- **Goal detail chart:** unchanged structure (solid Actual past → dashed Projected future, Target line), but the projected line now visibly **declines/steps down after `targetDate`** for spend goals. Y-axis already compact.
- **Goal detail stats:** add an **Income** / **Spends** row for spend goals (e.g. "Income ≈ SGD 40,000/yr" or "Spends SGD 50,000 once on 01 Jan 2030"); reach/surplus/shortfall as today.
- **List card:** show a small spend hint (e.g. "drawdown" / "income") where set; ordering unchanged.

---

## 7. Out of scope (deferred)

- **Household combined decumulation curve** (sum across all goals on `/projections`, showing FIRE accumulate→spend) — the natural next slice.
- Inflation / real terms; tax on withdrawals (SRS 50%-taxable, etc.); CPF LIFE payouts — still §8 deferred.
- Per-account contribution streams (vs per-goal) — separate concern.

---

## 8. Testing

- **Engine (`simulateGoals`)**: accumulation matches the old closed-form when no spend + no cascade (regression guard); one-time spend removes the lump at `targetDate`; `monthly` depletes linearly-ish; `percent` withdraws % of current balance and never fully depletes; **cascade** — a finished goal's contribution + surplus measurably accelerates the next goal's reach date vs running it alone; priority ordering respected.
- **Server**: `goalProjection`/`analyzeGoals` round-trip spend fields; series shows drawdown after `targetDate`; income figure correct.
- **API routes**: spend fields accepted on POST/PATCH; spend-requires-targetDate rejected (422) when violated.
- **Web**: `tsc` + manual smoke (no component tests in repo).
