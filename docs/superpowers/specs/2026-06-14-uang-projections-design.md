# Projections (FIRE engine) — Design

**Date:** 2026-06-14
**Status:** Approved (design); pending implementation plan
**Feature:** Project net worth forward to model financial independence — growth per account, liquidity-aware accessibility by age, and goals with required-contribution / on-track tracking.

---

## 1. Motivation & scope

Migrating from a Google Sheet that shows only latest balances. The user wants to model FIRE: how net worth grows over time, what is actually *withdrawable* at each age (accounts unlock at different ages with different penalties), and whether they are on track to fund their goals.

The headline output is a **projected net-worth curve**: total vs accessible net worth over calendar time, with unlock milestones (55 / 62 / 65) marked per household member.

### Built now — two implementation slices, one spec

- **Slice 1 — Projected net-worth curve.** Per-account growth assumptions + the accessibility model + the chart (total vs accessible lines, per-person milestones).
- **Slice 2 — Goals & tracking.** Multiple short/long-term goals, liquidity-aware allocation of net worth across goals, required monthly contribution, on-track / behind indicator.

The projection engine is designed to accept a contribution stream from day one (slice 1's curve shows pure growth), so slice 2 adds no rework to the engine.

### Deferred — noted, not built (see §8)

Decumulation / income drawdown & CPF LIFE payouts; CPF-accurate Full-Retirement-Sum modelling; income-tax brackets; inflation / real terms; named scenarios (conservative/base/optimistic); contribution *tracking* (actual vs required rate over time).

### Explicit non-decisions

- **No new `cpf` / `srs` subtypes.** CPF/SRS accounts use existing subtypes; their growth & accessibility values are set per account (the new per-account fields cover them). Decided 2026-06-14.
- **Tax ignored in slice 1.** Only the SRS 5% early-withdrawal penalty is modelled; income tax is a known simplification (§8).

---

## 2. Architecture

**Hybrid compute over shared pure functions.** The core projection / accessibility / allocation logic lives in `packages/shared` as pure, point-in-time functions (mirroring the existing `valuation.ts` / `holdings.ts` style). There is one source of truth for the math:

- **Client** calls these functions against TanStack DB collections to render the curve with instant feedback when assumptions are tweaked (no round-trips).
- **Server** calls the *same* functions for goals allocation + required-contribution solving (the heavier, less interactive work), exposed via endpoints.

Conventions preserved from the codebase:
- Integer **minor units** for money; **BigInt** for multiply/divide; no floats.
- Rates and haircuts stored as integer **basis points** (8% = `800`).
- Point-in-time / carry-forward semantics; reuse existing FX conversion + historical net-worth series.
- New UI components added via the **shadcn CLI**. No `as any` — model types correctly.

---

## 3. Data model

### 3.1 `accounts` — new columns (all editable per account, seeded by subtype)

| Column | Type | Meaning | Default by subtype |
|---|---|---|---|
| `growthRateBps` | int | Annual nominal growth (bps) | cash 0, bank 0, investment 800, property 300, other 0 |
| `accessibleFromAge` | int | Penalty-free withdrawal age (0 = liquid now) | 0 (set 55 for CPF, 62 for SRS manually) |
| `earlyWithdrawal` | text enum | `'none'` (locked before age) \| `'penalty'` (allowed with haircut) | `'none'` |
| `earlyHaircutBps` | int | Haircut if withdrawn before `accessibleFromAge` | 0 (set 500 for SRS) |
| `illiquid` | int (bool) | Excluded from accessible line & goal funding | 0 (set 1 for property, private shares) |
| `liquidationAge` | int \| null | Optional age at which an illiquid asset is assumed sold | null |

Defaults are seeding conveniences only; every value is user-editable. CPF (≈250–400 bps, age 55, `earlyWithdrawal='none'`), SRS (age 62, `earlyWithdrawal='penalty'`, `earlyHaircutBps=500`), and private/Carta shares (`illiquid=1`) are configured per account.

### 3.2 `member_profiles` — new table

`{ userId (PK, FK user.id), birthYear int }`. Sidecar so better-auth's `user` table is untouched. Drives per-person ages and milestones. New TanStack DB collection.

### 3.3 `goals` — new table

`{ id (uuid PK), name, term ('short'|'long'), targetAmountMinor int, currency, targetDate (YYYY-MM-DD), ownerScope ('household' | userId), sortOrder int, createdAt int, createdBy }`. New TanStack DB collection.

`term` drives grouping & sort, not the funding math (eligibility derives from `targetDate` vs unlock ages — see §5).

### 3.4 Global assumptions — existing `settings` table

- `contributionGrowthRateBps` (default `800`) — rate at which assumed future contributions grow.
- `projectionEndAge` (default `90`) — used to derive the chart's end year from the *younger* member.

---

## 4. Projection engine (slice 1, `packages/shared`)

Pure functions:

1. **`projectAccount(balanceNow, growthRateBps, fromYear, toYear, contributions?)`** → projected balance per year, compounded annually; optional per-year contributions added before compounding.
2. **`accessibleValue(account, projectedBalance, ownerAgeThatYear)`** → withdrawable value that year:
   - `illiquid` and `liquidationAge` not yet reached → `0`.
   - `ownerAge ≥ accessibleFromAge` → full balance (× (1 − lateHaircut); lateHaircut = 0 in slice 1).
   - `ownerAge < accessibleFromAge` → `earlyWithdrawal === 'penalty'` ? `balance × (1 − earlyHaircutBps)` : `0`.
3. **`projectNetWorth({ accounts, members, assumptions, fromYear, toYear })`** → per calendar year `{ year, totalBaseMinor, accessibleBaseMinor }`, reusing existing FX conversion. Shared accounts (2 owners) use the **younger** owner's age (age-gated accounts are individual in practice).
4. **Milestones** — for each member, the calendar years they reach 55 / 62 / 65, returned for chart markers.

The curve runs from the current year to the year the *younger* member reaches `projectionEndAge`. The existing **historical net-worth series** stitches on the left of "today" so the chart reads past → projected continuously.

---

## 5. Goals & liquidity-aware allocation (slice 2, `packages/shared`, called server-side)

### 5.1 Eligibility

An account can fund a goal if it is accessible **by that goal's `targetDate`**:
- owner's age at `targetDate` ≥ `accessibleFromAge` → eligible (penalty-free), or
- `earlyWithdrawal === 'penalty'` → eligible, valued after `earlyHaircutBps`.
- `illiquid` → excluded (unless `liquidationAge` ≤ age at `targetDate`).

This is why short-term goals naturally see only currently-liquid accounts (nothing else has unlocked), while long-term goals pick up CPF/SRS that unlock by then.

`ownerScope`: a **household** goal draws from all accounts; a **personal** goal draws only from that member's solely-owned accounts. Shared accounts fund household goals only.

### 5.2 Allocation (no double-counting) — `allocateGoals(goals, accounts, members)`

1. Sort goals by soonest `targetDate` first (tie-break: short before long, then `sortOrder`).
2. Maintain a per-account **remaining** pool. For each goal in order, fill from its eligible accounts (most-liquid first) until the target is met or its eligible pool is exhausted, decrementing the shared pool so a dollar is never reused.
3. Output per goal: `allocatedMinor`, `progressPct = allocated / target` (capped 100%). The leftover across all accounts is **unallocated (free) net worth**.

### 5.3 Required monthly contribution

Per goal: project its allocated accounts to `targetDate` at their growth rates → `projectedAllocated`. `gap = targetAmount − projectedAllocated`. If `gap ≤ 0` → on track, required = 0. Otherwise solve the monthly contribution (growing at `contributionGrowthRateBps`) whose annuity future value fills `gap` by `targetDate`.

### 5.4 On-track / behind

Per goal, anchored at the goal's `createdAt`: build the compound on-plan path from net worth at creation (read from the historical series) to the target, using the required contribution. Compare **today's actual allocated** vs the **on-plan value for today**; report ahead/behind by $ and %. Roll up to an overall household status.

> This is the most error-prone piece (anchoring, reading historical net worth at a past date, annuity math). It gets dedicated tests.

---

## 6. UI

- **New `/projections` route.** Chart reuses `NetWorthChart` styling (Recharts): historical (solid, left of "today") → projected **total** + projected **accessible** lines to the horizon; vertical milestone markers per person. Live controls for `contributionGrowthRateBps` and `projectionEndAge`.
- **Account form / detail** gains the new fields (growth rate, accessible-from age, early-withdrawal + haircut, illiquid / liquidation age) with subtype-seeded defaults.
- **Member birth years** entered in a small settings/profile screen.
- **Goals view (slice 2)** — list grouped by short/long term; each card shows target, date, a progress bar (allocated/target), required monthly contribution, and an on-track/behind badge; plus an "unallocated net worth" summary. Goal targets may also render as markers on the curve.
- All new components via the **shadcn CLI**.

---

## 7. Testing

- **Engine (`packages/shared`)** — unit tests for `projectAccount` (compounding, contributions), `accessibleValue` (each branch: liquid, locked, penalty, illiquid, liquidationAge), `projectNetWorth` (FX, younger-owner age on shared accounts), milestone year computation.
- **Allocation** — soonest-first ordering, no double-counting (shared pool decremented), short-term sees cash only, long-term picks up unlocked CPF/SRS, `ownerScope` filtering, unallocated remainder.
- **Required contribution** — gap ≤ 0 → 0; annuity FV solve hits target by date.
- **On-track** — anchored path; ahead/behind sign and magnitude against a known fixture.
- **API endpoints** — goals CRUD + allocation/required-contribution responses.

---

## 8. Future (deferred)

- Decumulation / income drawdown; CPF LIFE monthly payouts from 65.
- CPF-accurate Full-Retirement-Sum modelling (OA+SA→RA at 55, MA medical-only).
- Income-tax modelling (SG progressive brackets; SRS 50%-taxable after 62).
- Inflation / real-terms toggle.
- Named scenarios (conservative / base / optimistic) compared on one chart.
- Contribution *tracking* (actual saving rate vs required) — and the "remaining CPF+SRS top-up limit" budget tracker from the sheet.
