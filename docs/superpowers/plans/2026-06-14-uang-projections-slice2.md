# Projections — Slice 2 (Goals & Liquidity-Aware Allocation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add multiple short/long-term goals, allocate net worth across them liquidity-aware (no double-counting, accounts unlock by each goal's target date), and show per-goal required monthly contribution + an on-track/behind badge, plus the free (unallocated) net worth.

**Architecture:** All the allocation / annuity / on-track math lives as pure functions in `packages/shared` (BigInt, integer minor units, banker's rounding — same discipline as `money.ts`/`projection.ts`); there is one source of truth for the math. The heavier goals work (allocation, required-contribution solve, on-track) runs **server-side**: a new `apps/api/src/lib/goals.ts` gathers inputs (today's `netWorth()`, `netWorth({asOf: anchor})` for on-track, members, goals, settings) and calls the shared functions, exposed at `GET /goals/analysis`. Goals are a normal CRUD resource (`/goals`) surfaced to the web as a TanStack DB collection; a `/goals` page lists them grouped by term with progress bars, required contributions and on-track badges.

**Tech Stack:** Bun + ElysiaJS + Drizzle (SQLite) on the API; React + TanStack Router/Query/DB + Recharts + shadcn/ui on the web; `bun:test` for unit tests.

**Spec:** `docs/superpowers/specs/2026-06-14-uang-projections-design.md` (§3.3 goals, §3.4 settings, §5 goals & allocation, §6 goals UI). Slice 1 (curve, account assumptions, member birth years) is already merged.

**Conventions:** No `as any` (except the existing Elysia route-handler `({ ... }: any)` convention). Rates/haircuts are integer **basis points** (8% = `800`). New UI components via the shadcn CLI. Frequent commits.

**Design decisions locked for this slice (confirmed with the user):**
- **Required monthly contribution (§5.3)** uses a **level** (constant) monthly payment whose annuity future value compounds at `contributionGrowthRateBps` treated as the **annual return** the contributions earn (nominal monthly rate `i = rateBps / 12 / 10000`, monthly compounding). Standard sinking-fund formula.
- **On-track (§5.4)** is **per-goal**: re-run allocation on each account's balance **as of the goal's anchor date**, take this goal's allocated slice as the on-plan start, grow it + the required contribution to today at the single planning rate (`contributionGrowthRateBps`), and compare against today's allocated-to-this-goal.
- **Goal eligibility is independent of evaluation date** — it depends only on the owner's age at `targetDate` (§5.1). The as-of-anchor allocation therefore differs from today's only in the account *balances*, not in which accounts are eligible.
- A goal's `currency` may differ from base; the analysis converts `targetAmountMinor` to base via the latest FX rate (same path as `valuation.ts`). Tests use base-currency goals so conversion is identity.
- The funding pool is **assets with positive base balance** only (a negative/liability balance never funds a goal).

---

## File structure

**Create:**
- `packages/shared/src/goals.ts` — pure engine: `annuityFutureValueMinor`, `requiredMonthlyContributionMinor`, `compoundMonthlyMinor`, `allocateGoals`, `goalOnTrack`, and their types.
- `packages/shared/src/goals.test.ts` — engine unit tests.
- `apps/api/src/lib/goals.ts` — server assembly: `analyzeGoals()` (gathers inputs, calls shared).
- `apps/api/src/lib/goals.test.ts` — analysis integration tests against the DB.
- `apps/api/src/routes/goals.ts` — goals CRUD + `GET /goals/analysis`.
- `apps/api/src/routes/goals.test.ts` — route tests.
- `apps/api/src/routes/settings.ts` — `GET`/`PATCH` projection-assumption settings.
- `apps/api/src/routes/settings.test.ts` — route tests.
- `apps/web/src/components/goal-form.tsx` — create/edit a goal (shadcn dialog).
- `apps/web/src/routes/goals.tsx` — `/goals` page (list, progress, required, on-track, unallocated).

**Modify:**
- `apps/api/src/db/schema.ts` — `goals` table + two `settings` columns.
- `apps/api/drizzle/*` — generated migration (via `db:generate`).
- `apps/api/src/lib/test-helpers.ts` — clear `goals` in `resetDb`.
- `apps/api/src/app.ts` — mount `goalsRoutes`, `settingsRoutes`.
- `packages/shared/src/index.ts` — export `./goals`.
- `apps/web/src/lib/collections.ts` — `goalsCollection`.
- `apps/web/src/router.tsx` — register `/goals`.
- `apps/web/src/routes/dashboard.tsx` — link to `/goals`.
- `apps/web/src/routes/settings.tsx` — "Projection assumptions" section (contribution return + projection end age).

---

## Task 1: Shared — annuity & monthly compounding primitives

**Files:**
- Create: `packages/shared/src/goals.ts`
- Test: `packages/shared/src/goals.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/goals.test.ts`:

```ts
import { expect, test } from "bun:test";
import {
  annuityFutureValueMinor,
  requiredMonthlyContributionMinor,
  compoundMonthlyMinor,
} from "./goals";

// --- annuity future value (level monthly payment, ordinary annuity) ---

test("annuityFV: zero rate is just sum of payments", () => {
  expect(annuityFutureValueMinor(100_000, 0, 12)).toBe(1_200_000);
});

test("annuityFV: zero months is zero", () => {
  expect(annuityFutureValueMinor(100_000, 800, 0)).toBe(0);
});

test("annuityFV: positive rate exceeds the undiscounted sum", () => {
  // 60 payments of $500 (50_000 minor) at 6% nominal; FV > 60*50_000 = 3_000_000.
  const fv = annuityFutureValueMinor(50_000, 600, 60);
  expect(fv).toBeGreaterThan(3_000_000);
  expect(fv).toBeLessThan(3_600_000); // sanity ceiling
});

// --- required monthly contribution (inverse of annuity FV) ---

test("requiredMonthly: zero gap needs nothing", () => {
  expect(requiredMonthlyContributionMinor(0, 800, 120)).toBe(0);
  expect(requiredMonthlyContributionMinor(-5_000, 800, 120)).toBe(0);
});

test("requiredMonthly: zero rate spreads the gap evenly", () => {
  expect(requiredMonthlyContributionMinor(1_200_000, 0, 12)).toBe(100_000);
});

test("requiredMonthly: no months left means the whole gap is needed now", () => {
  expect(requiredMonthlyContributionMinor(900_000, 800, 0)).toBe(900_000);
});

test("requiredMonthly is the inverse of annuityFV (round-trips within rounding)", () => {
  const pmt = 50_000;
  const fv = annuityFutureValueMinor(pmt, 600, 120);
  const solved = requiredMonthlyContributionMinor(fv, 600, 120);
  expect(Math.abs(solved - pmt)).toBeLessThanOrEqual(2);
});

// --- monthly compounding of a lump sum ---

test("compoundMonthly: zero rate leaves principal unchanged", () => {
  expect(compoundMonthlyMinor(100_000, 0, 24)).toBe(100_000);
});

test("compoundMonthly: 12% nominal for 12 months ≈ principal * 1.01^12", () => {
  // 1.01^12 = 1.12682503... -> 112_683 (allow ±2 for banker's rounding drift)
  expect(Math.abs(compoundMonthlyMinor(100_000, 1200, 12) - 112_683)).toBeLessThanOrEqual(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && bun test src/goals.test.ts`
Expected: FAIL — `Cannot find module './goals'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/shared/src/goals.ts`:

```ts
import { roundDiv, toBig, fromBig, SCALE } from "./money";

// Rates/haircuts are integer basis points: 8% === 800, 100% === 10_000.
const BPS = 10_000n;
const MONTHS = 12n;

function assertMonths(months: number): void {
  if (!Number.isInteger(months) || months < 0) {
    throw new Error("goals: months must be a non-negative integer");
  }
}

// Nominal monthly rate, scaled by SCALE: i = (rateBps / 10_000) / 12, fixed-point.
function monthlyRateScaled(annualRateBps: number): bigint {
  return roundDiv(toBig(annualRateBps) * SCALE, BPS * MONTHS);
}

// (1 + i)^n in SCALE fixed-point, computed by repeated multiply (banker's-rounded).
function compoundFactorScaled(iScaled: bigint, months: number): bigint {
  const factor = SCALE + iScaled;
  let pow = SCALE; // represents 1.0
  for (let k = 0; k < months; k++) pow = roundDiv(pow * factor, SCALE);
  return pow;
}

// Future value of a level monthly payment (ordinary annuity), invested at
// `annualRateBps` (nominal, compounded monthly) for `months` months.
//   FV = pmt * ((1 + i)^n - 1) / i      (i > 0)
//   FV = pmt * n                        (i = 0)
export function annuityFutureValueMinor(
  pmtMinor: number,
  annualRateBps: number,
  months: number,
): number {
  assertMonths(months);
  if (months === 0) return 0;
  const iScaled = monthlyRateScaled(annualRateBps);
  if (iScaled === 0n) return fromBig(toBig(pmtMinor) * toBig(months));
  const pow = compoundFactorScaled(iScaled, months);
  // annuity factor AF = ((1+i)^n - 1) / i, in SCALE fixed-point.
  const afScaled = roundDiv((pow - SCALE) * SCALE, iScaled);
  return fromBig(roundDiv(toBig(pmtMinor) * afScaled, SCALE));
}

// Level monthly payment whose annuity future value fills `gapMinor` by `months`.
// Inverse of annuityFutureValueMinor.
export function requiredMonthlyContributionMinor(
  gapMinor: number,
  annualRateBps: number,
  months: number,
): number {
  assertMonths(months);
  if (gapMinor <= 0) return 0;
  if (months === 0) return gapMinor; // can't spread it — need it now
  const iScaled = monthlyRateScaled(annualRateBps);
  if (iScaled === 0n) return fromBig(roundDiv(toBig(gapMinor), toBig(months)));
  const pow = compoundFactorScaled(iScaled, months);
  const afScaled = roundDiv((pow - SCALE) * SCALE, iScaled);
  // pmt = gap / AF = gap * SCALE / afScaled
  return fromBig(roundDiv(toBig(gapMinor) * SCALE, afScaled));
}

// A lump sum compounded monthly at `annualRateBps` (nominal) for `months`.
export function compoundMonthlyMinor(
  principalMinor: number,
  annualRateBps: number,
  months: number,
): number {
  assertMonths(months);
  if (months === 0) return principalMinor;
  const iScaled = monthlyRateScaled(annualRateBps);
  if (iScaled === 0n) return principalMinor;
  const pow = compoundFactorScaled(iScaled, months);
  return fromBig(roundDiv(toBig(principalMinor) * pow, SCALE));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/shared && bun test src/goals.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/goals.ts packages/shared/src/goals.test.ts
git commit -m "feat(shared): annuity FV, required-contribution solve, monthly compounding"
```

---

## Task 2: Shared — liquidity-aware goal allocation

**Files:**
- Modify: `packages/shared/src/goals.ts`
- Test: `packages/shared/src/goals.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/src/goals.test.ts`:

```ts
import { allocateGoals, type AllocAccount, type GoalInput } from "./goals";

// Owner u1 born 1990. Account ages are derived from each goal's targetYear.
const u1 = "u1";
const liquid = {
  accessibleFromAge: 0, earlyWithdrawal: "none" as const, earlyHaircutBps: 0,
  illiquid: false, liquidationAge: null,
};
const cpfCfg = {
  accessibleFromAge: 55, earlyWithdrawal: "none" as const, earlyHaircutBps: 0,
  illiquid: false, liquidationAge: null,
};
const srsCfg = {
  accessibleFromAge: 62, earlyWithdrawal: "penalty" as const, earlyHaircutBps: 500,
  illiquid: false, liquidationAge: null,
};

function acct(id: string, baseMinor: number, cfg: typeof liquid, ownerIds = [u1], births = [1990]): AllocAccount {
  return { id, baseMinor, growthRateBps: 0, ownerIds, ownerBirthYears: births, ...cfg };
}

test("allocateGoals: soonest-first, no double-counting, short sees cash only", () => {
  const cash = acct("cash", 5_000_000, liquid);
  const cpf = acct("cpf", 10_000_000, cpfCfg);
  const goals: GoalInput[] = [
    // owner age in 2050 = 60 (CPF unlocked); in 2030 = 40 (CPF locked).
    { id: "long", targetAmountMinor: 20_000_000, targetYear: 2050, ownerScope: "household", term: "long", sortOrder: 0 },
    { id: "short", targetAmountMinor: 3_000_000, targetYear: 2030, ownerScope: "household", term: "short", sortOrder: 0 },
  ];
  const r = allocateGoals({ goals, accounts: [cash, cpf] });
  const short = r.goals.find((g) => g.id === "short")!;
  const long = r.goals.find((g) => g.id === "long")!;
  // Short (2030) fills entirely from cash (CPF locked at 40); cash left = 2_000_000.
  expect(short.allocatedMinor).toBe(3_000_000);
  expect(short.progressPct).toBe(100);
  // Long (2050) takes the remaining cash 2_000_000 then all CPF 10_000_000 = 12_000_000 / 20_000_000.
  expect(long.allocatedMinor).toBe(12_000_000);
  expect(long.progressPct).toBe(60);
  expect(r.unallocatedMinor).toBe(0);
});

test("allocateGoals: penalty account is valued after the haircut", () => {
  const srs = acct("srs", 1_000_000, srsCfg);
  const goals: GoalInput[] = [
    // owner age in 2030 = 40 (< 62) -> penalty 5%; eligible at 95% value.
    { id: "g", targetAmountMinor: 2_000_000, targetYear: 2030, ownerScope: "household", term: "long", sortOrder: 0 },
  ];
  const r = allocateGoals({ goals, accounts: [srs] });
  expect(r.goals[0].allocatedMinor).toBe(950_000); // 1_000_000 * 0.95
  expect(r.unallocatedMinor).toBe(0); // whole raw balance consumed
});

test("allocateGoals: illiquid excluded unless liquidationAge reached by target", () => {
  const propLocked = acct("prop", 7_000_000, { ...liquid, illiquid: true });
  const propSold = acct("prop2", 7_000_000, { ...liquid, illiquid: true, liquidationAge: 50 });
  const goals: GoalInput[] = [
    // owner age in 2050 = 60 >= 50 -> propSold eligible; propLocked never.
    { id: "g", targetAmountMinor: 100_000_000, targetYear: 2050, ownerScope: "household", term: "long", sortOrder: 0 },
  ];
  const r = allocateGoals({ goals, accounts: [propLocked, propSold] });
  expect(r.goals[0].allocatedMinor).toBe(7_000_000);
  expect(r.unallocatedMinor).toBe(7_000_000); // propLocked stays free
});

test("allocateGoals: ownerScope — personal goal sees only that member's solo accounts", () => {
  const u1solo = acct("a", 1_000_000, liquid, ["u1"]);
  const u2solo = acct("b", 1_000_000, liquid, ["u2"], [1992]);
  const shared = acct("c", 1_000_000, liquid, ["u1", "u2"], [1990, 1992]);
  const goals: GoalInput[] = [
    { id: "mine", targetAmountMinor: 9_000_000, targetYear: 2030, ownerScope: "u1", term: "short", sortOrder: 0 },
  ];
  const r = allocateGoals({ goals, accounts: [u1solo, u2solo, shared] });
  // Only u1's solo account funds a u1-personal goal (shared funds household only).
  expect(r.goals[0].allocatedMinor).toBe(1_000_000);
  expect(r.unallocatedMinor).toBe(2_000_000); // u2solo + shared untouched
});

test("allocateGoals: liabilities / negative balances never fund a goal", () => {
  const debt = acct("debt", -500_000, liquid);
  const cash = acct("cash", 1_000_000, liquid);
  const goals: GoalInput[] = [
    { id: "g", targetAmountMinor: 5_000_000, targetYear: 2030, ownerScope: "household", term: "short", sortOrder: 0 },
  ];
  const r = allocateGoals({ goals, accounts: [debt, cash] });
  expect(r.goals[0].allocatedMinor).toBe(1_000_000);
  expect(r.unallocatedMinor).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && bun test src/goals.test.ts`
Expected: FAIL — `allocateGoals` / `AllocAccount` / `GoalInput` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/shared/src/goals.ts`:

```ts
import { accessibleValueMinor, type AccessibilityConfig } from "./projection";

export type GoalTerm = "short" | "long";

export type GoalInput = {
  id: string;
  targetAmountMinor: number; // already in base currency
  targetYear: number;        // year component of targetDate
  ownerScope: string;        // 'household' | a userId
  term: GoalTerm;
  sortOrder: number;
};

export type AllocAccount = AccessibilityConfig & {
  id: string;
  baseMinor: number;        // current base-currency balance (signed)
  growthRateBps: number;
  ownerIds: string[];
  ownerBirthYears: number[]; // owners' birth years; empty = unknown (treated as accessible)
};

export type GoalAllocationLine = {
  accountId: string;
  allocatedMinor: number;
  growthRateBps: number;
};

export type GoalAllocation = {
  id: string;
  allocatedMinor: number;
  targetMinor: number;
  progressPct: number; // 0..100, integer, capped
  lines: GoalAllocationLine[];
};

export type AllocationResult = {
  goals: GoalAllocation[];
  unallocatedMinor: number;
};

// Age of an account's youngest owner in a given year; +Infinity when unknown
// (mirrors the curve: unknown birth year => age-gates don't bind).
function ownerAgeInYear(a: AllocAccount, year: number): number {
  if (a.ownerBirthYears.length === 0) return Number.POSITIVE_INFINITY;
  return year - Math.max(...a.ownerBirthYears);
}

// Whether a personal goal (ownerScope = userId) may draw from this account:
// only if the account is solely owned by that member. Shared accounts fund
// household goals only. Household goals draw from everything.
function ownerScopeAllows(a: AllocAccount, ownerScope: string): boolean {
  if (ownerScope === "household") return true;
  return a.ownerIds.length === 1 && a.ownerIds[0] === ownerScope;
}

// Liquidity ordering for "most-liquid first": liquid before age-gated before
// penalty before illiquid; ties broken by accessibleFromAge.
function liquidityRank(a: AllocAccount): number {
  if (a.illiquid) return 3_000 + a.accessibleFromAge;
  if (a.earlyWithdrawal === "penalty" && a.accessibleFromAge > 0) return 2_000 + a.accessibleFromAge;
  return a.accessibleFromAge; // 0 for fully-liquid
}

const BPS_ALLOC = 10_000n;

// Raw balance consumed to deliver `takeMinor` of post-haircut value from a
// penalty account: take / (1 - haircut), rounded up so we never leave phantom
// dollars behind.
function rawConsumedForPenalty(takeMinor: number, haircutBps: number): number {
  const num = toBig(takeMinor) * BPS_ALLOC;
  const den = BPS_ALLOC - toBig(haircutBps);
  return fromBig((num + den - 1n) / den); // ceil-div, positive operands
}

export function allocateGoals(params: {
  goals: GoalInput[];
  accounts: AllocAccount[];
}): AllocationResult {
  const { goals, accounts } = params;

  // Raw remaining pool: assets with a positive base balance only.
  const remaining = new Map<string, number>();
  for (const a of accounts) if (a.baseMinor > 0) remaining.set(a.id, a.baseMinor);

  // Soonest target first; tie-break short before long, then sortOrder.
  const ordered = [...goals].sort((g1, g2) => {
    if (g1.targetYear !== g2.targetYear) return g1.targetYear - g2.targetYear;
    if (g1.term !== g2.term) return g1.term === "short" ? -1 : 1;
    return g1.sortOrder - g2.sortOrder;
  });

  const out: GoalAllocation[] = [];
  for (const goal of ordered) {
    let need = goal.targetAmountMinor;
    let allocated = 0;
    const lines: GoalAllocationLine[] = [];

    const eligible = accounts
      .filter((a) => (remaining.get(a.id) ?? 0) > 0 && ownerScopeAllows(a, goal.ownerScope))
      .sort((x, y) => liquidityRank(x) - liquidityRank(y));

    for (const a of eligible) {
      if (need <= 0) break;
      const raw = remaining.get(a.id) ?? 0;
      if (raw <= 0) continue;
      const age = ownerAgeInYear(a, goal.targetYear);
      const available = accessibleValueMinor(raw, age, a); // post-haircut / lock-aware
      if (available <= 0) continue;
      const take = Math.min(need, available);
      allocated += take;
      need -= take;
      lines.push({ accountId: a.id, allocatedMinor: take, growthRateBps: a.growthRateBps });
      const penaltyApplies = !a.illiquid && age < a.accessibleFromAge && a.earlyWithdrawal === "penalty";
      const consumed = take >= available
        ? raw // exhausted this account's accessible value -> raw is gone
        : (penaltyApplies ? rawConsumedForPenalty(take, a.earlyHaircutBps) : take);
      remaining.set(a.id, Math.max(0, raw - consumed));
    }

    const target = goal.targetAmountMinor;
    const progressPct = target <= 0 ? 100 : Math.min(100, Math.round((allocated * 100) / target));
    out.push({ id: goal.id, allocatedMinor: allocated, targetMinor: target, progressPct, lines });
  }

  let unallocated = 0;
  for (const v of remaining.values()) unallocated += v;

  // Preserve the caller's goal order in the result (allocation order is internal).
  const byId = new Map(out.map((g) => [g.id, g]));
  return { goals: goals.map((g) => byId.get(g.id)!), unallocatedMinor: unallocated };
}
```

> Note: `targetAmountMinor` on a `GoalInput` is always **already in base currency** — the server converts each goal's target before calling `allocateGoals` (Task 7). The pure function does no currency conversion.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/shared && bun test src/goals.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/goals.ts packages/shared/src/goals.test.ts
git commit -m "feat(shared): liquidity-aware goal allocation (no double-count, ownerScope, haircut)"
```

---

## Task 3: Shared — on-track / behind + export engine

**Files:**
- Modify: `packages/shared/src/goals.ts`, `packages/shared/src/index.ts`
- Test: `packages/shared/src/goals.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/src/goals.test.ts`:

```ts
import { goalOnTrack } from "./goals";

test("goalOnTrack: zero planning rate is hand-computable; ahead when actual exceeds plan", () => {
  // target 1_000_000, start-at-anchor 100_000, 100 months to target, 20 elapsed.
  // plan rate 0 -> requiredPmt = (1_000_000 - 100_000) / 100 = 9_000/mo.
  // onPlanToday = 100_000 + 9_000*20 = 280_000.
  const r = goalOnTrack({
    targetMinor: 1_000_000, startAnchorMinor: 100_000, allocatedTodayMinor: 300_000,
    planRateBps: 0, monthsAnchorToToday: 20, monthsAnchorToTarget: 100,
  });
  expect(r.onPlanTodayMinor).toBe(280_000);
  expect(r.aheadByMinor).toBe(20_000);
  expect(r.onTrack).toBe(true);
});

test("goalOnTrack: behind when actual is below the on-plan value", () => {
  const r = goalOnTrack({
    targetMinor: 1_000_000, startAnchorMinor: 100_000, allocatedTodayMinor: 250_000,
    planRateBps: 0, monthsAnchorToToday: 20, monthsAnchorToTarget: 100,
  });
  expect(r.onPlanTodayMinor).toBe(280_000);
  expect(r.aheadByMinor).toBe(-30_000);
  expect(r.onTrack).toBe(false);
});

test("goalOnTrack: a brand-new goal (no time elapsed) is on track by construction", () => {
  const r = goalOnTrack({
    targetMinor: 1_000_000, startAnchorMinor: 250_000, allocatedTodayMinor: 250_000,
    planRateBps: 800, monthsAnchorToToday: 0, monthsAnchorToTarget: 120,
  });
  expect(r.onPlanTodayMinor).toBe(250_000); // start grown 0 months + 0 contributions
  expect(r.aheadByMinor).toBe(0);
  expect(r.onTrack).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && bun test src/goals.test.ts`
Expected: FAIL — `goalOnTrack` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/shared/src/goals.ts`:

```ts
export type OnTrack = {
  onPlanTodayMinor: number;
  aheadByMinor: number; // actual - on-plan (negative => behind)
  onTrack: boolean;
};

// Per-goal glide-path check. The plan is fixed at the anchor: grow the
// allocated-at-anchor start to the target at `planRateBps` and add the level
// contribution that closes the remaining gap by `monthsAnchorToTarget`. The
// on-plan value today is the start grown to today plus that contribution's
// annuity FV over the elapsed months. We are on track iff today's actual
// allocation is at least the on-plan value.
export function goalOnTrack(params: {
  targetMinor: number;
  startAnchorMinor: number;
  allocatedTodayMinor: number;
  planRateBps: number;
  monthsAnchorToToday: number;
  monthsAnchorToTarget: number;
}): OnTrack {
  const {
    targetMinor, startAnchorMinor, allocatedTodayMinor,
    planRateBps, monthsAnchorToToday, monthsAnchorToTarget,
  } = params;

  const startGrownToTarget = compoundMonthlyMinor(startAnchorMinor, planRateBps, monthsAnchorToTarget);
  const planGap = targetMinor - startGrownToTarget;
  const requiredPmt = requiredMonthlyContributionMinor(planGap, planRateBps, monthsAnchorToTarget);

  const startGrownToToday = compoundMonthlyMinor(startAnchorMinor, planRateBps, monthsAnchorToToday);
  const contributedToToday = annuityFutureValueMinor(requiredPmt, planRateBps, monthsAnchorToToday);
  const onPlanTodayMinor = startGrownToToday + contributedToToday;

  const aheadByMinor = allocatedTodayMinor - onPlanTodayMinor;
  return { onPlanTodayMinor, aheadByMinor, onTrack: aheadByMinor >= 0 };
}
```

Add to `packages/shared/src/index.ts` (after the existing exports):

```ts
export * from "./goals";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/shared && bun test`
Expected: PASS (money + currencies + projection + goals suites all green).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/goals.ts packages/shared/src/goals.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): per-goal on-track glide-path check; export goals engine"
```

---

## Task 4: API — goals table + settings columns + migration

**Files:**
- Modify: `apps/api/src/db/schema.ts`, `apps/api/src/lib/test-helpers.ts`
- Create: generated migration under `apps/api/drizzle/`

- [ ] **Step 1: Add the settings columns**

In `apps/api/src/db/schema.ts`, replace the `settings` table definition with this version (adds two columns; keeps everything else):

```ts
export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey(), // always 1
  householdName: text("household_name").notNull(),
  baseCurrency: text("base_currency").notNull(),
  // Projection assumptions (slice 2). Both editable in Settings.
  contributionGrowthRateBps: integer("contribution_growth_rate_bps").notNull().default(800),
  projectionEndAge: integer("projection_end_age").notNull().default(90),
  createdAt: integer("created_at").notNull(),
});
```

- [ ] **Step 2: Add the goals table**

In `apps/api/src/db/schema.ts`, add this after the `memberProfiles` table (before `export * from "./auth-schema"`):

```ts
// Financial goals. term drives grouping/sort; eligibility derives from targetDate.
// ownerScope is 'household' or a userId. anchorDate is the optional on-track
// baseline (null => anchor at createdAt).
export const goals = sqliteTable("goals", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  term: text("term").$type<"short" | "long">().notNull(),
  targetAmountMinor: integer("target_amount_minor").notNull(),
  currency: text("currency").notNull(),
  targetDate: text("target_date").notNull(), // YYYY-MM-DD
  ownerScope: text("owner_scope").notNull().default("household"),
  anchorDate: text("anchor_date"), // YYYY-MM-DD | null
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  createdBy: text("created_by").notNull(),
});
```

- [ ] **Step 3: Generate the migration**

Run: `cd apps/api && bun run db:generate`
Expected: a new file `apps/api/drizzle/0003_*.sql` containing `ALTER TABLE settings ADD ...` for the two columns and `CREATE TABLE \`goals\` ...`, plus an updated `drizzle/meta/_journal.json`.

Verify:

Run: `cd apps/api && cat drizzle/0003_*.sql`
Expected: includes `contribution_growth_rate_bps`, `projection_end_age`, and `CREATE TABLE \`goals\`` with `target_amount_minor`, `target_date`, `owner_scope`, `anchor_date`.

- [ ] **Step 4: Clear goals in test reset**

In `apps/api/src/lib/test-helpers.ts`, add `goals` to the schema import:

```ts
import { settings, user, accounts, accountOwners, memberProfiles, goals, entries, fxRates, instruments, lots, prices } from "../db/schema";
```

Add this line inside `resetDb`, right after `await db.delete(memberProfiles);`:

```ts
  await db.delete(goals);
```

- [ ] **Step 5: Verify existing tests still pass against the migrated schema**

Run: `cd apps/api && bun test src/routes/onboarding.test.ts src/lib/valuation.test.ts`
Expected: PASS (migration applies cleanly; settings defaults backfill).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle apps/api/src/lib/test-helpers.ts
git commit -m "feat(api): goals table + settings projection-assumption columns"
```

---

## Task 5: API — settings route (read/update assumptions)

**Files:**
- Create: `apps/api/src/routes/settings.ts`, `apps/api/src/routes/settings.test.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/settings.test.ts`:

```ts
import { expect, test, beforeEach } from "bun:test";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { settingsRoutes } from "./settings";

beforeEach(resetDb);

const app = makeApp(settingsRoutes);

test("GET /settings returns base currency + assumption defaults", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const res = await app.handle(new Request("http://localhost/settings", { headers: { cookie } }));
  expect(res.status).toBe(200);
  const s = await res.json();
  expect(s.baseCurrency).toBe("USD");
  expect(s.contributionGrowthRateBps).toBe(800);
  expect(s.projectionEndAge).toBe(90);
});

test("PATCH /settings updates assumptions", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const patch = await app.handle(new Request("http://localhost/settings", {
    method: "PATCH", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ contributionGrowthRateBps: 600, projectionEndAge: 85 }),
  }));
  expect(patch.status).toBe(200);

  const s = await (await app.handle(new Request("http://localhost/settings", { headers: { cookie } }))).json();
  expect(s.contributionGrowthRateBps).toBe(600);
  expect(s.projectionEndAge).toBe(85);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bun test src/routes/settings.test.ts`
Expected: FAIL — `Cannot find module './settings'`.

- [ ] **Step 3: Implement the route**

Create `apps/api/src/routes/settings.ts`:

```ts
import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { settings } from "../db/schema";
import { eq } from "drizzle-orm";
import { authGuard } from "../lib/auth-guard";

export const settingsRoutes = new Elysia({ prefix: "/settings" })
  .use(authGuard)
  .get("/", async () => {
    const s = (await db.select().from(settings).where(eq(settings.id, 1)))[0];
    return {
      householdName: s?.householdName ?? "",
      baseCurrency: s?.baseCurrency ?? "USD",
      contributionGrowthRateBps: s?.contributionGrowthRateBps ?? 800,
      projectionEndAge: s?.projectionEndAge ?? 90,
    };
  })
  .patch(
    "/",
    async ({ body }: any) => {
      const update: Record<string, unknown> = {};
      if (body.contributionGrowthRateBps !== undefined) update.contributionGrowthRateBps = body.contributionGrowthRateBps;
      if (body.projectionEndAge !== undefined) update.projectionEndAge = body.projectionEndAge;
      if (Object.keys(update).length > 0) {
        await db.update(settings).set(update).where(eq(settings.id, 1));
      }
      return { ok: true };
    },
    {
      body: t.Object({
        contributionGrowthRateBps: t.Optional(t.Number()),
        projectionEndAge: t.Optional(t.Number()),
      }),
    },
  );
```

Mount it in `apps/api/src/app.ts`: add the import near the other route imports:

```ts
import { settingsRoutes } from "./routes/settings";
```

and add `.use(settingsRoutes)` to the chain (e.g., right after `.use(membersRoutes)`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && bun test src/routes/settings.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/settings.ts apps/api/src/routes/settings.test.ts apps/api/src/app.ts
git commit -m "feat(api): settings route for projection assumptions"
```

---

## Task 6: API — goals CRUD route

**Files:**
- Create: `apps/api/src/routes/goals.ts`, `apps/api/src/routes/goals.test.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/goals.test.ts`:

```ts
import { expect, test, beforeEach } from "bun:test";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { goalsRoutes } from "./goals";

beforeEach(resetDb);

const app = makeApp(goalsRoutes);

test("POST /goals creates, GET lists, PATCH edits, DELETE removes", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const id = crypto.randomUUID();

  const create = await app.handle(new Request("http://localhost/goals", {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      id, name: "House", term: "long", targetAmountMinor: 50_000_000,
      currency: "USD", targetDate: "2035-01-01", ownerScope: "household",
    }),
  }));
  expect(create.status).toBe(200);

  let list = await (await app.handle(new Request("http://localhost/goals", { headers: { cookie } }))).json();
  expect(list.length).toBe(1);
  let g = list.find((x: any) => x.id === id);
  expect(g.name).toBe("House");
  expect(g.term).toBe("long");
  expect(g.targetAmountMinor).toBe(50_000_000);
  expect(g.targetDate).toBe("2035-01-01");
  expect(g.ownerScope).toBe("household");
  expect(g.anchorDate).toBeNull();

  const patch = await app.handle(new Request(`http://localhost/goals/${id}`, {
    method: "PATCH", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "Bigger house", targetAmountMinor: 80_000_000, anchorDate: "2024-01-01" }),
  }));
  expect(patch.status).toBe(200);

  list = await (await app.handle(new Request("http://localhost/goals", { headers: { cookie } }))).json();
  g = list.find((x: any) => x.id === id);
  expect(g.name).toBe("Bigger house");
  expect(g.targetAmountMinor).toBe(80_000_000);
  expect(g.anchorDate).toBe("2024-01-01");

  const del = await app.handle(new Request(`http://localhost/goals/${id}`, { method: "DELETE", headers: { cookie } }));
  expect(del.status).toBe(200);
  list = await (await app.handle(new Request("http://localhost/goals", { headers: { cookie } }))).json();
  expect(list.length).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bun test src/routes/goals.test.ts`
Expected: FAIL — `Cannot find module './goals'`.

- [ ] **Step 3: Implement the route**

Create `apps/api/src/routes/goals.ts`:

```ts
import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { goals } from "../db/schema";
import { eq } from "drizzle-orm";
import { authGuard } from "../lib/auth-guard";
import { createId, nowEpoch } from "../lib/ids";
import { isUniqueViolation } from "../lib/db-errors";
import { analyzeGoals } from "../lib/goals";

export const goalsRoutes = new Elysia({ prefix: "/goals" })
  .use(authGuard)
  .get("/", async () => db.select().from(goals).orderBy(goals.sortOrder))
  // Heavier liquidity-aware analysis (allocation + required contribution + on-track).
  .get("/analysis", async () => analyzeGoals())
  .post(
    "/",
    async ({ body, userId, set }: any) => {
      const id = body.id ?? createId();
      try {
        await db.insert(goals).values({
          id,
          name: body.name,
          term: body.term === "short" ? "short" : "long",
          targetAmountMinor: body.targetAmountMinor,
          currency: body.currency.toUpperCase(),
          targetDate: body.targetDate,
          ownerScope: body.ownerScope ?? "household",
          anchorDate: body.anchorDate ?? null,
          sortOrder: body.sortOrder ?? 0,
          createdAt: nowEpoch(),
          createdBy: userId!,
        });
      } catch (e) {
        if (isUniqueViolation(e)) {
          set.status = 409;
          return { error: "duplicate_id" };
        }
        throw e;
      }
      return { id };
    },
    {
      body: t.Object({
        id: t.Optional(t.String()),
        name: t.String({ minLength: 1 }),
        term: t.Union([t.Literal("short"), t.Literal("long")]),
        targetAmountMinor: t.Number(),
        currency: t.String({ pattern: "^[A-Za-z]{3}$" }),
        targetDate: t.String(),
        ownerScope: t.Optional(t.String()),
        anchorDate: t.Optional(t.Union([t.String(), t.Null()])),
        sortOrder: t.Optional(t.Number()),
      }),
    },
  )
  .patch(
    "/:id",
    async ({ params, body }: any) => {
      const update: Record<string, unknown> = {};
      if (body.name !== undefined) update.name = body.name;
      if (body.term !== undefined) update.term = body.term;
      if (body.targetAmountMinor !== undefined) update.targetAmountMinor = body.targetAmountMinor;
      if (body.currency !== undefined) update.currency = body.currency.toUpperCase();
      if (body.targetDate !== undefined) update.targetDate = body.targetDate;
      if (body.ownerScope !== undefined) update.ownerScope = body.ownerScope;
      if (body.anchorDate !== undefined) update.anchorDate = body.anchorDate;
      if (body.sortOrder !== undefined) update.sortOrder = body.sortOrder;
      await db.update(goals).set(update).where(eq(goals.id, params.id));
      return { ok: true };
    },
    {
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1 })),
        term: t.Optional(t.Union([t.Literal("short"), t.Literal("long")])),
        targetAmountMinor: t.Optional(t.Number()),
        currency: t.Optional(t.String({ pattern: "^[A-Za-z]{3}$" })),
        targetDate: t.Optional(t.String()),
        ownerScope: t.Optional(t.String()),
        anchorDate: t.Optional(t.Union([t.String(), t.Null()])),
        sortOrder: t.Optional(t.Number()),
      }),
    },
  )
  .delete("/:id", async ({ params }: any) => {
    await db.delete(goals).where(eq(goals.id, params.id));
    return { ok: true };
  });
```

> `analyzeGoals` is implemented in Task 7. The CRUD test in this task does not call `/analysis`, so it passes once `apps/api/src/lib/goals.ts` exists and exports a (possibly trivial) `analyzeGoals`. To keep this task self-contained, create the stub now and flesh it out in Task 7:

Create `apps/api/src/lib/goals.ts` (stub — replaced in Task 7):

```ts
export async function analyzeGoals() {
  return { baseCurrency: "USD", contributionGrowthRateBps: 800, unallocatedMinor: 0, goals: [], overall: { onTrack: true, behindCount: 0 } };
}
```

Mount the route in `apps/api/src/app.ts`: add the import near the other route imports:

```ts
import { goalsRoutes } from "./routes/goals";
```

and add `.use(goalsRoutes)` to the chain (e.g., right after `.use(settingsRoutes)`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && bun test src/routes/goals.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/goals.ts apps/api/src/routes/goals.test.ts apps/api/src/lib/goals.ts apps/api/src/app.ts
git commit -m "feat(api): goals CRUD route (+ analysis stub)"
```

---

## Task 7: API — goals analysis (allocation + required contribution + on-track)

**Files:**
- Modify: `apps/api/src/lib/goals.ts`
- Test: `apps/api/src/lib/goals.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/lib/goals.test.ts`:

```ts
import { expect, test, beforeEach } from "bun:test";
import { db } from "../db/client";
import { accounts, entries, goals, memberProfiles, user } from "../db/schema";
import { createId, nowEpoch } from "./ids";
import { setOwners } from "./owners";
import { resetDb, initAndLogin } from "./test-helpers";
import { analyzeGoals } from "./goals";

beforeEach(resetDb);

// Seed an asset account owned by `ownerId`, with an opening ledger balance.
async function addAccount(opts: {
  name: string; subtype: string; accessibleFromAge?: number;
  earlyWithdrawal?: "none" | "penalty"; earlyHaircutBps?: number; illiquid?: boolean;
  openingMinor: number; ownerId: string;
}) {
  const id = createId();
  await db.insert(accounts).values({
    id, name: opts.name, class: "asset", subtype: opts.subtype, currency: "USD",
    valuationMode: "ledger", isArchived: 0, sortOrder: 0,
    growthRateBps: 0,
    accessibleFromAge: opts.accessibleFromAge ?? 0,
    earlyWithdrawal: opts.earlyWithdrawal ?? "none",
    earlyHaircutBps: opts.earlyHaircutBps ?? 0,
    illiquid: opts.illiquid ? 1 : 0, liquidationAge: null,
    createdAt: nowEpoch(), createdBy: "seed",
  });
  await setOwners(id, [opts.ownerId]);
  await db.insert(entries).values({
    id: createId(), accountId: id, date: "2020-01-01", amountMinor: opts.openingMinor,
    kind: "opening", createdAt: nowEpoch(), createdBy: "seed",
  });
  return id;
}

test("analyzeGoals: soonest-first allocation, short sees cash only, long picks up CPF", async () => {
  // initAndLogin creates the household (settings with default assumptions) + the admin user.
  await initAndLogin({ baseCurrency: "USD" });
  const [owner] = await db.select().from(user);
  const userId = owner.id;
  // Member well under 55 at the short target (2030) and over 55 at the long one (2050).
  await db.insert(memberProfiles).values({ userId, birthYear: 1990 });

  await addAccount({ name: "Cash", subtype: "bank", openingMinor: 5_000_000, ownerId: userId });
  await addAccount({ name: "CPF", subtype: "other", accessibleFromAge: 55, openingMinor: 10_000_000, ownerId: userId });

  await db.insert(goals).values([
    { id: "short", name: "Car", term: "short", targetAmountMinor: 3_000_000, currency: "USD", targetDate: "2030-01-01", ownerScope: "household", anchorDate: null, sortOrder: 0, createdAt: nowEpoch(), createdBy: "seed" },
    { id: "long", name: "Retire", term: "long", targetAmountMinor: 20_000_000, currency: "USD", targetDate: "2050-01-01", ownerScope: "household", anchorDate: null, sortOrder: 0, createdAt: nowEpoch(), createdBy: "seed" },
  ]);

  const r = await analyzeGoals();
  const short = r.goals.find((g) => g.id === "short")!;
  const long = r.goals.find((g) => g.id === "long")!;

  expect(short.allocatedMinor).toBe(3_000_000); // all from cash (CPF locked at age 40)
  expect(short.progressPct).toBe(100);
  expect(long.allocatedMinor).toBe(12_000_000); // leftover cash 2_000_000 + CPF 10_000_000
  expect(long.progressPct).toBe(60);
  expect(r.unallocatedMinor).toBe(0);
  expect(r.contributionGrowthRateBps).toBe(800);

  // The fully-funded short goal needs no contribution and is on track.
  expect(short.requiredMonthlyMinor).toBe(0);
  expect(short.onTrack).toBe(true);
  // The under-funded long goal needs a positive monthly contribution.
  expect(long.requiredMonthlyMinor).toBeGreaterThan(0);
});
```

> `setOwners` is the same helper the accounts route uses. `initAndLogin` (from `test-helpers`) creates the settings singleton with the schema-default assumptions, so the test needs no manual `settings` insert. `analyzeGoals()` reads the DB directly (not over HTTP), so seeding via `db` is sufficient.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bun test src/lib/goals.test.ts`
Expected: FAIL — the stub returns empty `goals`, so `short` is `undefined`.

- [ ] **Step 3: Implement the analysis**

Replace the entire contents of `apps/api/src/lib/goals.ts` with:

```ts
import { db } from "../db/client";
import { goals as goalsTable, memberProfiles } from "../db/schema";
import {
  convertToBase, toBig, fromBig, compoundMinor,
  allocateGoals, requiredMonthlyContributionMinor, goalOnTrack,
  type AllocAccount, type GoalInput,
} from "@uang/shared";
import { netWorth, latestFxRateScaled } from "./valuation";
import { getSettings } from "./settings";

type GoalRow = typeof goalsTable.$inferSelect;

export type GoalAnalysis = {
  id: string;
  name: string;
  term: "short" | "long";
  targetAmountMinor: number; // base currency
  targetDate: string;
  currency: string;
  allocatedMinor: number;
  progressPct: number;
  projectedAllocatedMinor: number;
  gapMinor: number;
  requiredMonthlyMinor: number;
  onPlanTodayMinor: number;
  aheadByMinor: number;
  onTrack: boolean;
};

export type GoalsAnalysisResult = {
  baseCurrency: string;
  contributionGrowthRateBps: number;
  unallocatedMinor: number;
  goals: GoalAnalysis[];
  overall: { onTrack: boolean; behindCount: number };
};

const yearOf = (iso: string): number => parseInt(iso.slice(0, 10), 10);

function monthsBetween(fromISO: string, toISO: string): number {
  const f = new Date(`${fromISO.slice(0, 10)}T00:00:00Z`);
  const t = new Date(`${toISO.slice(0, 10)}T00:00:00Z`);
  const m = (t.getUTCFullYear() - f.getUTCFullYear()) * 12 + (t.getUTCMonth() - f.getUTCMonth());
  return Math.max(0, m);
}

// Convert a goal's target into base currency using the latest FX rate.
async function targetInBaseMinor(g: GoalRow, base: string): Promise<number> {
  if (g.currency.toUpperCase() === base.toUpperCase()) return g.targetAmountMinor;
  const rate = await latestFxRateScaled(g.currency);
  if (rate === null) return g.targetAmountMinor; // no rate: best-effort, treat as base
  return fromBig(convertToBase(toBig(g.targetAmountMinor), g.currency, base, toBig(rate)));
}

// Build the allocation-account list from a netWorth() snapshot + member birth years.
function toAllocAccounts(
  nwAccounts: Awaited<ReturnType<typeof netWorth>>["accounts"],
  birthByUser: Map<string, number | null>,
): AllocAccount[] {
  return nwAccounts.map((a) => ({
    id: a.id,
    baseMinor: a.baseMinor,
    growthRateBps: a.growthRateBps,
    accessibleFromAge: a.accessibleFromAge,
    earlyWithdrawal: a.earlyWithdrawal,
    earlyHaircutBps: a.earlyHaircutBps,
    illiquid: a.illiquid,
    liquidationAge: a.liquidationAge,
    ownerIds: a.ownerIds,
    ownerBirthYears: a.ownerIds
      .map((id) => birthByUser.get(id) ?? null)
      .filter((y): y is number => y != null),
  }));
}

export async function analyzeGoals(): Promise<GoalsAnalysisResult> {
  const s = await getSettings();
  const base = s?.baseCurrency ?? "USD";
  const planRateBps = s?.contributionGrowthRateBps ?? 800;

  const goalRows = await db.select().from(goalsTable).orderBy(goalsTable.sortOrder);
  const profiles = await db.select().from(memberProfiles);
  const birthByUser = new Map<string, number | null>(profiles.map((p) => [p.userId, p.birthYear]));

  const todayISO = new Date().toISOString().slice(0, 10);
  const thisYear = yearOf(todayISO);

  // Today's snapshot -> base targets -> allocation.
  const nwToday = await netWorth({ owner: "household" });
  const allocAccountsToday = toAllocAccounts(nwToday.accounts, birthByUser);

  const goalInputs: GoalInput[] = [];
  const targetBaseById = new Map<string, number>();
  for (const g of goalRows) {
    const targetBase = await targetInBaseMinor(g, base);
    targetBaseById.set(g.id, targetBase);
    goalInputs.push({
      id: g.id, targetAmountMinor: targetBase, targetYear: yearOf(g.targetDate),
      ownerScope: g.ownerScope, term: g.term, sortOrder: g.sortOrder,
    });
  }

  const allocToday = allocateGoals({ goals: goalInputs, accounts: allocAccountsToday });
  const allocById = new Map(allocToday.goals.map((g) => [g.id, g]));

  // For on-track we need each goal's allocated-at-anchor. Group goals by distinct
  // anchor date so we run one netWorth() snapshot + allocation per anchor.
  const anchorByGoal = new Map<string, string>();
  for (const g of goalRows) anchorByGoal.set(g.id, (g.anchorDate ?? new Date(g.createdAt * 1000).toISOString().slice(0, 10)));
  const distinctAnchors = [...new Set(anchorByGoal.values())];

  const allocatedAtAnchorById = new Map<string, number>();
  for (const anchor of distinctAnchors) {
    const nwAnchor = await netWorth({ asOf: anchor, owner: "household" });
    const allocAnchor = allocateGoals({
      goals: goalInputs,
      accounts: toAllocAccounts(nwAnchor.accounts, birthByUser),
    });
    for (const g of allocAnchor.goals) {
      if (anchorByGoal.get(g.id) === anchor) allocatedAtAnchorById.set(g.id, g.allocatedMinor);
    }
  }

  const analyses: GoalAnalysis[] = [];
  for (const g of goalRows) {
    const targetBase = targetBaseById.get(g.id) ?? g.targetAmountMinor;
    const alloc = allocById.get(g.id)!;

    // §5.3 projected allocated: grow each allocated line at its own rate to target year.
    const yearsToTarget = Math.max(0, yearOf(g.targetDate) - thisYear);
    let projectedAllocated = 0;
    for (const line of alloc.lines) {
      projectedAllocated += compoundMinor(line.allocatedMinor, line.growthRateBps, yearsToTarget);
    }
    const gap = targetBase - projectedAllocated;
    const monthsToTarget = monthsBetween(todayISO, g.targetDate);
    const requiredMonthly = requiredMonthlyContributionMinor(gap, planRateBps, monthsToTarget);

    // §5.4 on-track, per goal, anchored.
    const anchor = anchorByGoal.get(g.id)!;
    const startAnchor = allocatedAtAnchorById.get(g.id) ?? alloc.allocatedMinor;
    const ot = goalOnTrack({
      targetMinor: targetBase,
      startAnchorMinor: startAnchor,
      allocatedTodayMinor: alloc.allocatedMinor,
      planRateBps,
      monthsAnchorToToday: monthsBetween(anchor, todayISO),
      monthsAnchorToTarget: monthsBetween(anchor, g.targetDate),
    });

    analyses.push({
      id: g.id, name: g.name, term: g.term, targetAmountMinor: targetBase,
      targetDate: g.targetDate, currency: g.currency,
      allocatedMinor: alloc.allocatedMinor, progressPct: alloc.progressPct,
      projectedAllocatedMinor: projectedAllocated, gapMinor: Math.max(0, gap),
      requiredMonthlyMinor: requiredMonthly,
      onPlanTodayMinor: ot.onPlanTodayMinor, aheadByMinor: ot.aheadByMinor, onTrack: ot.onTrack,
    });
  }

  const behindCount = analyses.filter((a) => !a.onTrack).length;
  return {
    baseCurrency: base,
    contributionGrowthRateBps: planRateBps,
    unallocatedMinor: allocToday.unallocatedMinor,
    goals: analyses,
    overall: { onTrack: behindCount === 0, behindCount },
  };
}
```

> `compoundMinor` (annual compounding, banker's-rounded) is imported from `@uang/shared` — the same primitive slice 1's curve uses — so the goals projection and the curve never diverge.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && bun test src/lib/goals.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the goals route test too (analysis now real)**

Run: `cd apps/api && bun test src/routes/goals.test.ts`
Expected: PASS (CRUD unaffected).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/goals.ts apps/api/src/lib/goals.test.ts
git commit -m "feat(api): goals analysis — allocation, required contribution, on-track"
```

---

## Task 8: Web — goals collection

**Files:**
- Modify: `apps/web/src/lib/collections.ts`

- [ ] **Step 1: Add goalsCollection**

Append to `apps/web/src/lib/collections.ts`:

```ts
// ---------------------------------------------------------------------------
// goalsCollection — financial goals
// ---------------------------------------------------------------------------

export type GoalRow = RowOf<typeof api.goals.get>;
type GoalApi = ReturnType<typeof api.goals>;

export const goalsCollection = createCollection(
  queryCollectionOptions<GoalRow, Error, ["goals"], string>({
    queryKey: ["goals"],
    queryFn: async (): Promise<Array<GoalRow>> => {
      const { data, error } = await api.goals.get();
      if (error) throw new Error(String(error));
      return Array.isArray(data) ? data : [];
    },
    queryClient,
    getKey: (g) => g.id,
    onInsert: async ({ transaction }) => {
      const m = transaction.mutations[0]?.modified as GoalRow | undefined;
      if (!m) return;
      const { error } = await api.goals.post({
        id: m.id,
        name: m.name,
        term: m.term,
        targetAmountMinor: m.targetAmountMinor,
        currency: m.currency,
        targetDate: m.targetDate,
        ownerScope: m.ownerScope,
        anchorDate: m.anchorDate ?? null,
        sortOrder: m.sortOrder,
      });
      if (error) throw new Error(String(error));
    },
    onUpdate: async ({ transaction }) => {
      const m = transaction.mutations[0]?.modified as GoalRow | undefined;
      if (!m) return;
      const { error } = await api.goals({ id: m.id }).patch({
        name: m.name,
        term: m.term,
        targetAmountMinor: m.targetAmountMinor,
        currency: m.currency,
        targetDate: m.targetDate,
        ownerScope: m.ownerScope,
        anchorDate: m.anchorDate ?? null,
        sortOrder: m.sortOrder,
      });
      if (error) throw new Error(String(error));
    },
    onDelete: async ({ transaction }) => {
      const id = (transaction.mutations[0]?.original as GoalRow | undefined)?.id;
      if (!id) return;
      const { error } = await api.goals({ id }).delete();
      if (error) throw new Error(String(error));
    },
  })
);
```

> `GoalApi` is declared for parity with the other parameterised-route types; it is not strictly required. Remove it if `tsc` flags it as unused (the repo's tsconfig may not error on unused types — check before deleting).

- [ ] **Step 2: Type-check**

Run: `cd apps/web && bunx tsc -b`
Expected: no type errors. (If `api.goals` is missing, the API app type wasn't rebuilt — ensure Tasks 6–7 landed.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/collections.ts
git commit -m "feat(web): goals collection"
```

---

## Task 9: Web — goal form (create / edit dialog)

**Files:**
- Create: `apps/web/src/components/goal-form.tsx`

- [ ] **Step 1: Build the dialog**

Create `apps/web/src/components/goal-form.tsx`:

```tsx
import { useState } from "react";
import { currencyDecimals } from "@uang/shared";
import { goalsCollection, newId, type GoalRow } from "@/lib/collections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

// major <-> minor helpers for the amount input.
const toMajor = (minor: number, currency: string) => String(minor / 10 ** currencyDecimals(currency));
const toMinor = (major: string, currency: string) =>
  Math.round((parseFloat(major) || 0) * 10 ** currencyDecimals(currency));

export function GoalForm({ goal, defaultCurrency = "USD" }: { goal?: GoalRow; defaultCurrency?: string }) {
  const editing = !!goal;
  const currency = goal?.currency ?? defaultCurrency;
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({
    name: goal?.name ?? "",
    term: goal?.term ?? ("long" as "short" | "long"),
    amount: goal ? toMajor(goal.targetAmountMinor, currency) : "",
    targetDate: goal?.targetDate ?? "",
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const targetAmountMinor = toMinor(f.amount, currency);
    if (editing) {
      goalsCollection.update(goal!.id, (draft) => {
        draft.name = f.name;
        draft.term = f.term;
        draft.targetAmountMinor = targetAmountMinor;
        draft.targetDate = f.targetDate;
      });
    } else {
      goalsCollection.insert({
        id: newId(),
        name: f.name,
        term: f.term,
        targetAmountMinor,
        currency,
        targetDate: f.targetDate,
        ownerScope: "household",
        anchorDate: null,
        sortOrder: 0,
        createdAt: Math.floor(Date.now() / 1000),
        createdBy: "",
      });
    }
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant={editing ? "outline" : "default"} size="sm" />}>
        {editing ? "Edit" : "New goal"}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>{editing ? "Edit goal" : "New goal"}</DialogTitle></DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <Label>Name</Label>
            <Input value={f.name} required onChange={(e) => setF((p) => ({ ...p, name: e.target.value }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Term</Label>
              <Select value={f.term}
                onValueChange={(v: string | null) => v && setF((p) => ({ ...p, term: v as "short" | "long" }))}>
                <SelectTrigger className="w-full">
                  <SelectValue>{(v: unknown) => (String(v) === "short" ? "Short term" : "Long term")}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="short">Short term</SelectItem>
                  <SelectItem value="long">Long term</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Target ({currency})</Label>
              <Input type="number" step="any" value={f.amount} required
                onChange={(e) => setF((p) => ({ ...p, amount: e.target.value }))} />
            </div>
          </div>
          <div>
            <Label>Target date</Label>
            <Input type="date" value={f.targetDate} required
              onChange={(e) => setF((p) => ({ ...p, targetDate: e.target.value }))} />
          </div>
          <DialogFooter><Button type="submit">{editing ? "Save" : "Create"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

> `createdBy` is set server-side from the session; the optimistic row just needs a defined value (empty string) until the refetch replaces it. This matches how the accounts collection lets the server fill `createdAt`/`createdBy`. Confirm the `DialogTrigger render={...}` prop shape matches the repo's shadcn dialog (slice 1's `account-assumptions-dialog.tsx` uses the same pattern).

- [ ] **Step 2: Type-check**

Run: `cd apps/web && bunx tsc -b`
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/goal-form.tsx
git commit -m "feat(web): goal create/edit dialog"
```

---

## Task 10: Web — /goals page (list, progress, required, on-track, unallocated)

**Files:**
- Create: `apps/web/src/routes/goals.tsx`
- Modify: `apps/web/src/router.tsx`, `apps/web/src/routes/dashboard.tsx`

- [ ] **Step 1: Add the shadcn progress component**

Run: `cd apps/web && bunx shadcn@latest add progress`
Expected: creates `apps/web/src/components/ui/progress.tsx`.

- [ ] **Step 2: Build the page**

Create `apps/web/src/routes/goals.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import { Link } from "@tanstack/react-router";
import { api } from "@/lib/api";
import { goalsCollection } from "@/lib/collections";
import { formatMoney } from "@/components/money";
import { GoalForm } from "@/components/goal-form";
import { AppShell, Eyebrow } from "@/components/app-layout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";

type GoalAnalysis = {
  id: string; name: string; term: "short" | "long"; targetAmountMinor: number;
  targetDate: string; currency: string; allocatedMinor: number; progressPct: number;
  projectedAllocatedMinor: number; gapMinor: number; requiredMonthlyMinor: number;
  onPlanTodayMinor: number; aheadByMinor: number; onTrack: boolean;
};
type AnalysisResponse = {
  baseCurrency: string; contributionGrowthRateBps: number; unallocatedMinor: number;
  goals: GoalAnalysis[]; overall: { onTrack: boolean; behindCount: number };
};

async function fetchAnalysis(): Promise<AnalysisResponse> {
  const { data, error } = await api.goals.analysis.get();
  if (error) throw new Error(String(error));
  return data as unknown as AnalysisResponse;
}

const TERMS = [
  { key: "short", label: "Short term" },
  { key: "long", label: "Long term" },
] as const;

export function GoalsPage() {
  // Live goal rows drive create/edit/delete; the analysis query provides the math.
  const { data: rows = [] } = useLiveQuery(goalsCollection);
  const analysisQ = useQuery({ queryKey: ["goals", "analysis", rows.length], queryFn: fetchAnalysis });
  const base = analysisQ.data?.baseCurrency ?? "";
  const byId = new Map((analysisQ.data?.goals ?? []).map((g) => [g.id, g]));

  return (
    <AppShell
      actions={
        <>
          <GoalForm defaultCurrency={base || undefined} />
          <Link to="/">
            <Button variant="ghost" size="sm">← Back</Button>
          </Link>
        </>
      }
    >
      <div className="mb-6 flex items-baseline justify-between">
        <h1 className="font-heading text-3xl tracking-tight">Goals</h1>
        {analysisQ.data && (
          <span className="text-sm text-muted-foreground">
            Unallocated:{" "}
            <span className="font-medium tabular-nums text-foreground">
              {formatMoney(analysisQ.data.unallocatedMinor, base)}
            </span>
          </span>
        )}
      </div>

      <div className="space-y-8">
        {TERMS.map(({ key, label }) => {
          const termRows = rows.filter((g) => g.term === key);
          return (
            <section key={key}>
              <Eyebrow className="mb-3">{label}</Eyebrow>
              {termRows.length === 0 ? (
                <p className="text-sm text-muted-foreground">None yet.</p>
              ) : (
                <div className="space-y-3">
                  {termRows.map((g) => {
                    const a = byId.get(g.id);
                    return (
                      <div key={g.id} className="rounded-2xl border border-border bg-card p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate font-medium">{g.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {formatMoney(g.targetAmountMinor, g.currency)} by {g.targetDate}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            {a && (
                              <Badge variant={a.onTrack ? "default" : "destructive"}>
                                {a.onTrack ? "On track" : "Behind"}
                              </Badge>
                            )}
                            <GoalForm goal={g} defaultCurrency={base || undefined} />
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="text-muted-foreground hover:text-destructive"
                              onClick={() => goalsCollection.delete(g.id)}
                            >
                              ✕
                            </Button>
                          </div>
                        </div>

                        {a && (
                          <div className="mt-3 space-y-2">
                            <Progress value={a.progressPct} />
                            <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
                              <span>
                                {formatMoney(a.allocatedMinor, base)} allocated · {a.progressPct}%
                              </span>
                              <span>
                                {a.requiredMonthlyMinor > 0
                                  ? `${formatMoney(a.requiredMonthlyMinor, base)}/mo to fund`
                                  : "Fully funded"}
                              </span>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </AppShell>
  );
}
```

> The analysis query key includes `rows.length` so creating/deleting a goal refetches the math. (A finer dependency — a content hash of the rows — is unnecessary here; allocation also changes when account balances change, which the user triggers elsewhere and can refresh.)

- [ ] **Step 3: Register the route**

In `apps/web/src/router.tsx`:

Add the import (after `ProjectionsPage`):

```ts
import { GoalsPage } from "./routes/goals";
```

Add the route definition (after `projectionsRoute`):

```ts
const goalsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/goals",
  component: GoalsPage,
  beforeLoad: requireInitializedAndAuthed,
});
```

Add `goalsRoute` to the `rootRoute.addChildren([...])` array.

- [ ] **Step 4: Link from the dashboard**

In `apps/web/src/routes/dashboard.tsx`, add a Goals link next to the Projections link in the actions area:

```tsx
<Link to="/goals" className="text-sm font-medium text-primary hover:underline">
  Goals →
</Link>
```

(Place it just before the existing `<Link to="/projections" ...>`.)

- [ ] **Step 5: Verify build**

Run: `cd apps/web && bunx tsc -b`
Expected: no type errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/routes/goals.tsx apps/web/src/router.tsx apps/web/src/routes/dashboard.tsx apps/web/src/components/ui/progress.tsx
git commit -m "feat(web): /goals page — grouped goals, progress, required contribution, on-track"
```

---

## Task 11: Web — projection-assumption settings (contribution return + end age)

**Files:**
- Modify: `apps/web/src/routes/settings.tsx`

- [ ] **Step 1: Add an assumptions section to settings**

In `apps/web/src/routes/settings.tsx`, add a self-contained component that reads `GET /settings` and patches it. Add it alongside `MembersSection` and render it within the settings layout (e.g. just after `<MembersSection />`).

Add this component to the file:

```tsx
function ProjectionAssumptionsSection() {
  const qc = useQueryClient();
  const settingsQ = useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const { data, error } = await api.settings.get();
      if (error) throw new Error(String(error));
      return data as unknown as {
        baseCurrency: string; contributionGrowthRateBps: number; projectionEndAge: number;
      };
    },
  });

  async function patch(body: { contributionGrowthRateBps?: number; projectionEndAge?: number }) {
    await api.settings.patch(body);
    await qc.invalidateQueries({ queryKey: ["settings"] });
    await qc.invalidateQueries({ queryKey: ["goals", "analysis"] });
  }

  const s = settingsQ.data;
  return (
    <Section
      eyebrow="Projections"
      title="Assumptions"
      description="The annual return used to solve required goal contributions, and how far the projection curve runs."
    >
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label>Contribution return %</Label>
          <Input
            type="number"
            step="any"
            className="w-32"
            defaultValue={s ? s.contributionGrowthRateBps / 100 : ""}
            onBlur={(e) => {
              const v = Math.round((parseFloat(e.target.value) || 0) * 100);
              if (s && v !== s.contributionGrowthRateBps) patch({ contributionGrowthRateBps: v });
            }}
          />
        </div>
        <div>
          <Label>Project until age</Label>
          <Input
            type="number"
            min={1}
            className="w-32"
            defaultValue={s?.projectionEndAge ?? ""}
            onBlur={(e) => {
              const v = Math.max(1, parseInt(e.target.value, 10) || 90);
              if (s && v !== s.projectionEndAge) patch({ projectionEndAge: v });
            }}
          />
        </div>
      </div>
    </Section>
  );
}
```

`useQuery`, `useQueryClient`, and `api` are already imported in this file (see the existing `usersQ`); reuse them.

Render `<ProjectionAssumptionsSection />` in the settings page (after `<MembersSection />`).

- [ ] **Step 2: Verify build + manual check**

Run: `cd apps/web && bunx tsc -b`
Expected: no type errors.

Manual: open Settings → set "Contribution return" to 6% and "Project until age" to 85, blur each, reload — values persist. Open `/goals` — required-contribution figures change with the new return.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/settings.tsx
git commit -m "feat(web): edit projection assumptions (contribution return, end age) in settings"
```

---

## Task 12: Full verification + finish the branch

- [ ] **Step 1: Run the full shared + API test suites**

Run: `cd packages/shared && bun test` then `cd apps/api && bun test`
Expected: all green (shared goals + projection + money; API including the new goals/settings/analysis tests).

- [ ] **Step 2: Type-check the web app**

Run: `cd apps/web && bunx tsc -b`
Expected: no errors.

- [ ] **Step 3: End-to-end manual smoke**

Start API + web (`bun run dev` in `apps/api` and `apps/web`). With member birth years and a few accounts already set up (cash, CPF age 55, SRS age 62 penalty 5%, property illiquid):
1. Open `/goals`, create a short-term goal (target date ~3 years out) and a long-term goal (target date past age 55).
2. Confirm the short goal draws only from currently-liquid accounts; the long goal also picks up CPF.
3. Confirm progress bars, "$X/mo to fund" (or "Fully funded"), and the on-track/behind badge render.
4. Confirm the "Unallocated" figure at the top equals total accessible net worth minus what's allocated.
5. In Settings, lower "Contribution return %" and confirm required-contribution figures rise on `/goals`.

- [ ] **Step 4: Use the finishing-a-development-branch skill**

Invoke `superpowers:finishing-a-development-branch` to decide how to integrate the slice-2 work (merge to `main`, matching the existing slice-merge history).

---

## Self-review notes (coverage vs spec)

- **§3.3 goals table** → Task 4 (schema), Task 6 (CRUD). All columns present: `name`, `term`, `targetAmountMinor`, `currency`, `targetDate`, `ownerScope`, `anchorDate`, `sortOrder`, `createdAt`, `createdBy`.
- **§3.4 settings assumptions** (`contributionGrowthRateBps` default 800, `projectionEndAge` default 90) → Task 4 (columns), Task 5 (route), Task 11 (UI). Note: per the locked decision, `contributionGrowthRateBps` functions as the contribution **return** rate in the annuity solve, not a contribution-escalation rate.
- **§5.1 eligibility** (age at targetDate, penalty haircut, illiquid/liquidationAge, ownerScope) → Task 2 (`allocateGoals` via `accessibleValueMinor` + `ownerScopeAllows`), tested.
- **§5.2 allocation, no double-counting** → Task 2 (raw remaining pool, soonest-first, most-liquid-first, unallocated remainder), tested incl. shared-pool decrement and penalty raw-consume.
- **§5.3 required monthly contribution** → Task 1 (`requiredMonthlyContributionMinor`, level pmt @ return rate) + Task 7 (projectedAllocated at per-account growth rates → gap → solve), tested (`gap ≤ 0 → 0`; positive gap → positive pmt; annuity round-trip).
- **§5.4 on-track / behind** → Task 3 (`goalOnTrack`, per-goal anchored glide path) + Task 7 (allocated-at-anchor via `netWorth({asOf: anchor})` re-allocation; overall household rollup), tested with hand-computable zero-rate fixtures.
- **§6 UI** → Task 9 (goal form), Task 10 (`/goals` page: grouped by term, progress bar, required contribution, on-track badge, unallocated summary, dashboard link), Task 11 (assumptions in settings). All new components via shadcn CLI (`progress`).
- **§7 testing** → engine fully unit-tested (Tasks 1–3); API analysis integration-tested against the DB (Task 7); web verified via `tsc` + manual smoke, matching the repo's test surface (no existing web component tests).

- **Deviations from spec, intentional for slice-2 scope:**
  - `contributionGrowthRateBps` is the contribution **return** rate (level payments), per the confirmed decision — the spec's prose ("rate at which assumed future contributions grow") is honoured as the rate the contribution stream compounds at, not an escalation of the payment amount.
  - **Goal markers on the projection curve** (spec §6 "Goal targets may also render as markers on the curve") are **not** built in this slice — the headline goals experience is the `/goals` page. This is a small, isolated follow-up (add `ReferenceLine`s at each goal's target year/amount in `projection-chart.tsx`) and is noted here rather than built to keep the slice focused.
  - Required-contribution uses **whole years** for projecting existing balances (matching the annual curve) and **whole months** for the annuity — a deliberate simplification consistent with slice 1's whole-year compounding.
