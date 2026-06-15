# Per-account withdrawals on /projections

**Date:** 2026-06-15
**Status:** Approved (design)

## Problem

The `/projections` page compounds every account forward indefinitely — it only ever
accumulates. There is no way to model **decumulation** (spending down the pot in
retirement), so the net-worth curve never bends down. The goals page already models
spend (`spendType` none/once/monthly/percent) per goal; we want the equivalent on
projections, configured **per account**, and saved.

Additionally, the per-account projection assumptions (growth rate, accessibility,
liquidity) currently live on the `/accounts/:id` **Details** tab. They should move to
`/projections` so all decumulation/forecast planning lives in one place — **one
coherent card per account** holding both the existing assumptions and the new
withdrawal config.

## Decisions (from brainstorming)

- **Granularity:** per account (not household-level).
- **Spend types:** full goals parity — `none` / `once` / `monthly` / `percent`.
- **Start trigger:** per account, either **owner age** or **account's own balance
  reaching a target amount**. The user picks one kind per account.
- **Target meaning:** the account's *own* projected balance (not total net worth).
- **Persistence:** saved to the DB.
- **Currency:** withdrawal **amounts are in base currency**. The projection is a
  base-currency net-worth forecast; storing amounts in base keeps the math clean and
  avoids converting a withdrawal at a future date's FX rate. The UI labels the amount
  with the base currency.
- **Edit location:** on `/projections`, in a consolidated per-account card. The
  projection card is **removed** from the `/accounts/:id` Details tab.

## Data model

Add six columns to the `accounts` table (`apps/api/src/db/schema.ts`), all defaulting
to "no withdrawal" so existing rows are unaffected:

```
spendType             text enum ["none","once","monthly","percent"]  NOT NULL DEFAULT "none"
spendAmountMinor      integer (nullable)   -- base minor units: 'once' lump / 'monthly' per-month amount
spendRateBps          integer (nullable)   -- 'percent' annual % of balance (400 = 4%/yr)
spendStartKind        text enum ["age","target"]  NOT NULL DEFAULT "age"
spendStartAge         integer (nullable)   -- start when youngest owner reaches this age
spendStartTargetMinor integer (nullable)   -- base minor units: start when this account's projected balance reaches this
```

Generate a new drizzle migration (`apps/api/drizzle/0008_*.sql`) via `bun run db:generate`.
It is applied automatically on API startup (`runMigrations`).

### Field semantics

- `spendType = "none"`: pure accumulation (current behaviour).
- `spendAmountMinor`: used by `once` (lump) and `monthly` (per-month flat). Null otherwise.
- `spendRateBps`: used by `percent` (annual % of current balance). Null otherwise.
- `spendStartKind = "age"`: withdrawal begins the first projection year where
  `year − youngestOwnerBirthYear ≥ spendStartAge`. Uses the youngest owner's birth
  year (the binding constraint, consistent with existing accessibility logic). If the
  account has no owner birth years, an age trigger never fires.
- `spendStartKind = "target"`: withdrawal begins the first projection year where the
  account's **post-growth** projected balance ≥ `spendStartTargetMinor`. Latches on
  once reached (does not turn off if the balance later dips below the target).

## Withdrawal math — `packages/shared/src/projection.ts`

Today `projectNetWorth` calls `projectSeries` (compound-only) per account. We extend
the projection account type and add withdrawal-aware simulation. `projectSeries`
stays unchanged (still used for contribution-only compounding elsewhere).

### Types

```ts
export type WithdrawalConfig = {
  spendType: "none" | "once" | "monthly" | "percent";
  spendAmountMinor: number | null;   // base minor: 'once' lump / 'monthly' per-month
  spendRateBps: number | null;       // 'percent' annual % of balance
  spendStartKind: "age" | "target";
  spendStartAge: number | null;
  spendStartTargetMinor: number | null;
};

export type ProjectionAccount = AccessibilityConfig & WithdrawalConfig & {
  baseMinor: number;       // current base-currency balance (signed)
  growthRateBps: number;
  ownerBirthYears: number[];
};
```

### Per-account yearly simulation

New function `projectAccountSeries(account, span, youngestOwnerBirthYear, fromYear)`
returning `number[]` (balance at each offset `0..span`):

- Offset `0`: `bal = baseMinor` (today, untouched — no withdrawal at t0).
- For each offset `1..span` (let `year = fromYear + offset`):
  1. **Grow:** `bal = compound one year at growthRateBps` (banker's rounded, as
     `projectSeries` does).
  2. **Determine started** (latches `true` once set):
     - age: `youngestOwnerBirthYear !== null && (year − youngestOwnerBirthYear) ≥ spendStartAge`
     - target: `bal ≥ spendStartTargetMinor`
  3. **Withdraw** (only when started and `bal > 0`):
     - `once`: subtract `min(spendAmountMinor, bal)` in the **first started year only**
       (latch `finishedOnce`).
     - `monthly`: subtract `min(spendAmountMinor × 12, bal)` each year.
     - `percent`: subtract `roundDiv(bal × spendRateBps, BPS)` each year.
  4. Floor `bal` at 0; record `bal` for this offset.

Withdrawal order is **grow-then-withdraw** (earn the year's return, then take the
distribution). `spendType = "none"` skips steps 2–3 entirely → identical to today.

Liability / negative-balance accounts: the `bal > 0` guard means withdrawal never
applies to them even if misconfigured. The UI also hides withdrawal for liabilities.

### Aggregation

`projectNetWorth` is updated to, per account, compute its withdrawn series via
`projectAccountSeries`, then for each offset:
- **Total** = sum of withdrawn balances.
- **Accessible** = sum of `accessibleValueMinor(withdrawnBal, age, accessibilityConfig)`
  (existing age-gating, now applied to the post-withdrawal balance).

`milestoneYears` is unchanged.

### Tests (`packages/shared`)

Unit tests for `projectAccountSeries` / `projectNetWorth`:
- `none` → identical series to compound-only baseline.
- `once` with age trigger → lump removed in the trigger year, nothing after.
- `monthly` with age trigger → 12× amount removed each year from start.
- `percent` with age trigger → rate% removed annually; balance asymptotes, never < 0.
- `target` trigger → starts the first year the balance crosses the target; latches.
- depletion → withdrawal capped at remaining balance, floored at 0.
- no owner birth years + age trigger → never withdraws.

## API

- **`apps/api/src/routes/accounts.ts`** — POST and PATCH bodies accept the six new
  fields (Elysia `t` validators mirroring the existing optional pattern). Insert/update
  persist them. GET already returns `...a`, so reads include them automatically.
- **`apps/api/src/lib/valuation.ts`** — `netWorth()` returns the six fields on each
  account (the chart reads accounts from `/networth`). Add them to the
  `AccountValuation` type and the `out.push({...})` payload.

End-to-end types flow to the web app via Eden treaty automatically.

## Web

- **`apps/web/src/lib/collections.ts`** — `AccountRow` type gains the six fields; the
  `onInsert` and `onUpdate` payloads include them.
- **`apps/web/src/components/account-projection-card.tsx`** — becomes the consolidated
  card. Keep the existing growth + accessibility + liquidity read view and inline edit;
  add a **Withdrawal** block in edit mode:
  - Spend type select (`none`/`once`/`monthly`/`percent`), labels mirroring goal-form.
  - Amount input (base currency) shown for `once`/`monthly`; rate input (%/yr) for `percent`.
  - Start trigger: a kind select (`age` / `target`) + the matching input
    (age number, or target amount in base currency).
  - Read view summarises the withdrawal in one line (e.g. "4%/yr from age 60",
    "$40k/yr once balance hits $1.0M", or nothing when `none`).
  - Hidden entirely for liability-class accounts.
  - Saves via `accountsCollection.update`, then invalidates `["networth"]`.
- **`apps/web/src/routes/projections.tsx`** — add a per-account section that renders
  one `AccountProjectionCard` per (non-archived) account, below the existing chart /
  member birth years / assumptions. Single-column (cards are tall when editing).
- **`apps/web/src/routes/account-detail.tsx`** — remove `AccountProjectionCard` from the
  Details tab; it now shows only `AccountInfoCard` + danger zone. Remove the now-unused
  import.
- **`apps/web/src/components/projection-chart.tsx`** — map the six new account fields
  into the `ProjectionAccount` objects passed to `projectNetWorth`, so the curve
  reflects withdrawals.

## Out of scope (YAGNI)

- Household-level (aggregate) withdrawal plans.
- Per-account withdrawal amounts in the account's own currency / future-date FX.
- Lump withdrawals recurring more than once.
- Redesigning the chart, the "Project until age" box, or the "Assumptions" card.
- Showing withdrawal config on the account detail page (it moves entirely to /projections).

## Files touched

1. `apps/api/src/db/schema.ts` — +6 columns on `accounts`
2. `apps/api/drizzle/0008_*.sql` — generated migration
3. `apps/api/src/routes/accounts.ts` — POST/PATCH validators + persistence
4. `apps/api/src/lib/valuation.ts` — `AccountValuation` type + `netWorth` payload
5. `packages/shared/src/projection.ts` — `WithdrawalConfig`, extended `ProjectionAccount`, `projectAccountSeries`, updated `projectNetWorth`
6. `packages/shared/src/projection.test.ts` (exists) — add withdrawal unit tests
7. `apps/web/src/lib/collections.ts` — `AccountRow` + insert/update payloads
8. `apps/web/src/components/account-projection-card.tsx` — consolidated card + withdrawal UI
9. `apps/web/src/routes/projections.tsx` — per-account cards section
10. `apps/web/src/routes/account-detail.tsx` — remove projection card from Details tab
11. `apps/web/src/components/projection-chart.tsx` — pass new fields into `ProjectionAccount`

## Verification

- `cd apps/web && bun run build` (tsgo strict typecheck + vite) is clean.
- `bun test` passes, including new shared withdrawal tests.
- Manual: on `/projections`, set an account to `percent` 4%/yr from age 60 → the
  Total/Accessible curve bends down after that owner turns 60.
