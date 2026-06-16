# Unified Plan: goals + projections redesign

**Date:** 2026-06-17
**Status:** Design approved, pending spec review

## Problem

Goals and Projections are two pages built on one underlying engine (compound growth,
age-gating, contributions, decumulation) but exposed through two parallel surfaces with
near-identical, unreconciled vocabulary. Concretely:

- **Two "contribution" fields** — `goal.monthlyContributionMinor` and `account.contributionMinor`
  are independent and invite double-counting (saving £500/mo into an ISA *and* £500/mo toward a
  goal funded by that ISA looks like £1,000).
- **Two "spend" models** — both goals and accounts carry an identical `spendType` dropdown
  ("none/once/monthly/percent"); "Spend" on goals vs "Withdrawal" on accounts, with different
  start triggers and no link between them.
- **Opaque funding** — goals silently pull from balances by liquidity; the user never says which
  accounts fund a goal, and accessibility haircuts/locks are applied invisibly.
- **Inconsistent "on track"** — means "reach by deadline" for dated goals but "reachable within
  ~100 years" for undated ones, yet both show a pass/fail badge.

## Decisions (from brainstorming)

1. **Unified surface** — merge `/goals` and `/projections` into one `/plan` page: the net-worth
   curve with goals marked on it, then the goals, then the accounts that fund them.
2. **Explicit funding with sane defaults** — a goal is funded by accounts the user assigns to it.
3. **An account can fund multiple goals** (e.g. one Checking account feeds both "Car" and "Reno").
   Funding is resolved by **priority-fill**, not hidden liquidity heuristics.
4. **Decumulation lives only on goals** — a goal accumulates to a target, then optionally enters a
   payout phase drawing from its assigned accounts. Accounts no longer "spend" on their own.

## Model

### Account = a vessel

Keeps: balance (from transactions), `growthRateBps`, `compoundInterval`, accessibility
(`accessibleFromAge`, `earlyWithdrawal`, `earlyHaircutBps`, `illiquid`, `liquidationAge`), and for
liabilities the interest rate + `loanTermMonths`.

**Removed:** `contributionMinor`, `contributionUntilAge`, `spendType`, `spendAmountMinor`,
`spendRateBps`, `spendStartKind`, `spendStartAge`, `spendStartTargetMinor` — contributions and
decumulation now belong to goals.

### Goal = a plan over accounts

- `name`, `targetAmountMinor`, `currency`, `targetDate` (optional), `ownerScope`
- `priority` (reuse `sortOrder`; reorderable list, default = soonest `targetDate` first, then
  smallest target)
- **Accumulation:** `monthlyContributionMinor` + `contributionAccountId` (which assigned account
  the saving lands in, so it grows at that account's rate)
- **Payout phase:** keep `spendType` / `spendAmountMinor` / `spendRateBps`; begins at `targetDate`

### New join — `goal_accounts`

`(goalId, accountId)` — the many-to-many assignment. Checking → {Car, Reno}; Retirement →
{Pension, ISA}. Scope guard preserved: a personal goal may only link to that owner's accounts.

## Funding engine (priority-fill)

Replaces today's liquidity-based `allocateGoals` with an explicit, account-driven fill:

1. Order goals by `priority`.
2. For each account, walk its linked goals in priority order, giving each up to its remaining
   need. Example: Checking £25k linked to Car (£20k) then Reno (£15k) → Car takes £20k, Reno gets
   £5k and shows "£10k short".
3. **Accessibility per goal:** if a linked account is locked past the goal's `targetDate`, it
   contributes £0 (or the post-penalty amount when `earlyWithdrawal = penalty`), and the goal card
   states it explicitly (e.g. "Pension locked until 57 — not counted").
4. **Projection over time:** each goal's balance grows at its accounts' rates plus
   `monthlyContributionMinor` routed into `contributionAccountId`, governed by:
   - `targetAmountMinor` **stops contributions** — once reached, the monthly contribution
     **cascades to the next-priority goal** (existing surplus-redirect behaviour). The pot is
     capped at target; excess is freed to the next goal.
   - `targetDate` **starts the payout phase** — decumulation begins at the date regardless of
     amount.

   | Case | Contributions | Payout |
   |---|---|---|
   | Amount reached before date | stop early, cascade to next goal | starts at date |
   | Date arrives, amount not reached | stop (window closed) → goal is **Behind** | starts at date |
   | Undated goal | run until amount reached, then cascade | none (payout requires a date) |

5. **On-track logic:** only goals **with a `targetDate`** get an On track / Behind badge
   (glide-path check). Undated goals show neutral "Reaches <date> at this rate" — no pass/fail.

The net-worth curve = sum of all accounts with these flows applied; goal markers sit at each
`targetDate`, colour-coded (green on-track / amber-or-red behind).

Reuse: `simulateGoals` / `projectNetWorth` in `packages/shared` largely survive; what changes is
the allocation *input* (explicit links instead of liquidity guesswork) and decumulation moving
onto goals.

## UI — `/plan` (Layout A: one scroll)

1. **Net-worth chart** on top: Total / Accessible toggle, "project until age" control, goal
   markers on the curve.
2. **Goals** — priority-ordered cards (drag to reorder = change funding priority). Each card:
   donut (% funded), name, target + date, funding-account **pills**, on-track badge (dated only)
   or neutral reach line, progress bar, allocated/short figures, payout summary if any.
3. **Accounts** — the vessels, grouped assets/liabilities; each shows which goals it feeds; click
   opens the vessel settings dialog (growth, compounding, accessibility; loans: rate + term).

`goal-detail.tsx` stays for drill-in. `account-projection-form.tsx` loses its withdrawal +
contribution sections (vessel settings only). The goal form gains an **account-assignment**
control (multi-select of eligible accounts + choice of `contributionAccountId`).

**Routing:** new `/plan` route renders Layout A; `/goals` and `/projections` redirect to `/plan`.

## Migration

No goals exist yet, so there is **no data backfill**. The schema change is a clean column
drop/add: add `goal_accounts` + `goals.contributionAccountId`, drop the eight account
contribution/decumulation columns. Existing accounts' values in dropped columns are discarded
(not meaningful).

## Testing

Per project workflow (unit/route while iterating; affected E2E at end of slice):

- **Unit (`packages/shared`):** priority-fill across shared accounts; accessibility exclusion /
  penalty; contribution cascade when target amount reached; payout starting at target date;
  on-track only when dated; undated-goal neutral status.
- **Route (`apps/api`):** goals CRUD + account assignment; `/goals/analysis` response shape with
  funding sources, locked/excluded notes, and per-goal status.
- **Typecheck:** `cd apps/web && bun run build` (tsgo).
- **E2E at end of slice:** affected specs (`goals.spec.ts`, net-worth / projection specs).

## Out of scope

- Splitting a single account across goals by explicit amount or percentage (priority-fill covers
  the shared-account case).
- Preserving account-level contributions/withdrawals as standalone (no goal) constructs.
- Any change to how balances are derived from transactions.
