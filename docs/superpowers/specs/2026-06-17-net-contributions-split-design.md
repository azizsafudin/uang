# Design: meaningful contribution / appreciation split

**Date:** 2026-06-17
**Status:** Approved (pending implementation plan)

## Problem

The net-worth chart decomposes net worth into a gold "Net deposits" line and
"Appreciation" (computed client-side as `net − deposits`). The deposits line is
produced by `externalFlowsBase()` in `apps/api/src/lib/networth-series.ts`, which
counts **only** standalone `currency`-kind transactions
(`instruments.kind === "currency"` AND `linked_transaction_id IS NULL`).

Consequences observed in live data (SGD base):

- Security holdings entered as **direct holdings** (a fund/stock buy with no cash
  leg) contribute nothing to the deposits line. The 2021–2025 Amundi positions
  (~112k SGD of principal) therefore appear entirely as "appreciation."
- All cash was entered as 10 standalone SGD deposits dated `2026-06-15`
  (~251k SGD), so the deposits line sits at $0 for the whole window and then
  jumps vertically — and that jump was previously indistinguishable from
  appreciation.

The decomposition is conceptually wrong: principal is mislabeled as market gain.

## Goal

Make "contributions" mean *all external capital that entered the tracked
accounts* — cash deposits **and** invested principal — so that
`Appreciation = NetWorth − Contributions` reflects only market + FX gains.

This is the **model** fix. The underlying data shape is unchanged, so the
2026-06-15 cash step remains (it is genuinely all dated one day), but it will be
correctly attributed to *contributions* (gold steps up with the green net-worth
line; appreciation stays flat across the step) instead of phantom appreciation.

## Decisions

- **Label:** the gold line / tooltip / legend becomes **"Net contributions"**.
- **Sells:** reduce contributions by **full proceeds at sale price** (the
  standard money-weighted external-cash-flow definition). Realized gains stay
  embedded in appreciation; `NetWorth = Contributions + Appreciation` stays exact.
- **API response field name** `netDepositsBaseMinor` is **kept** to avoid
  churning the response contract; only the UI label changes.

## Core change — `apps/api/src/lib/networth-series.ts`

Rework `externalFlowsBase(owner?)` → **`contributionFlowsBase(owner?)`**.

A transaction counts as an external contribution iff it is **not part of an
internal transfer pair**:

1. Resolve included accounts (owner-filtered, non-archived) — unchanged.
2. Load all transactions for included accounts joined to instruments (no longer
   pre-filtered to `kind = "currency"`).
3. Build `linkedToIds` = the set of every non-null `linked_transaction_id`
   (these identify security rows that *have* a cash leg).
4. Include a transaction iff:
   - its own `linked_transaction_id` is null (it is not itself a cash leg), **AND**
   - its `id` is **not** in `linkedToIds` (no cash leg points at it).
5. Value each included transaction in base currency at `tx.date` FX:
   - **currency** instrument: `amountMinor = roundDiv(unitsDelta × 10^dec, SCALE)`
     *(existing math)*.
   - **non-currency**: notional = `unitsDelta × unitPriceScaled`;
     `amountMinor = roundDiv(unitsDelta × unitPriceScaled × 10^dec, SCALE × SCALE)`.
     Sign follows `unitsDelta` (buy +, sell −), so proceeds-at-sale-price falls
     out naturally.
   - If a non-currency row has `unitPriceScaled == null`, it cannot be valued →
     contribution 0 (skip the row).
   - `convertMinor(..., tx.date)`; on missing FX → skip (same as today).
   - **Fees are excluded** (consistent with the direct-holding net-worth model,
     which ignores fees; on cash-leg buys the fee already rides the cash leg as
     negative appreciation).
6. The cumulative-sum loop and the `netDepositsBaseMinor` output field are
   unchanged.

### Why this avoids double-counting

| Scenario | Rows | Counted |
|---|---|---|
| Cash deposit | currency, no link | the cash amount ✓ |
| Buy **with** cash leg | security (no link, but a cash leg points at it) + cash leg (linked) | neither security nor cash leg; the funding deposit was already counted ✓ |
| Direct-holding buy | security (no link, nothing points at it) | cost basis `unitsDelta × unitPriceScaled` ✓ |
| Sell (standalone) | security, no link | negative proceeds ✓ |

## Frontend — `apps/web/src/components/net-worth-chart.tsx`

- Tooltip label "Net deposits" → **"Net contributions"**; series/legend name
  likewise.
- `deposits` dataKey and `appreciation = net − deposits` math unchanged.

## Testing

- Unit tests in `apps/api/src/lib/networth-series.test.ts`:
  - standalone security buy → contributions = cost basis;
  - buy-with-cash-leg → contributions counted once (not doubled);
  - standalone sell → contributions drop by proceeds;
  - mixed currency + security;
  - keep the existing linked-cash-leg test green.
- Typecheck via `cd apps/web && bun run build` (tsgo strict typecheck).
- Affected E2E only if a spec covers the net-worth chart (check the spec↔feature
  map in `e2e/README.md` at slice end).

## Out of scope

- The 2026-06-15 cash cliff (a data-entry artifact; would need backdating — the
  data fix, deliberately deferred).
- Projections' `contribution_growth_rate` setting (an unrelated
  future-contribution concept).
