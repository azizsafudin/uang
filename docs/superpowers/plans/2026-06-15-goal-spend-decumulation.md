# Goal Spend / Decumulation + Waterfall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a goal *spend* money at/after its target date (one-time lump, recurring flat amount, or a % withdrawal rate) and let a finished goal's freed contribution + surplus cascade to the next-priority goal, by replacing the per-goal closed-form projection with a single month-by-month multi-goal cashflow simulation.

**Architecture:** A new pure `simulateGoals` in `packages/shared` runs the whole goal set forward month-by-month (grow → contribute → cascade → reach → spend) over BigInt minor units with banker's rounding. The server (`apps/api/src/lib/goals.ts`) keeps `allocateGoals` for today's starting balances, then reads reach month / balances / income off the simulation instead of the old closed-form. Three new nullable-ish `goals` columns carry the spend config. The web form gains a Spend section; the detail view shows an income/spend row and the projected line naturally declines after the target date.

**Tech Stack:** Bun, TypeScript, Drizzle (libsql/SQLite), Elysia + Eden treaty, React + TanStack Router/Query/DB, Recharts, shadcn UI.

---

## File Structure

**Created:**
- `apps/api/drizzle/0005_*.sql` — generated migration adding `spend_type`, `spend_amount_minor`, `spend_rate_bps` to `goals`.

**Modified:**
- `apps/api/src/db/schema.ts` — add the three spend columns to the `goals` table (with a typed `enum` for `spend_type`).
- `packages/shared/src/goals.ts` — add `SpendType`, `SimGoal`, `SimGoalResult`, `SimResult` types and the `simulateGoals` function.
- `packages/shared/src/goals.test.ts` — engine tests (parity, cascade, spends).
- `apps/api/src/lib/goals.ts` — rewire `analyzeGoals` + `goalProjection` onto `simulateGoals`; add `spendType` + `annualIncomeMinor` to both outputs; series shows drawdown.
- `apps/api/src/lib/goals.test.ts` — server tests for drawdown series + income figures (existing tests must still pass).
- `apps/api/src/routes/goals.ts` — accept spend fields on POST/PATCH; reject spend-without-target-date with 422.
- `apps/api/src/routes/goals.test.ts` — route tests for spend fields + 422.
- `apps/web/src/lib/collections.ts` — pass the three new fields through `onInsert`/`onUpdate`.
- `apps/web/src/components/goal-form.tsx` — Spend section (select + conditional amount/rate fields) and client-side spend-requires-date guard.
- `apps/web/src/routes/goal-detail.tsx` — extend the projection response type; add an Income/Spends stat row.
- `apps/web/src/routes/goals.tsx` — extend the analysis type; show a small spend hint on the card.

**Conventions to honor:** Never use `as any` (CLAUDE.md). Money is integer minor units; in `shared` use BigInt + `roundDiv` (banker's rounding). The one tolerated `any` is the Elysia route-handler context destructuring (`async ({ body, set }: any) => …`) — follow the existing pattern, add no new `any`.

---

## Task 1: Schema + migration for spend columns

**Files:**
- Modify: `apps/api/src/db/schema.ts:113-126`
- Create: `apps/api/drizzle/0005_*.sql` (generated)

- [ ] **Step 1: Add the three columns to the `goals` table**

In `apps/api/src/db/schema.ts`, replace the `goals` table definition (lines 113-126) with:

```typescript
// Financial goals. Ordered/allocated by soonest targetDate then smallest amount;
// eligibility derives from targetDate. ownerScope is 'household' or a userId.
// anchorDate is the optional on-track baseline (null => anchor at createdAt).
// spend* model decumulation at/after targetDate (see lib/goals simulateGoals).
export const goals = sqliteTable("goals", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  targetAmountMinor: integer("target_amount_minor").notNull(),
  currency: text("currency").notNull(),
  targetDate: text("target_date"), // YYYY-MM-DD | null (null = indefinite, amount-only goal)
  ownerScope: text("owner_scope").notNull().default("household"),
  anchorDate: text("anchor_date"), // YYYY-MM-DD | null
  // Assumed planned saving toward this goal (base of the projected line).
  monthlyContributionMinor: integer("monthly_contribution_minor").notNull().default(0),
  // How this goal spends at/after targetDate. 'none' = pure accumulation.
  spendType: text("spend_type", { enum: ["none", "once", "monthly", "percent"] })
    .notNull()
    .default("none"),
  spendAmountMinor: integer("spend_amount_minor"), // 'once' lump / 'monthly' flat $; null otherwise
  spendRateBps: integer("spend_rate_bps"), // 'percent' annual % of balance (400 = 4%/yr); null otherwise
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  createdBy: text("created_by").notNull(),
});
```

- [ ] **Step 2: Generate the migration**

Run: `bun run db:generate`
Expected: a new file `apps/api/drizzle/0005_<name>.sql` is created containing three `ALTER TABLE goals ADD COLUMN ...` statements (`spend_type` text not null default 'none', `spend_amount_minor` integer, `spend_rate_bps` integer), and `_journal.json` gains an `idx: 5` entry.

- [ ] **Step 3: Verify the generated SQL**

Run: `cat apps/api/drizzle/0005_*.sql`
Expected: contains `ADD \`spend_type\``, `ADD \`spend_amount_minor\``, `ADD \`spend_rate_bps\``. If `db:generate` prompted interactively or produced unrelated changes, stop and re-inspect the schema diff.

- [ ] **Step 4: Confirm migrations apply cleanly (tests run migrations on reset)**

Run: `bun test apps/api/src/routes/goals.test.ts`
Expected: PASS (existing route tests still green — `resetDb` calls `runMigrations()`, proving the new migration applies).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle
git commit -m "feat(goals): add spend_type/spend_amount_minor/spend_rate_bps columns"
```

---

## Task 2: `simulateGoals` — accumulation core (grow + contribute + reach)

**Files:**
- Modify: `packages/shared/src/goals.ts` (append new types + function after `monthsToReachMinor`, before the `import { accessibleValueMinor }` line is fine — but keep all `export`s; append at end of file)
- Test: `packages/shared/src/goals.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/goals.test.ts`. First update the import at the top of the file (line 2-6) to add the new symbols:

```typescript
import {
  annuityFutureValueMinor,
  requiredMonthlyContributionMinor,
  compoundMonthlyMinor,
  monthsToReachMinor,
  simulateGoals,
  type SimGoal,
} from "./goals";
```

Then append these tests at the end of the file:

```typescript
// --- simulateGoals: month-by-month multi-goal cashflow ---

// Convenience builder so tests only specify what they exercise.
function simGoal(over: Partial<SimGoal> & { id: string }): SimGoal {
  return {
    startBalanceMinor: 0,
    targetMinor: 0,
    targetMonth: null,
    monthlyContributionMinor: 0,
    spendType: "none",
    spendAmountMinor: null,
    spendRateBps: null,
    ...over,
  };
}

test("simulateGoals: single-goal accumulation matches monthsToReachMinor (regression guard)", () => {
  const start = 1_000_000, contrib = 50_000, target = 5_000_000, rate = 800, horizon = 1200;
  const { goals } = simulateGoals({
    goals: [simGoal({ id: "a", startBalanceMinor: start, targetMinor: target, monthlyContributionMinor: contrib })],
    planRateBps: rate,
    horizonMonths: horizon,
  });
  const reach = monthsToReachMinor(start, contrib, target, rate, horizon);
  expect(goals[0].reachMonth).toBe(reach);
  expect(goals[0].balances.length).toBe(horizon + 1);
  expect(goals[0].balances[0]).toBe(start);
});

test("simulateGoals: zero-rate accumulation is start + n*contribution", () => {
  const { goals } = simulateGoals({
    goals: [simGoal({ id: "a", startBalanceMinor: 100, targetMinor: 10_000, monthlyContributionMinor: 10 })],
    planRateBps: 0,
    horizonMonths: 5,
  });
  expect(goals[0].balances).toEqual([100, 110, 120, 130, 140, 150]);
});

test("simulateGoals: a goal already at target reports reachMonth 0", () => {
  const { goals } = simulateGoals({
    goals: [simGoal({ id: "a", startBalanceMinor: 3_000_000, targetMinor: 3_000_000 })],
    planRateBps: 800,
    horizonMonths: 12,
  });
  expect(goals[0].reachMonth).toBe(0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/shared/src/goals.test.ts`
Expected: FAIL — `simulateGoals` is not exported / not a function.

- [ ] **Step 3: Implement the types and accumulation core**

Append to the end of `packages/shared/src/goals.ts`:

```typescript
// ---------------------------------------------------------------------------
// simulateGoals — month-by-month multi-goal cashflow simulation
// ---------------------------------------------------------------------------

export type SpendType = "none" | "once" | "monthly" | "percent";

// One goal's inputs to the simulation. startBalanceMinor is today's allocation
// (from allocateGoals); targetMonth is whole months from the sim start to the
// goal's targetDate (null = indefinite, no deadline).
export type SimGoal = {
  id: string;
  startBalanceMinor: number;
  targetMinor: number;
  targetMonth: number | null;
  monthlyContributionMinor: number;
  spendType: SpendType;
  spendAmountMinor: number | null; // 'once' lump / 'monthly' flat
  spendRateBps: number | null;     // 'percent' annual % of current balance
};

export type SimGoalResult = {
  id: string;
  startBalanceMinor: number;
  reachMonth: number | null;  // first month (1..horizon) balance >= target; 0 if already there; null if never
  balances: number[];         // length horizonMonths + 1; balances[0] = startBalanceMinor
};

export type SimResult = { goals: SimGoalResult[] };

// Pure month-by-month simulation of the whole goal set. Each month every goal's
// balance grows at the plan rate, then active (not-yet-reached) goals add their
// own contribution and the soonest active goal also receives the freed-contribution
// stream; goals that reach their target are capped and cascade their surplus, and
// spend goals draw down from their targetMonth onward (Task 4). Money is base
// minor units, BigInt, banker's-rounded. The caller supplies starting balances
// and horizon (no Date.now here).
export function simulateGoals(params: {
  goals: SimGoal[];
  planRateBps: number;
  horizonMonths: number;
}): SimResult {
  const { goals, planRateBps, horizonMonths } = params;
  assertMonths(horizonMonths);

  // Priority: soonest targetMonth (indefinite last), then smallest target, then id.
  const order = [...goals].sort((a, b) => {
    const am = a.targetMonth ?? Number.POSITIVE_INFINITY;
    const bm = b.targetMonth ?? Number.POSITIVE_INFINITY;
    if (am !== bm) return am - bm;
    if (a.targetMinor !== b.targetMinor) return a.targetMinor - b.targetMinor;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const n = order.length;

  const iScaled = monthlyRateScaled(planRateBps);
  const factor = SCALE + iScaled;

  const bal = order.map((g) => toBig(g.startBalanceMinor));
  const targetBig = order.map((g) => toBig(g.targetMinor));
  const contribBig = order.map((g) => toBig(g.monthlyContributionMinor));
  const reached = order.map(() => false);
  const finishedOnce = order.map(() => false); // 'once'-spent: emptied, no longer grows
  const reachMonth = order.map<number | null>(() => null);
  const series = order.map((g) => [g.startBalanceMinor]);

  // A goal already at/above target today is reached at month 0; its contribution
  // joins the freed stream immediately. (Not capped at init so today's actual ==
  // today's projected; any pre-existing overshoot simply stays with the goal.)
  for (let i = 0; i < n; i++) {
    if (bal[i] >= targetBig[i]) { reached[i] = true; reachMonth[i] = 0; }
  }

  // Sum of reached goals' contributions, redirected each month to the soonest
  // still-active goal (the "freed pool" as a recurring stream).
  let freedMonthly = 0n;
  for (let i = 0; i < n; i++) if (reached[i]) freedMonthly += contribBig[i];

  const soonestActive = (): number => {
    for (let i = 0; i < n; i++) if (!reached[i]) return i;
    return -1;
  };

  for (let m = 1; m <= horizonMonths; m++) {
    // 1. Grow every (still-held) balance at the plan rate.
    for (let i = 0; i < n; i++) {
      if (finishedOnce[i]) continue;
      bal[i] = roundDiv(bal[i] * factor, SCALE);
    }

    // 2. Contribute: active goals add their own contribution; the freed stream
    //    tops up the soonest active goal on top of its own.
    for (let i = 0; i < n; i++) if (!reached[i]) bal[i] += contribBig[i];
    const sa = soonestActive();
    if (sa !== -1 && freedMonthly > 0n) bal[sa] += freedMonthly;

    // 3. Reach: cap at target, cascade surplus to the soonest active goal, and
    //    free this goal's contribution from next month on.
    for (let i = 0; i < n; i++) {
      if (reached[i] || finishedOnce[i]) continue;
      if (bal[i] >= targetBig[i]) {
        reached[i] = true;
        reachMonth[i] = m;
        const surplus = bal[i] - targetBig[i];
        bal[i] = targetBig[i];
        freedMonthly += contribBig[i];
        if (surplus > 0n) {
          const j = soonestActive();
          if (j !== -1) bal[j] += surplus;
        }
      }
    }

    // 4. Spend — added in Task 4.

    for (let i = 0; i < n; i++) series[i].push(fromBig(bal[i]));
  }

  const byId = new Map(
    order.map((g, i) => [g.id, { id: g.id, startBalanceMinor: g.startBalanceMinor, reachMonth: reachMonth[i], balances: series[i] }] as const),
  );
  return { goals: goals.map((g) => byId.get(g.id)!) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/shared/src/goals.test.ts`
Expected: PASS (all existing shared goal tests + the three new ones).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/goals.ts packages/shared/src/goals.test.ts
git commit -m "feat(shared): simulateGoals accumulation core (grow/contribute/reach)"
```

---

## Task 3: `simulateGoals` — waterfall cascade

The cascade machinery (freed-contribution stream + surplus) is already implemented in Task 2's loop. This task adds a test proving it measurably accelerates the next goal.

**Files:**
- Test: `packages/shared/src/goals.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/src/goals.test.ts`:

```typescript
test("simulateGoals: a finished goal's freed contribution + surplus accelerate the next goal", () => {
  const planRateBps = 0; // isolate the cascade from growth

  // Goal A overshoots its 1,000,000 target at month 1 (contributes 1,100,000):
  // it frees its contribution AND cascades the 100,000 surplus to B.
  const A = simGoal({ id: "a", startBalanceMinor: 0, targetMinor: 1_000_000, targetMonth: 1, monthlyContributionMinor: 1_100_000 });
  // Goal B: large + later, contributes 100,000/mo.
  const B = simGoal({ id: "b", startBalanceMinor: 0, targetMinor: 10_000_000, targetMonth: 240, monthlyContributionMinor: 100_000 });

  const bWith = simulateGoals({ goals: [A, B], planRateBps, horizonMonths: 1200 })
    .goals.find((g) => g.id === "b")!.reachMonth!;
  const bAlone = simulateGoals({ goals: [B], planRateBps, horizonMonths: 1200 })
    .goals[0].reachMonth!;

  // B alone: 10,000,000 / 100,000 = 100 months.
  expect(bAlone).toBe(100);
  // With A's freed 1,100,000/mo + 100,000 surplus, B reaches far sooner.
  expect(bWith).toBeLessThan(bAlone);
  expect(bWith).toBeLessThanOrEqual(11);
});
```

- [ ] **Step 2: Run the test**

Run: `bun test packages/shared/src/goals.test.ts`
Expected: PASS (cascade already implemented in Task 2). If `bWith` is not less than `bAlone`, the freed-stream/surplus wiring is wrong — fix `simulateGoals`, do not weaken the test.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/goals.test.ts
git commit -m "test(shared): cascade accelerates the next goal's reach month"
```

---

## Task 4: `simulateGoals` — spend (once / monthly / percent)

**Files:**
- Modify: `packages/shared/src/goals.ts` (the `// 4. Spend — added in Task 4.` placeholder inside `simulateGoals`)
- Test: `packages/shared/src/goals.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/goals.test.ts`:

```typescript
test("simulateGoals: one-time spend removes the lump at targetMonth and cascades the remainder", () => {
  // A holds its 1,000,000 target, spends 600,000 once at month 1; the 400,000
  // leftover cascades to B (which is far from its target, so stays active).
  const A = simGoal({ id: "a", startBalanceMinor: 1_000_000, targetMinor: 1_000_000, targetMonth: 1, spendType: "once", spendAmountMinor: 600_000 });
  const B = simGoal({ id: "b", startBalanceMinor: 0, targetMinor: 100_000_000, targetMonth: 360 });
  const { goals } = simulateGoals({ goals: [A, B], planRateBps: 0, horizonMonths: 3 });
  const a = goals.find((g) => g.id === "a")!;
  const b = goals.find((g) => g.id === "b")!;
  expect(a.balances[1]).toBe(0);        // emptied after the once-spend
  expect(a.balances[2]).toBe(0);        // stays empty
  expect(b.balances[1]).toBe(400_000);  // leftover cascaded to B
});

test("simulateGoals: monthly spend depletes the balance each month from targetMonth", () => {
  const A = simGoal({ id: "a", startBalanceMinor: 1_000_000, targetMinor: 1_000_000, targetMonth: 0, spendType: "monthly", spendAmountMinor: 100_000 });
  const { goals } = simulateGoals({ goals: [A], planRateBps: 0, horizonMonths: 3 });
  expect(goals[0].balances).toEqual([1_000_000, 900_000, 800_000, 700_000]);
});

test("simulateGoals: percent spend withdraws a share of current balance and never fully depletes", () => {
  const A = simGoal({ id: "a", startBalanceMinor: 10_000_000, targetMinor: 10_000_000, targetMonth: 0, spendType: "percent", spendRateBps: 400 });
  const { goals } = simulateGoals({ goals: [A], planRateBps: 0, horizonMonths: 36 });
  const b = goals[0].balances;
  // Withdrawals at the 12-month marks from targetMonth (12, 24, 36); 4% of current.
  expect(b[12]).toBe(10_000_000 - 400_000);   // 4% of 10,000,000
  expect(b[24]).toBe(9_600_000 - 384_000);    // 4% of 9,600,000
  expect(b[b.length - 1]).toBeGreaterThan(0); // self-adjusting; never zero
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/shared/src/goals.test.ts`
Expected: FAIL — spend is a no-op placeholder, so balances never decrease.

- [ ] **Step 3: Implement the spend step**

In `packages/shared/src/goals.ts`, replace the placeholder line inside `simulateGoals`:

```typescript
    // 4. Spend — added in Task 4.
```

with:

```typescript
    // 4. Spend at/after each goal's targetMonth. Consumed money leaves the sim;
    //    the pot keeps growing at the plan rate underneath.
    for (let i = 0; i < n; i++) {
      const g = order[i];
      const tm = g.targetMonth;
      if (tm === null || m < tm || finishedOnce[i]) continue;
      if (g.spendType === "once" && m === tm) {
        const amt = toBig(g.spendAmountMinor ?? 0);
        const spent = amt > bal[i] ? bal[i] : amt;
        bal[i] -= spent;
        const leftover = bal[i];
        bal[i] = 0n;
        finishedOnce[i] = true;
        if (!reached[i]) { reached[i] = true; reachMonth[i] = m; freedMonthly += contribBig[i]; }
        if (leftover > 0n) {
          const j = soonestActive();
          if (j !== -1) bal[j] += leftover;
        }
      } else if (g.spendType === "monthly") {
        const amt = toBig(g.spendAmountMinor ?? 0);
        bal[i] = bal[i] > amt ? bal[i] - amt : 0n;
      } else if (g.spendType === "percent" && (m - tm) % 12 === 0) {
        const wd = roundDiv(bal[i] * toBig(g.spendRateBps ?? 0), BPS);
        bal[i] = bal[i] > wd ? bal[i] - wd : 0n;
      }
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/shared/src/goals.test.ts`
Expected: PASS (all shared goal tests).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/goals.ts packages/shared/src/goals.test.ts
git commit -m "feat(shared): simulateGoals spend — once/monthly/percent drawdown"
```

---

## Task 5: Rewire the server onto `simulateGoals`

Replace the closed-form reach/projection in `analyzeGoals` + `goalProjection` with reads off `simulateGoals`, while keeping `allocateGoals` for today's starting balances and the closed-form `requiredMonthlyMinor`. Add `spendType` + `annualIncomeMinor` to both outputs and make the projection series extend into drawdown for spend goals.

**Files:**
- Modify: `apps/api/src/lib/goals.ts`
- Test: `apps/api/src/lib/goals.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/lib/goals.test.ts`:

```typescript
test("goalProjection: a monthly-spend goal draws down after its target date", async () => {
  await initAndLogin({ baseCurrency: "USD" });
  const [owner] = await db.select().from(user);
  await addAccount({ name: "Cash", subtype: "bank", openingMinor: 50_000_000, ownerId: owner.id });

  await db.insert(goals).values({
    id: "draw", name: "Retire", targetAmountMinor: 40_000_000, currency: "USD",
    targetDate: "2030-01-01", ownerScope: "household", anchorDate: null,
    monthlyContributionMinor: 0, spendType: "monthly", spendAmountMinor: 100_000, spendRateBps: null,
    sortOrder: 0, createdAt: nowEpoch(), createdBy: "seed",
  });

  const r = await goalProjection("draw", 2);
  if (!r) throw new Error("expected a projection");

  expect(r.spendType).toBe("monthly");
  // Income figure: flat monthly spend annualised.
  expect(r.annualIncomeMinor).toBe(100_000 * 12);

  // The projected line extends past the target date and ends lower than its value
  // at the target date (drawdown is visible).
  const target = "2030-01";
  const atTarget = r.series.find((p) => p.date.slice(0, 7) === target && p.projected !== null);
  if (!atTarget) throw new Error("expected a point at the target month");
  const last = r.series[r.series.length - 1];
  expect(last.date > "2030-01-01").toBe(true);                 // extends into drawdown
  expect((last.projected ?? 0)).toBeLessThan(atTarget.projected ?? 0); // declines after spending
});

test("analyzeGoals: a percent-spend goal reports an annual income from balance-at-target", async () => {
  await initAndLogin({ baseCurrency: "USD" });
  const [owner] = await db.select().from(user);
  await addAccount({ name: "Cash", subtype: "bank", openingMinor: 100_000_000, ownerId: owner.id });

  await db.insert(goals).values({
    id: "swr", name: "FIRE", targetAmountMinor: 80_000_000, currency: "USD",
    targetDate: "2030-01-01", ownerScope: "household", anchorDate: null,
    monthlyContributionMinor: 0, spendType: "percent", spendAmountMinor: null, spendRateBps: 400,
    sortOrder: 0, createdAt: nowEpoch(), createdBy: "seed",
  });

  const a = (await analyzeGoals()).goals.find((g) => g.id === "swr")!;
  expect(a.spendType).toBe("percent");
  // 4% of the balance reached by the target date.
  expect(a.annualIncomeMinor).not.toBeNull();
  expect(a.annualIncomeMinor!).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test apps/api/src/lib/goals.test.ts`
Expected: FAIL — `spendType`/`annualIncomeMinor` are not on the result types; the columns aren't read.

- [ ] **Step 3: Update imports**

In `apps/api/src/lib/goals.ts`, replace the `@uang/shared` import block (lines 3-8) with:

```typescript
import {
  convertToBase, toBig, fromBig, roundDiv,
  compoundMonthlyMinor, annuityFutureValueMinor,
  allocateGoals, requiredMonthlyContributionMinor, simulateGoals,
  type AllocAccount, type GoalInput, type SimGoal, type SpendType,
} from "@uang/shared";
```

(`monthsToReachMinor` is no longer used directly here; `roundDiv`, `simulateGoals`, `SimGoal`, `SpendType` are now used.)

- [ ] **Step 4: Add `spendType` + `annualIncomeMinor` to the output types**

In `apps/api/src/lib/goals.ts`, in the `GoalAnalysis` type (lines 21-35), add two fields after `reachDate`:

```typescript
  reachDate: string | null;          // YYYY-MM-DD the plan first reaches target (null = not within ~100y)
  spendType: SpendType;              // how this goal spends at/after targetDate
  annualIncomeMinor: number | null;  // derived recurring income (monthly/percent); null otherwise
  sources: GoalSource[];
```

In the `GoalProjectionResult` type (lines 192-205), add the same two fields after `reachDate`:

```typescript
  reachDate: string | null; // YYYY-MM-DD the plan first reaches target (null = not within ~100y)
  spendType: SpendType;
  annualIncomeMinor: number | null;
  sources: GoalSource[];
  series: GoalProjectionPoint[];
```

- [ ] **Step 5: Add shared server helpers (replace `goalPlanMath`)**

In `apps/api/src/lib/goals.ts`, replace the `goalPlanMath` function (lines 61-85) with these three helpers:

```typescript
// Drawdown display window appended after the target date so recurring spends are
// visible on the chart (30 years).
const DRAWDOWN_MONTHS = 360;

// Contribution that would land exactly on target by the deadline (per-goal,
// closed-form — ignores cascade, matching the "what you'd need alone" figure).
function requiredMonthlyMinorFor(
  allocatedMinor: number,
  targetMinor: number,
  planRateBps: number,
  monthsToTarget: number | null,
): number {
  if (monthsToTarget === null) return 0;
  const grown = compoundMonthlyMinor(allocatedMinor, planRateBps, monthsToTarget);
  return requiredMonthlyContributionMinor(targetMinor - grown, planRateBps, monthsToTarget);
}

// Derived recurring income: monthly -> flat * 12; percent -> rate% * balance at
// the target date; once/none -> null.
function annualIncomeMinorFor(
  spendType: SpendType,
  spendAmountMinor: number | null,
  spendRateBps: number | null,
  balanceAtTargetMinor: number | null,
): number | null {
  if (spendType === "monthly") return (spendAmountMinor ?? 0) * 12;
  if (spendType === "percent" && balanceAtTargetMinor !== null) {
    return fromBig(roundDiv(toBig(balanceAtTargetMinor) * toBig(spendRateBps ?? 0), 10_000n));
  }
  return null;
}

// Build the SimGoal list for the whole goal set (allocation is global). Caller
// supplies each goal's starting balance (today's allocation) and base target.
function toSimGoals(
  goalRows: GoalRow[],
  startById: Map<string, number>,
  targetBaseById: Map<string, number>,
  todayISO: string,
): SimGoal[] {
  return goalRows.map((g) => ({
    id: g.id,
    startBalanceMinor: startById.get(g.id) ?? 0,
    targetMinor: targetBaseById.get(g.id) ?? g.targetAmountMinor,
    targetMonth: g.targetDate ? monthsBetween(todayISO, g.targetDate) : null,
    monthlyContributionMinor: g.monthlyContributionMinor,
    spendType: g.spendType,
    spendAmountMinor: g.spendAmountMinor,
    spendRateBps: g.spendRateBps,
  }));
}

// A horizon large enough to cover every target date plus the drawdown window and
// to detect a late reach (mirrors the old ~1200-month search cap).
function simHorizon(goalRows: GoalRow[], todayISO: string): number {
  const targets = goalRows.map((g) => (g.targetDate ? monthsBetween(todayISO, g.targetDate) : 0));
  const maxTarget = targets.length ? Math.max(...targets) : 0;
  return Math.max(maxTarget + DRAWDOWN_MONTHS, 1200);
}
```

- [ ] **Step 6: Rewrite `analyzeGoals` per-goal assembly**

In `apps/api/src/lib/goals.ts`, replace the body of `analyzeGoals` from the `const allocToday = allocateGoals(...)` line through the end of the per-goal `for` loop (lines 143-174) with:

```typescript
  const allocToday = allocateGoals({ goals: goalInputs, accounts: allocAccountsToday });
  const allocById = new Map(allocToday.goals.map((g) => [g.id, g]));
  const startById = new Map(allocToday.goals.map((g) => [g.id, g.allocatedMinor]));

  // One global simulation drives reach/projection/income (cascade is global).
  const horizonMonths = simHorizon(goalRows, todayISO);
  const sim = simulateGoals({
    goals: toSimGoals(goalRows, startById, targetBaseById, todayISO),
    planRateBps,
    horizonMonths,
  });
  const simById = new Map(sim.goals.map((g) => [g.id, g]));

  const analyses: GoalAnalysis[] = [];
  for (const g of goalRows) {
    const targetBase = targetBaseById.get(g.id) ?? g.targetAmountMinor;
    const alloc = allocById.get(g.id)!;
    const sg = simById.get(g.id)!;
    const monthsToTarget = g.targetDate ? monthsBetween(todayISO, g.targetDate) : null;
    const reachMonths = sg.reachMonth;
    const balanceAtTarget = monthsToTarget === null ? null : (sg.balances[monthsToTarget] ?? null);
    const onTrack = monthsToTarget === null
      ? reachMonths !== null
      : reachMonths !== null && reachMonths <= monthsToTarget;

    analyses.push({
      id: g.id, name: g.name, targetAmountMinor: targetBase,
      targetDate: g.targetDate, currency: g.currency,
      allocatedMinor: alloc.allocatedMinor, progressPct: alloc.progressPct,
      monthlyContributionMinor: g.monthlyContributionMinor,
      requiredMonthlyMinor: requiredMonthlyMinorFor(alloc.allocatedMinor, targetBase, planRateBps, monthsToTarget),
      projectedAtTargetMinor: balanceAtTarget,
      onTrack,
      reachDate: reachMonths === null ? null : addMonthsISO(todayISO, reachMonths),
      spendType: g.spendType,
      annualIncomeMinor: annualIncomeMinorFor(g.spendType, g.spendAmountMinor, g.spendRateBps, balanceAtTarget),
      sources: alloc.lines.map((line) => ({
        accountId: line.accountId,
        name: nameById.get(line.accountId) ?? line.accountId,
        allocatedMinor: line.allocatedMinor,
      })),
    });
  }
```

- [ ] **Step 7: Rewrite `goalProjection` from today's allocation onward**

In `apps/api/src/lib/goals.ts`, replace the block from `const contribution = goal.monthlyContributionMinor;` (line 256) through the final `return { ... };` (line 314) with:

```typescript
  const contribution = goal.monthlyContributionMinor;
  const monthsToTarget = goal.targetDate ? monthsBetween(todayISO, goal.targetDate) : null;

  // One global simulation (cascade is global); read this goal's trajectory off it.
  const startById = new Map(allocToday.goals.map((g) => [g.id, g.allocatedMinor]));
  const horizonMonths = simHorizon(goalRows, todayISO);
  const sim = simulateGoals({
    goals: toSimGoals(goalRows, startById, targetBaseById, todayISO),
    planRateBps,
    horizonMonths,
  });
  const sg = sim.goals.find((g) => g.id === goal.id)!;
  const reachMonths = sg.reachMonth;
  const balanceAtTarget = monthsToTarget === null ? null : (sg.balances[monthsToTarget] ?? null);
  const onTrack = monthsToTarget === null
    ? reachMonths !== null
    : reachMonths !== null && reachMonths <= monthsToTarget;

  // Display window: to the target date for accumulate-only dated goals; extended
  // by the drawdown window for spend goals; to the reach month for indefinite goals.
  const displayHorizon =
    goal.spendType !== "none" && monthsToTarget !== null
      ? monthsToTarget + DRAWDOWN_MONTHS
      : monthsToTarget !== null
        ? monthsToTarget
        : (reachMonths ?? 360);

  const series: GoalProjectionPoint[] = [];

  // Past: realized allocation as of each month-end (oldest first).
  for (let k = historyMonths; k >= 1; k--) {
    const date = addMonthsISO(todayISO, -k);
    const nwPast = await netWorth({ asOf: date, owner: "household" });
    const allocPast = allocateGoals({ goals: goalInputs, accounts: toAllocAccounts(nwPast.accounts, birthByUser) });
    const realized = allocPast.goals.find((g) => g.id === goal.id)?.allocatedMinor ?? 0;
    series.push({ date, actual: realized, projected: null });
  }

  // Today: actual meets projected at the current allocation (== sim balances[0]).
  series.push({ date: todayISO, actual: allocatedToday, projected: allocatedToday });

  // Future: step so a far-dated goal stays under ~120 points; always include the
  // display horizon, the reach month, and the target month (the drawdown kink).
  const step = Math.max(1, Math.ceil(displayHorizon / 120));
  const monthsSet = new Set<number>();
  for (let mo = step; mo < displayHorizon; mo += step) monthsSet.add(mo);
  if (displayHorizon > 0) monthsSet.add(displayHorizon);
  if (reachMonths !== null && reachMonths > 0 && reachMonths <= displayHorizon) monthsSet.add(reachMonths);
  if (monthsToTarget !== null && monthsToTarget > 0 && monthsToTarget <= displayHorizon) monthsSet.add(monthsToTarget);
  const futureMonths = [...monthsSet].sort((a, b) => a - b);
  for (const mo of futureMonths) {
    series.push({ date: addMonthsISO(todayISO, mo), actual: null, projected: sg.balances[mo] ?? null });
  }

  return {
    baseCurrency: base,
    goal: { id: goal.id, name: goal.name, targetDate: goal.targetDate, currency: goal.currency },
    targetMinor: targetBase,
    allocatedMinor: allocatedToday,
    progressPct: mine.progressPct,
    monthlyContributionMinor: contribution,
    requiredMonthlyMinor: requiredMonthlyMinorFor(allocatedToday, targetBase, planRateBps, monthsToTarget),
    projectedAtTargetMinor: balanceAtTarget,
    onTrack,
    reachDate: reachMonths === null ? null : addMonthsISO(todayISO, reachMonths),
    spendType: goal.spendType,
    annualIncomeMinor: annualIncomeMinorFor(goal.spendType, goal.spendAmountMinor, goal.spendRateBps, balanceAtTarget),
    sources,
    series,
  };
```

Note: the old `goalProjection` computed `m`/`horizonMonths` via `goalPlanMath`; those are now gone. Ensure no dangling references to `m.` or the removed `horizonMonths`/`compoundMonthlyMinor(...)+annuityFutureValueMinor(...)` future loop remain — the block above replaces all of them.

- [ ] **Step 8: Run the server tests**

Run: `bun test apps/api/src/lib/goals.test.ts`
Expected: PASS — the two new tests plus all four pre-existing tests (`soonest-first`, `sufficient contribution`, `past actual then projected`, `indefinite`).

- [ ] **Step 9: Run the full API + shared suite (catch type/regression breakage)**

Run: `bun test apps/api packages/shared`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/lib/goals.ts apps/api/src/lib/goals.test.ts
git commit -m "feat(api): drive goal analysis/projection from simulateGoals; spend income + drawdown series"
```

---

## Task 6: API routes — accept spend fields, reject spend without target date

**Files:**
- Modify: `apps/api/src/routes/goals.ts`
- Test: `apps/api/src/routes/goals.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/routes/goals.test.ts`:

```typescript
test("POST /goals accepts spend fields and round-trips them", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const id = crypto.randomUUID();
  const create = await app.handle(new Request("http://localhost/goals", {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      id, name: "Retire", targetAmountMinor: 40_000_000, currency: "USD",
      targetDate: "2040-01-01", ownerScope: "household",
      spendType: "monthly", spendAmountMinor: 100_000,
    }),
  }));
  expect(create.status).toBe(200);

  const list = await (await app.handle(new Request("http://localhost/goals", { headers: { cookie } }))).json();
  const g = list.find((x: any) => x.id === id);
  expect(g.spendType).toBe("monthly");
  expect(g.spendAmountMinor).toBe(100_000);
  expect(g.spendRateBps).toBeNull();
});

test("POST /goals rejects a spend goal without a target date (422)", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const res = await app.handle(new Request("http://localhost/goals", {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      id: crypto.randomUUID(), name: "Bad", targetAmountMinor: 1_000_000, currency: "USD",
      targetDate: null, spendType: "once", spendAmountMinor: 500_000,
    }),
  }));
  expect(res.status).toBe(422);
});

test("PATCH /goals rejects enabling spend when the goal has no target date (422)", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const id = crypto.randomUUID();
  await app.handle(new Request("http://localhost/goals", {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ id, name: "Indef", targetAmountMinor: 1_000_000, currency: "USD", targetDate: null }),
  }));
  const res = await app.handle(new Request(`http://localhost/goals/${id}`, {
    method: "PATCH", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ spendType: "monthly", spendAmountMinor: 1_000 }),
  }));
  expect(res.status).toBe(422);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test apps/api/src/routes/goals.test.ts`
Expected: FAIL — spend fields are stripped (not in the body schema) and there is no 422 guard.

- [ ] **Step 3: Update the POST route**

In `apps/api/src/routes/goals.ts`, replace the POST handler (lines 27-66) with:

```typescript
  .post(
    "/",
    async ({ body, userId, set }: any) => {
      const spendType = body.spendType ?? "none";
      const targetDate = body.targetDate ?? null;
      if (spendType !== "none" && !targetDate) {
        set.status = 422;
        return { error: "spend_requires_target_date" };
      }
      const id = body.id ?? createId();
      try {
        await db.insert(goals).values({
          id,
          name: body.name,
          targetAmountMinor: body.targetAmountMinor,
          currency: body.currency.toUpperCase(),
          targetDate,
          ownerScope: body.ownerScope ?? "household",
          anchorDate: body.anchorDate ?? null,
          monthlyContributionMinor: body.monthlyContributionMinor ?? 0,
          spendType,
          spendAmountMinor: body.spendAmountMinor ?? null,
          spendRateBps: body.spendRateBps ?? null,
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
        targetAmountMinor: t.Number(),
        currency: t.String({ pattern: "^[A-Za-z]{3}$" }),
        targetDate: t.Optional(t.Union([t.String(), t.Null()])),
        ownerScope: t.Optional(t.String()),
        anchorDate: t.Optional(t.Union([t.String(), t.Null()])),
        monthlyContributionMinor: t.Optional(t.Number()),
        spendType: t.Optional(t.Union([t.Literal("none"), t.Literal("once"), t.Literal("monthly"), t.Literal("percent")])),
        spendAmountMinor: t.Optional(t.Union([t.Number(), t.Null()])),
        spendRateBps: t.Optional(t.Union([t.Number(), t.Null()])),
        sortOrder: t.Optional(t.Number()),
      }),
    },
  )
```

- [ ] **Step 4: Update the PATCH route**

In `apps/api/src/routes/goals.ts`, replace the PATCH handler (lines 68-95) with:

```typescript
  .patch(
    "/:id",
    async ({ params, body, set }: any) => {
      // Enabling spend requires a target date (existing or in this patch).
      if (body.spendType !== undefined && body.spendType !== "none") {
        const existing = (await db.select().from(goals).where(eq(goals.id, params.id)))[0];
        const effectiveTargetDate = body.targetDate !== undefined ? body.targetDate : existing?.targetDate;
        if (!effectiveTargetDate) {
          set.status = 422;
          return { error: "spend_requires_target_date" };
        }
      }
      const update: Record<string, unknown> = {};
      if (body.name !== undefined) update.name = body.name;
      if (body.targetAmountMinor !== undefined) update.targetAmountMinor = body.targetAmountMinor;
      if (body.currency !== undefined) update.currency = body.currency.toUpperCase();
      if (body.targetDate !== undefined) update.targetDate = body.targetDate;
      if (body.ownerScope !== undefined) update.ownerScope = body.ownerScope;
      if (body.anchorDate !== undefined) update.anchorDate = body.anchorDate;
      if (body.monthlyContributionMinor !== undefined) update.monthlyContributionMinor = body.monthlyContributionMinor;
      if (body.spendType !== undefined) update.spendType = body.spendType;
      if (body.spendAmountMinor !== undefined) update.spendAmountMinor = body.spendAmountMinor;
      if (body.spendRateBps !== undefined) update.spendRateBps = body.spendRateBps;
      if (body.sortOrder !== undefined) update.sortOrder = body.sortOrder;
      await db.update(goals).set(update).where(eq(goals.id, params.id));
      return { ok: true };
    },
    {
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1 })),
        targetAmountMinor: t.Optional(t.Number()),
        currency: t.Optional(t.String({ pattern: "^[A-Za-z]{3}$" })),
        targetDate: t.Optional(t.Union([t.String(), t.Null()])),
        ownerScope: t.Optional(t.String()),
        anchorDate: t.Optional(t.Union([t.String(), t.Null()])),
        monthlyContributionMinor: t.Optional(t.Number()),
        spendType: t.Optional(t.Union([t.Literal("none"), t.Literal("once"), t.Literal("monthly"), t.Literal("percent")])),
        spendAmountMinor: t.Optional(t.Union([t.Number(), t.Null()])),
        spendRateBps: t.Optional(t.Union([t.Number(), t.Null()])),
        sortOrder: t.Optional(t.Number()),
      }),
    },
  )
```

- [ ] **Step 5: Run the route tests**

Run: `bun test apps/api/src/routes/goals.test.ts`
Expected: PASS (the three new tests + the two pre-existing CRUD/projection tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/goals.ts apps/api/src/routes/goals.test.ts
git commit -m "feat(api): goal routes accept spend fields; reject spend without target date (422)"
```

---

## Task 7: Web — pass spend fields through the collection + Spend section in the form

`GoalRow` is `RowOf<typeof api.goals.get>`, so after Task 1 it already includes `spendType`/`spendAmountMinor`/`spendRateBps`. The collection mutations and the form must carry them.

**Files:**
- Modify: `apps/web/src/lib/collections.ts:395-425`
- Modify: `apps/web/src/components/goal-form.tsx`

- [ ] **Step 1: Pass the new fields through `onInsert` and `onUpdate`**

In `apps/web/src/lib/collections.ts`, in the `goalsCollection` `onInsert` payload (the `api.goals.post({...})` object, lines 398-408), add three fields after `monthlyContributionMinor: m.monthlyContributionMinor,`:

```typescript
        monthlyContributionMinor: m.monthlyContributionMinor,
        spendType: m.spendType,
        spendAmountMinor: m.spendAmountMinor,
        spendRateBps: m.spendRateBps,
        sortOrder: m.sortOrder,
```

In the `onUpdate` payload (the `api.goals({ id: m.id }).patch({...})` object, lines 414-423), add the same three fields after `monthlyContributionMinor: m.monthlyContributionMinor,`:

```typescript
        monthlyContributionMinor: m.monthlyContributionMinor,
        spendType: m.spendType,
        spendAmountMinor: m.spendAmountMinor,
        spendRateBps: m.spendRateBps,
        sortOrder: m.sortOrder,
```

- [ ] **Step 2: Add Spend state + a select component to the form**

The repo uses shadcn UI added via the shadcn CLI. Check whether a Select component already exists:

Run: `ls apps/web/src/components/ui/select.tsx`
- If it does NOT exist, add it: `cd apps/web && bunx shadcn@latest add select` (run from the worktree; accept defaults). This is the project convention for UI components — do not hand-write the primitive.

Then in `apps/web/src/components/goal-form.tsx`, replace the whole file with:

```typescript
import { useState } from "react";
import { currencyDecimals } from "@uang/shared";
import { goalsCollection, newId, type GoalRow } from "@/lib/collections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";

// major <-> minor helpers for the amount inputs.
const toMajor = (minor: number, currency: string) => String(minor / 10 ** currencyDecimals(currency));
const toMinor = (major: string, currency: string) =>
  Math.round((parseFloat(major) || 0) * 10 ** currencyDecimals(currency));

type SpendType = "none" | "once" | "monthly" | "percent";

const SPEND_LABELS: Record<SpendType, string> = {
  none: "None (save only)",
  once: "One-time spend",
  monthly: "Monthly income",
  percent: "% of balance / yr",
};

export function GoalForm({
  goal,
  defaultCurrency = "USD",
  open: openProp,
  onOpenChange,
  hideTrigger = false,
}: {
  goal?: GoalRow;
  defaultCurrency?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
}) {
  const editing = !!goal;
  const currency = goal?.currency ?? defaultCurrency;
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = onOpenChange ?? setOpenState;
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({
    name: goal?.name ?? "",
    amount: goal ? toMajor(goal.targetAmountMinor, currency) : "",
    targetDate: goal?.targetDate ?? "",
    contribution: goal ? toMajor(goal.monthlyContributionMinor, currency) : "",
    spendType: (goal?.spendType ?? "none") as SpendType,
    spendAmount: goal?.spendAmountMinor != null ? toMajor(goal.spendAmountMinor, currency) : "",
    spendRate: goal?.spendRateBps != null ? String(goal.spendRateBps / 100) : "", // bps -> percent
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const targetAmountMinor = toMinor(f.amount, currency);
    const monthlyContributionMinor = toMinor(f.contribution, currency);
    const targetDate = f.targetDate || null; // empty -> indefinite goal

    // A spending goal needs a target date (spend starts there).
    if (f.spendType !== "none" && !targetDate) {
      setError("A spending goal needs a target date.");
      return;
    }
    setError(null);

    // Only the relevant spend field is persisted; the other is null.
    const spendAmountMinor =
      f.spendType === "once" || f.spendType === "monthly" ? toMinor(f.spendAmount, currency) : null;
    const spendRateBps =
      f.spendType === "percent" ? Math.round((parseFloat(f.spendRate) || 0) * 100) : null;

    if (editing) {
      goalsCollection.update(goal!.id, (draft) => {
        draft.name = f.name;
        draft.targetAmountMinor = targetAmountMinor;
        draft.targetDate = targetDate;
        draft.monthlyContributionMinor = monthlyContributionMinor;
        draft.spendType = f.spendType;
        draft.spendAmountMinor = spendAmountMinor;
        draft.spendRateBps = spendRateBps;
      });
    } else {
      goalsCollection.insert({
        id: newId(),
        name: f.name,
        targetAmountMinor,
        currency,
        targetDate,
        ownerScope: "household",
        anchorDate: null,
        monthlyContributionMinor,
        spendType: f.spendType,
        spendAmountMinor,
        spendRateBps,
        sortOrder: 0,
        createdAt: Math.floor(Date.now() / 1000),
        createdBy: "",
      });
    }
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {!hideTrigger && (
        <DialogTrigger render={<Button variant={editing ? "outline" : "default"} size="sm" />}>
          {editing ? "Edit" : "New goal"}
        </DialogTrigger>
      )}
      <DialogContent>
        <DialogHeader><DialogTitle>{editing ? "Edit goal" : "New goal"}</DialogTitle></DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <Label>Name</Label>
            <Input value={f.name} required onChange={(e) => setF((p) => ({ ...p, name: e.target.value }))} />
          </div>
          <div>
            <Label>Target ({currency})</Label>
            <Input type="number" step="any" value={f.amount} required
              onChange={(e) => setF((p) => ({ ...p, amount: e.target.value }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Target date <span className="text-muted-foreground">(optional)</span></Label>
              <Input type="date" value={f.targetDate}
                onChange={(e) => setF((p) => ({ ...p, targetDate: e.target.value }))} />
            </div>
            <div>
              <Label>Monthly contribution ({currency})</Label>
              <Input type="number" step="any" min="0" placeholder="0" value={f.contribution}
                onChange={(e) => setF((p) => ({ ...p, contribution: e.target.value }))} />
            </div>
          </div>

          {/* Spend / decumulation: how this goal spends at/after its target date. */}
          <div className="grid grid-cols-2 gap-3 border-t border-border/70 pt-3">
            <div>
              <Label>Spend</Label>
              <Select
                value={f.spendType}
                onValueChange={(v) => setF((p) => ({ ...p, spendType: v as SpendType }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(SPEND_LABELS) as SpendType[]).map((k) => (
                    <SelectItem key={k} value={k}>{SPEND_LABELS[k]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {(f.spendType === "once" || f.spendType === "monthly") && (
              <div>
                <Label>{f.spendType === "once" ? `Lump (${currency})` : `Per month (${currency})`}</Label>
                <Input type="number" step="any" min="0" value={f.spendAmount}
                  onChange={(e) => setF((p) => ({ ...p, spendAmount: e.target.value }))} />
              </div>
            )}
            {f.spendType === "percent" && (
              <div>
                <Label>Withdrawal rate (%/yr)</Label>
                <Input type="number" step="any" min="0" placeholder="4" value={f.spendRate}
                  onChange={(e) => setF((p) => ({ ...p, spendRate: e.target.value }))} />
              </div>
            )}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter><Button type="submit">{editing ? "Save" : "Create"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 3: Typecheck the web app**

Run: `cd apps/web && bun run build`
Expected: type-checks and builds with no errors. (If `tsgo -b` reports an unused import or a missing `select` component, fix per the error — e.g. ensure Step 2's shadcn add ran.)

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/collections.ts apps/web/src/components/goal-form.tsx apps/web/src/components/ui/select.tsx
git commit -m "feat(web): goal form Spend section; pass spend fields through the collection"
```

---

## Task 8: Web — income/spend row on detail + spend hint on the list card

**Files:**
- Modify: `apps/web/src/routes/goal-detail.tsx`
- Modify: `apps/web/src/routes/goals.tsx`

- [ ] **Step 1: Extend the detail projection type + add a Spend/Income row**

In `apps/web/src/routes/goal-detail.tsx`, in the `ProjectionResponse` type (lines 20-33), add two fields after `reachDate`:

```typescript
  reachDate: string | null;
  spendType: "none" | "once" | "monthly" | "percent";
  annualIncomeMinor: number | null;
  sources: Array<{ accountId: string; name: string; allocatedMinor: number }>;
  series: GoalProjectionPoint[];
```

Then, in the "Projected" stats block, add a spend summary row. Replace the closing of the projected `<div className="space-y-1 border-t ...">` section — specifically insert this block immediately after the `{p.goal.targetDate && p.projectedAtTargetMinor !== null && ( ... )}` expression and before that div closes (i.e. after line 147, before `</div>` on line 148):

```typescript
                  {p.spendType !== "none" && (
                    <div className="flex justify-between gap-3">
                      <span className="shrink-0 text-muted-foreground">
                        {p.spendType === "once" ? "Spends" : "Income"}
                      </span>
                      <span>
                        {p.spendType === "once"
                          ? `${formatMoney(p.targetMinor, base)} once${p.goal.targetDate ? ` · ${formatDate(p.goal.targetDate)}` : ""}`
                          : p.annualIncomeMinor !== null
                            ? `≈ ${formatMoney(p.annualIncomeMinor, base)}/yr`
                            : "—"}
                      </span>
                    </div>
                  )}
```

(For `once`, the displayed lump is the goal's configured `spendAmountMinor`; the projection response does not carry it directly, so show the target as the planned outlay context — keep it simple: change `p.targetMinor` to the spend amount only if you also add `spendAmountMinor` to the response. To avoid scope creep, displaying the income figure for recurring spends is the primary requirement; for `once` show the target-date context as above.)

- [ ] **Step 2: Extend the list analysis type + add a spend hint**

In `apps/web/src/routes/goals.tsx`, in the `GoalAnalysis` type (lines 21-27), add two fields after `reachDate`:

```typescript
  projectedAtTargetMinor: number | null; onTrack: boolean; reachDate: string | null;
  spendType: "none" | "once" | "monthly" | "percent"; annualIncomeMinor: number | null;
  sources: Array<{ accountId: string; name: string; allocatedMinor: number }>;
```

Then in `GoalCard`, add a small hint under the target line. Replace the target `<p>` (lines 63-66) with:

```typescript
          <p className="text-xs text-muted-foreground">
            {formatMoney(g.targetAmountMinor, g.currency)}
            {g.targetDate ? ` by ${formatDate(g.targetDate)}` : " · no deadline"}
            {a && a.spendType === "monthly" && a.annualIncomeMinor !== null && ` · income ≈ ${formatMoney(a.annualIncomeMinor, base)}/yr`}
            {a && a.spendType === "percent" && a.annualIncomeMinor !== null && ` · drawdown ≈ ${formatMoney(a.annualIncomeMinor, base)}/yr`}
            {a && a.spendType === "once" && " · one-time spend"}
          </p>
```

- [ ] **Step 3: Typecheck the web app**

Run: `cd apps/web && bun run build`
Expected: type-checks and builds with no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/goal-detail.tsx apps/web/src/routes/goals.tsx
git commit -m "feat(web): show goal income on detail + spend hint on the list card"
```

---

## Task 9: Full verification + finish

**Files:** none (verification only)

- [ ] **Step 1: Run the entire test suite**

Run: `bun test`
Expected: PASS across `packages/shared`, `apps/api` (lib + routes). No failures, no skipped goal tests.

- [ ] **Step 2: Typecheck the web app end-to-end**

Run: `cd apps/web && bun run build`
Expected: PASS (no TypeScript errors).

- [ ] **Step 3: Manual smoke (per spec §8 — no web component tests in repo)**

Run the app (`bun run dev` from the worktree root) and verify by hand:
- Create a goal with a target date, Spend = "Monthly income", per-month amount set → detail page shows an "Income ≈ …/yr" row and the projected line rises to the target date, then **declines** afterward.
- Create a goal with Spend = "% of balance / yr", rate 4 → detail shows an income figure and a stepped drawdown after the target date.
- Create a goal with Spend = "One-time spend" → the projected line drops at the target date.
- Try saving a spend goal with no target date → the form blocks with "A spending goal needs a target date."
- Two goals where the earlier finishes before the later: confirm the later goal's reach date is earlier than it would be alone (cascade) — e.g. compare reach dates before/after adding the early goal.

- [ ] **Step 4: Update the spec status**

In `docs/superpowers/specs/2026-06-15-goal-spend-decumulation-design.md`, change the `**Status:**` line (line 4) to:

```markdown
**Status:** Implemented (see docs/superpowers/plans/2026-06-15-goal-spend-decumulation.md)
```

- [ ] **Step 5: Final commit**

```bash
git add docs/superpowers/specs/2026-06-15-goal-spend-decumulation-design.md
git commit -m "docs: mark goal spend/decumulation design as implemented"
```

- [ ] **Step 6: Finish the branch**

Use the `superpowers:finishing-a-development-branch` skill to decide how to integrate (merge / PR / cleanup).

---

## Self-Review Notes

- **Spec coverage:** §3 columns → Task 1; §4 engine (priority, init, grow/contribute/cascade/reach/spend, horizon, purity) → Tasks 2–4; §5 outputs (series accumulate→drawdown, reachDate/onTrack/allocated/progress/required/income, `spendType` on list) → Task 5; §6 UI (form Spend section, declining chart line via data, income/spend stat row, list hint) → Tasks 7–8; §8 testing (engine parity/spends/cascade, server round-trip + drawdown + income, route 422, web tsc + smoke) → Tasks 2–9.
- **Chart:** No change to `goal-projection-chart.tsx` is needed — it already renders `projected` as a dashed line with `connectNulls={false}`, so a declining post-target series shows the drawdown automatically; the Y-axis domain already keeps the target line in view.
- **`requiredMonthlyMinor`** stays closed-form per-goal (ignores cascade) by design (spec §5 "unchanged shape"), so existing on-track/required assertions keep passing.
- **`as any` rule:** the only `any` introduced is in Elysia route handlers (`async ({ body, set }: any)`), the existing tolerated convention. The `spend_type` column uses Drizzle's typed `enum` so `g.spendType` is already `"none" | "once" | "monthly" | "percent"` — no cast needed when building `SimGoal`.
- **Determinism:** `simulateGoals` takes no clock; the server passes `todayISO`-derived `targetMonth`/`horizonMonths`, preserving the codebase's no-`Date.now()`-in-`shared` discipline.
</content>
</invoke>
