# Liability loan projections — design

**Date:** 2026-06-15
**Status:** Approved (ready for implementation plan)

## Problem

Liabilities currently reuse the asset projection form and model. A liability is
just an account with `class: "liability"` and a **negative balance** that
compounds *more negative* each year at `growthRateBps`. The asset-only fields
(accessibility/locks, early-withdrawal penalties, withdrawal/spend rules,
contributions, compound interval) are shown but semantically meaningless for
debt, and `spendType` is force-disabled in the UI. There is no real loan
concept — no interest/term/amortization, no paydown to zero, and
`contributionMinor` is ambiguous (payment vs. accrual).

## Goal

Model every liability as a single **loan/debt** type with the inputs people
actually think about: outstanding balance, interest rate, and tenure. The loan
amortizes down to zero over its remaining term.

## Decisions (from brainstorming)

- **Anchor:** current outstanding balance + annual interest rate + remaining
  term. Monthly payment is **derived** and the balance amortizes to zero.
- **Form fields:** the three core inputs plus a **read-only derived monthly
  payment**. No overpayments, no payment-frequency picker, no original-amount
  field (all YAGNI for this slice).
- **Single type with free-text label:** drop the liability subtype picker. All
  liabilities use the identical loan model; the account **name** is the label
  (e.g. "Mortgage", "Car loan").
- **Migration:** none needed — no real liability data exists yet; treat as a
  clean reset.
- **Term input:** entered in the UI as **X years + Y months**, stored as total
  months.

## Data model

For `class: "liability"` accounts:

- **`growthRateBps`** — *repurposed* as the annual interest rate (bps). Already
  exists, already an annual-% in bps, already carried through valuation and
  shared types — no new plumbing.
- **`loanTermMonths`** — **new** nullable integer column on `accounts`: remaining
  term in months. Null/0 ⇒ term not set.
- **Outstanding balance** — uses the account's existing balance, stored
  **negative** internally as today (so net-worth math is unchanged). The form
  presents and accepts it as a positive "amount owed".
- **Monthly payment** — derived, never stored (single source of truth).
- All asset-only projection fields (accessibility, early-withdrawal, spend/
  withdrawal, contribution, compound interval) are **ignored** by the loan path
  and removed from the liability form. Their columns remain (used by assets) but
  stay at defaults for liabilities.

The new `loanTermMonths` field is threaded through the shared `ProjectionAccount`
type, the `AccountValuation` display type, the accounts PATCH route, and the web
collection schema, mirroring how existing projection fields flow.

## Amortization math

New function in `packages/shared/src/projection.ts`, computed **monthly** and
sampled into the **yearly** series the projection engine already produces.

Given outstanding balance `B` (use absolute value of the negative stored
balance), annual rate in bps, and `n = loanTermMonths`:

- monthly rate `r = (annualRateBps / 10_000) / 12`
- payment:
  - if `r > 0`: `P = B · r / (1 − (1 + r)^(−n))`
  - if `r = 0`: `P = B / n` (straight-line)
- each month: `interest = B · r`; `principal = P − interest`; `B −= principal`
- after month `n`, `B = 0` and stays 0.

All arithmetic uses the existing BigInt minor-unit helpers (`toBig`, `roundDiv`,
`fromBig`) for consistent rounding; the final scheduled payment absorbs any
rounding remainder so the balance lands exactly on 0.

Integration:

- Liabilities branch into the new amortization path inside
  `projectAccountSeries` (or a sibling it delegates to); assets keep the current
  accumulate-then-withdraw logic untouched.
- The series is still a yearly array `[year0, year1, …]` of the (negative)
  outstanding balance, so `projectNetWorth` and the chart consume it unchanged.
- `accessibleValueMinor` for a liability passes the (negative) balance through as
  it does today — debt always counts against net worth.

## Net-worth interaction

Each loan amortizes **independently**. As the debt shrinks toward zero, net
worth rises; the payment money is assumed to come from unmodeled income —
consistent with how asset contributions already appear "from nowhere" in the
current model. Linking payments to a funding account is explicitly **out of
scope** for this slice.

## UI

`apps/web/src/components/account-projection-form.tsx`: when
`account.class === "liability"`, render a dedicated **Loan** form instead of the
asset form:

- **Outstanding balance** — currency input (positive; saved as negative).
- **Annual interest rate %** — number, maps to `growthRateBps`.
- **Remaining term** — two inputs, **Years** and **Months**, combined into
  `loanTermMonths` on save (e.g. 4y 0m ⇒ 48).
- **Monthly payment** — read-only derived value, recomputed live from the three
  inputs; shows "—" when the term is unset.

Liability creation drops the subtype picker; the account name is the free-text
label. The asset form and asset create flow are unchanged.

## Edge cases

- **Term unset / 0** ⇒ no paydown; balance held flat across the horizon; derived
  payment shown as "—".
- **Rate 0** ⇒ straight-line paydown.
- **Term shorter than projection horizon** ⇒ balance is 0 (flat) for all years
  after payoff.
- **Rounding** ⇒ final payment absorbs the remainder so the schedule ends exactly
  at 0.

## Testing

- **Shared unit tests** (`projection.test.ts`): amortization correctness —
  standard payment formula against a known schedule; rate-0 straight line;
  payoff lands exactly at 0; term unset holds flat; term shorter than horizon
  goes flat-0 after payoff; net-worth rollup reflects the rising (less negative)
  balance.
- **Route test**: PATCH accepts and persists `loanTermMonths`.
- **E2E** (end of slice, affected specs only): create a liability, enter
  balance/rate/term, see the derived monthly payment and a downward-to-zero
  projection.

## Out of scope

- Linking loan payments to a funding asset / cash-flow modeling.
- Overpayments, variable rates, payment-frequency options, original-loan-amount
  reference field.
- Migrating/transforming existing liability accounts.
