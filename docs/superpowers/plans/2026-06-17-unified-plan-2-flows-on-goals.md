# Unified Plan — Plan 2: Flows on goals (decumulation + contributions move off accounts)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove per-account contributions and decumulation; the net-worth projection now derives those flows from goals (contributions land in a goal's `contributionAccountId`; a goal's payout draws from one assigned account after its target year). Accounts become pure vessels (growth + accessibility + loan).

**Architecture:** Extend the existing **yearly** per-account engine (chosen over a unified monthly sim for lower risk). `ProjectionAccount` swaps its single contribution/spend fields for **lists** of `ContributionStream` + `PayoutStream`. A new pure `deriveAccountFlows` turns goal rows into those per-account lists. The projection still runs **client-side** in `projection-chart.tsx`, which now also fetches goal analysis and feeds the derived flows in. The 8 account contribution/decumulation columns are dropped; their create/edit/display UI is removed (the goal form already owns contribution + spend).

**Tech Stack:** Bun, Elysia, Drizzle (libsql/SQLite), `@uang/shared`, React + TanStack, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-06-17-unified-plan-goals-projections-design.md` · **Predecessor:** Plan 1 (merged).

---

## Key approximations (documented, accepted)

- The yearly engine models a goal's **contribution cutoff** at its **target year** (dated goals) or its **reach year** (undated goals, from analysis `reachDate`); not the exact month the amount is hit.
- A goal's **payout** is attributed to a **single** account (`contributionAccountId`, else the first assigned account) drawn from after the goal's **target year**. The aggregate total curve is correct (money leaves that account); per-account *accessible* breakdown is approximate if that one account can't cover the whole payout. Acceptable for the curve; revisit only if needed.
- After this plan there is **no UI to set contributions/payouts on accounts** (removed) — the goal form already has the monthly-contribution + spend fields; the account-assignment + `contributionAccountId` picker arrive in Plan 3. Until then, goals have no assigned accounts, so `deriveAccountFlows` yields nothing and the curve shows accounts growing only (no real goals exist yet).

---

## File structure

- `packages/shared/src/projection.ts` — replace single contribution/spend fields on `ProjectionAccount` with `contributions`/`payouts` lists; rewrite `projectAccountSeries`; add `ContributionStream`/`PayoutStream`; remove `WithdrawalConfig`/`AccumulationConfig`.
- `packages/shared/src/projection.test.ts` — migrate withdrawal/contribution tests to the lists API.
- `packages/shared/src/account-flows.ts` (new) — `deriveAccountFlows` + `GoalFlowInput`.
- `packages/shared/src/account-flows.test.ts` (new).
- `packages/shared/src/index.ts` — export the new module (confirm barrel pattern).
- `apps/api/src/db/schema.ts` + `apps/api/drizzle/*` — drop 8 account columns; migration.
- `apps/api/src/lib/valuation.ts` — drop removed fields from the `netWorth` account shape.
- `apps/api/src/routes/accounts.ts` — drop removed fields from POST/PATCH body + insert.
- `apps/web/src/lib/collections.ts` — drop removed fields from the **accounts** collection (NOT goals).
- `apps/web/src/components/account-form.tsx` — drop removed fields from the insert payload.
- `apps/web/src/lib/assumptions.ts` — confirm no removed fields seeded (it only sets growth/accessibility — likely no change).
- `apps/web/src/components/account-projection-form.tsx` — remove the Accumulation + Withdrawal sections (keep growth/accessibility/loan).
- `apps/web/src/components/account-projection-card.tsx` — remove contribution/withdrawal display rows.
- `apps/web/src/components/projection-accounts.tsx` — remove any contribution/withdrawal summary text.
- `apps/web/src/components/projection-chart.tsx` — drop removed fields from `NwAccount`/mapping; fetch goal analysis; build flows via `deriveAccountFlows`; pass into `projectNetWorth`.

---

## Task 1: Shared engine — contribution/payout stream lists (TDD)

**Files:** `packages/shared/src/projection.ts`, `packages/shared/src/projection.test.ts`

- [ ] **Step 1: Replace the config types**

In `packages/shared/src/projection.ts`, **delete** `WithdrawalConfig` (the `spendType`/`spendAmountMinor`/`spendRateBps`/`spendStartKind`/`spendStartAge`/`spendStartTargetMinor` type) and `AccumulationConfig` (the `contributionMinor`/`contributionUntilAge`/`compoundInterval` type) and the `SpendStartKind` type. Keep `AccessibilityConfig`, `CompoundInterval`, `periodsPerYear`, `accessibleValueMinor`, `loanMonthlyPaymentMinor`, `compoundMinor`, `projectSeries`, `milestoneYears`, `amortizeLoanSeries`.

Add these new types (near where `AccumulationConfig` was):

```ts
// A monthly saving stream into an account, running until `untilYear` inclusive
// (null = the whole projection). Multiple goals may contribute to one account.
export type ContributionStream = {
  monthlyMinor: number;
  untilYear: number | null;
};

// A drawdown stream out of an account, beginning in `startYear`. Multiple goals
// may draw from one account.
export type PayoutStream = {
  spendType: "once" | "monthly" | "percent";
  spendAmountMinor: number | null; // 'once' lump / 'monthly' per-month
  spendRateBps: number | null;     // 'percent' annual % of balance
  startYear: number;
};
```

Replace the `ProjectionAccount` type with:

```ts
export type ProjectionAccount = AccessibilityConfig & {
  baseMinor: number;       // current base-currency balance (signed; negative for debt)
  growthRateBps: number;   // assets: growth rate; liabilities: annual loan interest rate
  ownerBirthYears: number[]; // owners' birth years; empty = unknown
  isLiability: boolean;    // true => amortize as a loan instead of accumulate/withdraw
  loanTermMonths: number | null;
  compoundInterval: CompoundInterval;
  contributions: ContributionStream[];
  payouts: PayoutStream[];
};
```

- [ ] **Step 2: Rewrite the failing tests first**

Open `packages/shared/src/projection.test.ts`. It has a shared base config object (around line 99-105 using `spendType`/`contributionMinor`/etc) and ~8 withdrawal/contribution tests (lines ~171-230) plus `projectNetWorth` tests (lines ~116-160). Migrate them to the lists API:

Replace the base config (the object spread into test accounts, currently with `spendType`/`spendStart*`/`contributionMinor`/`contributionUntilAge`/`compoundInterval`) with:

```ts
const baseAcct = {
  accessibleFromAge: 0, earlyWithdrawal: "none" as const, earlyHaircutBps: 0,
  illiquid: false, liquidationAge: null,
  compoundInterval: "annually" as const,
  contributions: [] as ContributionStream[],
  payouts: [] as PayoutStream[],
  isLiability: false, loanTermMonths: null,
};
```

Update the import line (currently importing `WithdrawalConfig`/`AccumulationConfig`) to:

```ts
import { loanMonthlyPaymentMinor, projectNetWorth, projectAccountSeries, projectSeries, milestoneYears, type ProjectionAccount, type ContributionStream, type PayoutStream } from "./projection";
```

Rewrite the withdrawal tests to use `payouts: [...]` and the contribution behaviour to use `contributions: [...]`. Convert each existing test to the new shape — here are the canonical replacements; apply the same transform to the analogous ones:

```ts
test("payout none: identical to compound-only baseline", () => {
  const a: ProjectionAccount = { ...baseAcct, baseMinor: 100_000, growthRateBps: 800, ownerBirthYears: [1990] };
  expect(projectAccountSeries(a, 2, 2030, 1990)).toEqual(projectSeries(100_000, 800, 2));
});

test("payout once: lump removed once in startYear, nothing after", () => {
  const a: ProjectionAccount = {
    ...baseAcct, baseMinor: 200_000, growthRateBps: 0, ownerBirthYears: [1990],
    payouts: [{ spendType: "once", spendAmountMinor: 30_000, spendRateBps: null, startYear: 2050 }],
  };
  const pts = projectNetWorth({ accounts: [a], fromYear: 2049, toYear: 2051 });
  // 2049 untouched (200_000); 2050 -30_000 (170_000); 2051 unchanged (170_000)
  expect(pts.map((p) => p.totalBaseMinor)).toEqual([200_000, 170_000, 170_000]);
});

test("payout monthly: 12x amount per year from startYear", () => {
  const a: ProjectionAccount = {
    ...baseAcct, baseMinor: 200_000, growthRateBps: 0, ownerBirthYears: [1990],
    payouts: [{ spendType: "monthly", spendAmountMinor: 5_000, spendRateBps: null, startYear: 2050 }],
  };
  const pts = projectNetWorth({ accounts: [a], fromYear: 2049, toYear: 2051 });
  expect(pts.map((p) => p.totalBaseMinor)).toEqual([200_000, 140_000, 80_000]);
});

test("payout percent: rate% of balance per year from startYear", () => {
  const a: ProjectionAccount = {
    ...baseAcct, baseMinor: 100_000, growthRateBps: 0, ownerBirthYears: [1990],
    payouts: [{ spendType: "percent", spendAmountMinor: null, spendRateBps: 400, startYear: 2050 }],
  };
  const pts = projectNetWorth({ accounts: [a], fromYear: 2049, toYear: 2051 });
  // 2049 100_000; 2050 -4% = 96_000; 2051 -4% of 96_000 = 92_160
  expect(pts.map((p) => p.totalBaseMinor)).toEqual([100_000, 96_000, 92_160]);
});

test("payout capped at available balance (floored at 0)", () => {
  const a: ProjectionAccount = {
    ...baseAcct, baseMinor: 8_000, growthRateBps: 0, ownerBirthYears: [1990],
    payouts: [{ spendType: "monthly", spendAmountMinor: 10_000, spendRateBps: null, startYear: 2050 }],
  };
  const pts = projectNetWorth({ accounts: [a], fromYear: 2049, toYear: 2051 });
  expect(pts.map((p) => p.totalBaseMinor)).toEqual([8_000, 0, 0]);
});

test("contribution stream: added monthly during accumulation, stops after untilYear", () => {
  const a: ProjectionAccount = {
    ...baseAcct, baseMinor: 0, growthRateBps: 0, ownerBirthYears: [1990],
    contributions: [{ monthlyMinor: 1_000, untilYear: 2032 }],
  };
  // 12k/yr, no growth: 2030 base 0; 2031 +12k; 2032 +12k = 24k; 2033 stops = 24k
  const series = projectAccountSeries(a, 3, 2030, 1990);
  expect(series).toEqual([0, 12_000, 24_000, 24_000]);
});
```

**Delete** the now-obsolete tests that exercised the removed `spendStartKind:"target"` trigger and the age-trigger-without-birth-year (`startYear` is an absolute year now, so there is no age/target trigger and no birth-year dependence for payout start). Keep the accessibility tests (lines ~56-95) unchanged. Update the two `projectNetWorth` accessibility tests (lines ~116-160) to spread `baseAcct` for the new required fields.

- [ ] **Step 3: Run tests — expect FAIL (engine not updated)**

Run: `cd packages/shared && bun test src/projection.test.ts` → compile/asserts fail until Step 4.

- [ ] **Step 4: Rewrite `projectAccountSeries`**

Replace the asset branch of `projectAccountSeries` (everything after the `if (account.isLiability) return amortizeLoanSeries(...)` line) with a version that sums active contribution streams and applies payout streams:

```ts
export function projectAccountSeries(
  account: ProjectionAccount,
  span: number,
  fromYear: number,
  youngestBirthYear: number | null,
): number[] {
  assertYears(span);
  if (account.isLiability) return amortizeLoanSeries(account, span);
  const n = periodsPerYear(account.compoundInterval);
  const periods = BigInt(n);
  const denom = BPS * periods;
  const numer = denom + toBig(account.growthRateBps);
  const monthsPerPeriod = BigInt(12 / n);
  let b = toBig(account.baseMinor);
  const out: number[] = [fromBig(b)];
  // Track which 'once' payouts have already fired (one per stream).
  const onceFired = account.payouts.map(() => false);
  for (let offset = 1; offset <= span; offset++) {
    const year = fromYear + offset;

    // Accumulate: sum active contribution streams (monthly), accrued per period.
    let monthlyTotal = 0n;
    for (const c of account.contributions) {
      if (c.untilYear === null || year <= c.untilYear) monthlyTotal += toBig(c.monthlyMinor);
    }
    const contribPerPeriod = monthlyTotal * monthsPerPeriod;
    for (let p = 0; p < n; p++) {
      b = roundDiv((b + contribPerPeriod) * numer, denom);
    }

    // Decumulate: apply each payout stream whose startYear has arrived.
    for (let i = 0; i < account.payouts.length; i++) {
      const pay = account.payouts[i];
      if (year < pay.startYear || b <= 0n) continue;
      if (pay.spendType === "once") {
        if (!onceFired[i]) {
          const amt = toBig(pay.spendAmountMinor ?? 0);
          b = amt > b ? 0n : b - amt;
          onceFired[i] = true;
        }
      } else if (pay.spendType === "monthly") {
        const amt = toBig(pay.spendAmountMinor ?? 0) * 12n;
        b = amt > b ? 0n : b - amt;
      } else if (pay.spendType === "percent") {
        const wd = roundDiv(b * toBig(pay.spendRateBps ?? 0), BPS);
        b = wd > b ? 0n : b - wd;
      }
    }
    out.push(fromBig(b));
  }
  return out;
}
```

`projectNetWorth` needs no change (it calls `projectAccountSeries` + `accessibleValueMinor`, both intact).

- [ ] **Step 5: Run tests — expect PASS**

Run: `cd packages/shared && bun test src/projection.test.ts` → all green.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/projection.ts packages/shared/src/projection.test.ts
git commit -m "feat(shared): projection accounts take contribution/payout stream lists"
```

---

## Task 2: Shared — `deriveAccountFlows` (TDD)

**Files (new):** `packages/shared/src/account-flows.ts`, `packages/shared/src/account-flows.test.ts`; **modify:** `packages/shared/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/account-flows.test.ts`:

```ts
import { expect, test } from "bun:test";
import { deriveAccountFlows, type GoalFlowInput } from "./account-flows";

test("routes a goal's monthly contribution to its contributionAccountId until its cutoff year", () => {
  const goals: GoalFlowInput[] = [
    { monthlyContributionMinor: 1_000, contributionAccountId: "isa", contributionUntilYear: 2030,
      spendType: "none", spendAmountMinor: null, spendRateBps: null, payoutStartYear: null, payoutAccountId: null },
  ];
  const flows = deriveAccountFlows(goals);
  expect(flows.get("isa")?.contributions).toEqual([{ monthlyMinor: 1_000, untilYear: 2030 }]);
  expect(flows.get("isa")?.payouts).toEqual([]);
});

test("routes a goal's payout to its payoutAccountId from payoutStartYear", () => {
  const goals: GoalFlowInput[] = [
    { monthlyContributionMinor: 0, contributionAccountId: null, contributionUntilYear: null,
      spendType: "monthly", spendAmountMinor: 4_000, spendRateBps: null, payoutStartYear: 2045, payoutAccountId: "pension" },
  ];
  const flows = deriveAccountFlows(goals);
  expect(flows.get("pension")?.payouts).toEqual([
    { spendType: "monthly", spendAmountMinor: 4_000, spendRateBps: null, startYear: 2045 },
  ]);
});

test("multiple goals stack streams on a shared account", () => {
  const goals: GoalFlowInput[] = [
    { monthlyContributionMinor: 500, contributionAccountId: "chk", contributionUntilYear: 2028,
      spendType: "none", spendAmountMinor: null, spendRateBps: null, payoutStartYear: null, payoutAccountId: null },
    { monthlyContributionMinor: 300, contributionAccountId: "chk", contributionUntilYear: 2030,
      spendType: "none", spendAmountMinor: null, spendRateBps: null, payoutStartYear: null, payoutAccountId: null },
  ];
  const flows = deriveAccountFlows(goals);
  expect(flows.get("chk")?.contributions).toEqual([
    { monthlyMinor: 500, untilYear: 2028 },
    { monthlyMinor: 300, untilYear: 2030 },
  ]);
});

test("ignores zero contributions, none-spend, and unrouted flows", () => {
  const goals: GoalFlowInput[] = [
    { monthlyContributionMinor: 0, contributionAccountId: "isa", contributionUntilYear: 2030,
      spendType: "none", spendAmountMinor: null, spendRateBps: null, payoutStartYear: null, payoutAccountId: null },
    { monthlyContributionMinor: 1_000, contributionAccountId: null, contributionUntilYear: 2030,
      spendType: "monthly", spendAmountMinor: 9, spendRateBps: null, payoutStartYear: 2040, payoutAccountId: null },
  ];
  const flows = deriveAccountFlows(goals);
  expect(flows.size).toBe(0);
});
```

- [ ] **Step 2: Run — expect FAIL** (`cd packages/shared && bun test src/account-flows.test.ts`).

- [ ] **Step 3: Implement**

Create `packages/shared/src/account-flows.ts`:

```ts
import type { ContributionStream, PayoutStream } from "./projection";

// One goal's already-resolved routing into accounts. The caller (client) decides
// payoutAccountId (the goal's contributionAccountId, else its first assigned
// account) and the cutoff/start years (target year, or reach year for undated).
export type GoalFlowInput = {
  monthlyContributionMinor: number;
  contributionAccountId: string | null;
  contributionUntilYear: number | null;
  spendType: "none" | "once" | "monthly" | "percent";
  spendAmountMinor: number | null;
  spendRateBps: number | null;
  payoutStartYear: number | null;
  payoutAccountId: string | null;
};

export type AccountFlows = { contributions: ContributionStream[]; payouts: PayoutStream[] };

// Bucket goal contribution/payout streams by the account they touch. Goals with a
// zero contribution / no contributionAccountId, or spendType none / no payout
// account / no start year, contribute nothing.
export function deriveAccountFlows(goals: GoalFlowInput[]): Map<string, AccountFlows> {
  const out = new Map<string, AccountFlows>();
  const bucket = (id: string): AccountFlows => {
    const existing = out.get(id);
    if (existing) return existing;
    const fresh: AccountFlows = { contributions: [], payouts: [] };
    out.set(id, fresh);
    return fresh;
  };
  for (const g of goals) {
    if (g.monthlyContributionMinor > 0 && g.contributionAccountId) {
      bucket(g.contributionAccountId).contributions.push({
        monthlyMinor: g.monthlyContributionMinor,
        untilYear: g.contributionUntilYear,
      });
    }
    if (g.spendType !== "none" && g.payoutStartYear !== null && g.payoutAccountId) {
      bucket(g.payoutAccountId).payouts.push({
        spendType: g.spendType,
        spendAmountMinor: g.spendAmountMinor,
        spendRateBps: g.spendRateBps,
        startYear: g.payoutStartYear,
      });
    }
  }
  return out;
}
```

- [ ] **Step 4: Export from the barrel**

Open `packages/shared/src/index.ts`; add `export * from "./account-flows";` alongside the other `export *` lines (match the existing barrel style).

- [ ] **Step 5: Run — expect PASS** (`cd packages/shared && bun test src/account-flows.test.ts`).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/account-flows.ts packages/shared/src/account-flows.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): deriveAccountFlows — goals to per-account flow streams"
```

---

## Task 3: Schema — drop the 8 account columns

**Files:** `apps/api/src/db/schema.ts`, generated migration under `apps/api/drizzle/`

- [ ] **Step 1: Remove the columns**

In `apps/api/src/db/schema.ts`, in the `accounts` table, **delete** these 8 column definitions: `spendType`, `spendAmountMinor`, `spendRateBps`, `spendStartKind`, `spendStartAge`, `spendStartTargetMinor`, `contributionMinor`, `contributionUntilAge`. **Keep** `growthRateBps`, `accessibleFromAge`, `earlyWithdrawal`, `earlyHaircutBps`, `illiquid`, `liquidationAge`, `compoundInterval`, `loanTermMonths`. (Note: `compoundInterval` stays — it's a vessel growth property.) Do not touch the `goals` table (its `spendType`/`spendAmountMinor`/`spendRateBps` stay).

- [ ] **Step 2: Generate + apply the migration**

Run: `bun run db:generate` → a new migration dropping the 8 columns. Then `bun run db:migrate`. (SQLite column drops are supported by drizzle's generated table-rebuild; if generate prompts for a rename it should not here since these are pure drops.)

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle
git commit -m "feat(db): drop per-account contribution/decumulation columns"
```

---

## Task 4: API — drop removed fields from valuation + accounts route

**Files:** `apps/api/src/lib/valuation.ts`, `apps/api/src/routes/accounts.ts`

- [ ] **Step 1: `netWorth` account shape**

In `apps/api/src/lib/valuation.ts`, in the account result type (around lines 60-67) and the returned object (around lines 114-121), **delete** the 8 removed fields (`spendType`, `spendAmountMinor`, `spendRateBps`, `spendStartKind`, `spendStartAge`, `spendStartTargetMinor`, `contributionMinor`, `contributionUntilAge`). Keep `growthRateBps`, `accessibleFromAge`, `earlyWithdrawal`, `earlyHaircutBps`, `illiquid`, `liquidationAge`, `loanTermMonths`, plus `compoundInterval` if it is currently surfaced (add it to the shape if the projection client needs it — it does; ensure `compoundInterval: a.compoundInterval` is present in the returned object and the type).

- [ ] **Step 2: accounts route body + insert**

In `apps/api/src/routes/accounts.ts`, in POST (insert values ~lines 58-65) and the body schema (~lines 97+), and in PATCH if present, **delete** the 8 removed fields. Keep growth/accessibility/illiquid/liquidation/compoundInterval/loanTerm handling.

- [ ] **Step 3: Run API tests touched + typecheck**

Run: `cd apps/api && bun test src/routes/accounts.test.ts` (expect green or only the pre-existing unrelated `instruments_symbol_uq` failures). Strict typecheck happens in Task 8.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/lib/valuation.ts apps/api/src/routes/accounts.ts
git commit -m "feat(api): stop surfacing/accepting per-account contribution/decumulation"
```

---

## Task 5: Web data layer — drop removed fields (accounts only)

**Files:** `apps/web/src/lib/collections.ts`, `apps/web/src/components/account-form.tsx`, `apps/web/src/lib/assumptions.ts`

- [ ] **Step 1: collections.ts**

In `apps/web/src/lib/collections.ts`, the **accounts** collection references the 8 removed fields at two places (around lines 69-76 and 97-104 — the ones that include `spendStartKind`/`contributionMinor`/`contributionUntilAge`). Delete those 8 lines in **both** account blocks. **Do NOT touch lines ~389-409** — those are the **goals** collection (`spendType`/`spendAmountMinor`/`spendRateBps` only, no `spendStart`/`contribution`), which stay.

- [ ] **Step 2: account-form.tsx**

In `apps/web/src/components/account-form.tsx`, delete the 8 removed fields from the insert payload (lines ~119-126).

- [ ] **Step 3: assumptions.ts**

Open `apps/web/src/lib/assumptions.ts`; it only seeds `growthRateBps`/`accessibleFromAge`/`earlyWithdrawal`/`illiquid` — confirm no removed field is seeded. If none, no change (note it in the report).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/collections.ts apps/web/src/components/account-form.tsx apps/web/src/lib/assumptions.ts
git commit -m "feat(web): drop per-account contribution/decumulation from data layer"
```

---

## Task 6: Web — strip contribution/withdrawal UI from the account projection editor

**Files:** `apps/web/src/components/account-projection-form.tsx`, `apps/web/src/components/account-projection-card.tsx`, `apps/web/src/components/projection-accounts.tsx`

- [ ] **Step 1: account-projection-form.tsx**

This form (the per-account vessel editor) currently has, for assets: a growth/accessibility block, an **Accumulation** block (Monthly contribution / Contribute until age / Compound), and a **Withdrawal** block (spend type / amount / rate / starts-on / start age / target). **Remove the Accumulation and Withdrawal blocks entirely** and all their form state (`FormValues` fields `contribution`, `contributionUntilAge`, `spendType`, `spendAmount`, `spendRate`, `spendStartKind`, `spendStartAge`, `spendStartTarget`), the `SPEND_LABELS`, and their reads/writes in `seedForm` + `onSubmit`. **Keep**: growth %, accessibility (accessible-from-age, before-that-age, early penalty), illiquid + liquidation age, **Compound interval** (move it up next to growth — it's a vessel property and the column stays), and the entire liability loan editor. After removal `onSubmit` writes only the vessel fields.

- [ ] **Step 2: account-projection-card.tsx**

Remove the display rows that show contribution/withdrawal (e.g. "Saves $X/mo", "Withdraws …"). Keep growth, accessibility, compounding, and (liabilities) the loan summary.

- [ ] **Step 3: projection-accounts.tsx**

Remove any per-account contribution/withdrawal summary text in the assets list. Keep growth/accessibility and the liability loan summary.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/account-projection-form.tsx apps/web/src/components/account-projection-card.tsx apps/web/src/components/projection-accounts.tsx
git commit -m "feat(web): account projection editor is vessel-only (no contribution/withdrawal)"
```

---

## Task 7: Web — feed goal-derived flows into the projection chart

**Files:** `apps/web/src/components/projection-chart.tsx`

- [ ] **Step 1: Trim `NwAccount` + the `ProjectionAccount` mapping**

In `projection-chart.tsx`, delete the 8 removed fields from the local `NwAccount` type (lines ~27-34). In the `projAccounts` map, replace the removed contribution/spend props with the new lists, initialised empty then filled from flows:

```ts
const projAccounts: ProjectionAccount[] = accounts.map((a) => ({
  baseMinor: a.baseMinor,
  growthRateBps: a.growthRateBps,
  accessibleFromAge: a.accessibleFromAge,
  earlyWithdrawal: a.earlyWithdrawal,
  earlyHaircutBps: a.earlyHaircutBps,
  illiquid: a.illiquid,
  liquidationAge: a.liquidationAge,
  ownerBirthYears: a.ownerIds.map((id) => birthById.get(id) ?? null).filter((y): y is number => y != null),
  compoundInterval: a.compoundInterval,
  isLiability: a.class === "liability",
  loanTermMonths: a.loanTermMonths,
  contributions: flows.get(a.id)?.contributions ?? [],
  payouts: flows.get(a.id)?.payouts ?? [],
}));
```

- [ ] **Step 2: Fetch goal analysis and build flows**

Add an import: `import { projectNetWorth, milestoneYears, deriveAccountFlows, type ProjectionAccount, type GoalFlowInput } from "@uang/shared";`

Add a query for goal analysis (the existing endpoint `api.goals.analysis.get()` returns `{ goals: [{ id, targetDate, reachDate, monthlyContributionMinor, contributionAccountId, accountIds, spendType, spendAmountMinor, spendRateBps, ... }] }`). Define a local type for the rows you read and a fetch fn mirroring `fetchNetWorth`. Then inside the `useMemo`, before building `projAccounts`:

```ts
const yearOf = (iso: string | null): number | null => (iso ? parseInt(iso.slice(0, 10), 10) : null);
const goalRows = goalsQ.data?.goals ?? [];
const goalFlows: GoalFlowInput[] = goalRows.map((g) => {
  const payoutAccountId = g.contributionAccountId ?? g.accountIds[0] ?? null;
  const targetYear = yearOf(g.targetDate);
  return {
    monthlyContributionMinor: g.monthlyContributionMinor,
    contributionAccountId: g.contributionAccountId ?? g.accountIds[0] ?? null,
    contributionUntilYear: targetYear ?? yearOf(g.reachDate),
    spendType: g.spendType,
    spendAmountMinor: g.spendAmountMinor ?? null,
    spendRateBps: g.spendRateBps ?? null,
    payoutStartYear: targetYear, // payout begins at the goal's target date; undated goals never pay out
    payoutAccountId,
  };
});
const flows = deriveAccountFlows(goalFlows);
```

**Required API extension (verified): `GoalAnalysis` does NOT currently expose `spendAmountMinor`/`spendRateBps`** (only `spendType` + `annualIncomeMinor`). Add them in `apps/api/src/lib/goals.ts`: in the `GoalAnalysis` type add `spendAmountMinor: number | null;` and `spendRateBps: number | null;` (next to `spendType`), and in the `analyses.push({...})` object in `analyzeGoals` add `spendAmountMinor: g.spendAmountMinor,` and `spendRateBps: g.spendRateBps,`. Then read them in the chart's local goal-row type. Add `goalsQ` to the `useMemo` deps.

- [ ] **Step 3: Build + manual sanity**

Run: `cd apps/web && bun run build`. Expect typecheck + build success (the `GoalAnalysis` extension from Step 2 must be in place first).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/projection-chart.tsx apps/api/src/lib/goals.ts
git commit -m "feat(web): projection curve derives contributions/payouts from goals"
```

---

## Task 8: Whole-suite verification

**Files:** none (verification; fix-forward if needed)

- [ ] **Step 1: Shared + API + web build**

Run from the worktree root:
- `cd packages/shared && bun test` → projection + account-flows + goals green.
- `cd apps/api && bun test src/lib/goals.test.ts src/routes/goals.test.ts src/routes/accounts.test.ts` (from `apps/api`, per-file) → green except the known pre-existing `instruments_symbol_uq` collisions in unrelated files.
- `cd apps/web && bun run build` → typecheck + build success, no `as any`.

- [ ] **Step 2: Affected E2E**

Run: `bun run e2e -- projections.spec.ts goals.spec.ts` (per `e2e/README.md`). The projections spec must still load the chart; the account-projection editor no longer has contribution/withdrawal fields — update any spec assertions that referenced them. (If the projections spec set per-account withdrawals, retarget it to assert the vessel-only editor + the curve renders.)

- [ ] **Step 3: Commit any test/spec fixes**

```bash
git add -A
git commit -m "test(e2e): update projections spec for vessel-only account editor"
```

---

## Self-review notes

- **Spec coverage:** decumulation + contributions now on goals (engine flows lists + deriveAccountFlows + chart wiring), account columns dropped (schema/valuation/route/web), account editor is vessel-only. The `/plan` page + goal-form assignment/reorder remain **Plan 3**.
- **Type consistency:** `ProjectionAccount` everywhere now uses `contributions`/`payouts` lists (engine, tests, projection-chart). `GoalFlowInput` is the single shape feeding `deriveAccountFlows`. `compoundInterval` retained on accounts (vessel growth) and surfaced by `netWorth`.
- **Known intermediate state:** between this plan and Plan 3, goals have no assigned accounts / `contributionAccountId` (no UI yet), so `deriveAccountFlows` yields nothing and the curve shows growth only — acceptable (no real goals).
- **Out of scope:** per-account *accessible* exactness when one account can't cover a goal's whole payout (single-account attribution approximation, documented).
