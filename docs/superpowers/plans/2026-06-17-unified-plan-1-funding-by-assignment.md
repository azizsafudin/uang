# Unified Plan — Plan 1: Funding by assignment (backend foundation)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hidden liquidity-based goal funding with explicit account→goal assignment resolved by goal priority, and make "on track" apply only to dated goals — all backend, with the projections page left working.

**Architecture:** Add a `goal_accounts` join table and a `goals.contribution_account_id` column. Change `allocateGoals` in `packages/shared` so a goal is funded only by its assigned accounts, walked in goal-priority order (shared accounts contended highest-priority-first), preserving the existing accessibility/scope rules. Wire `apps/api/src/lib/goals.ts` to read assignments and expose `accountIds` + `contributionAccountId` + a nullable `onTrack`. Add routes to persist assignments. The net-worth projection (`projectNetWorth`) and `/projections` page are untouched in this plan.

**Tech Stack:** Bun, Elysia, Drizzle (libsql/SQLite), `@uang/shared`, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-06-17-unified-plan-goals-projections-design.md`

---

## File structure

- `apps/api/src/db/schema.ts` — add `goalAccounts` table + `goals.contributionAccountId` column.
- `apps/api/drizzle/<generated>.sql` — generated migration.
- `packages/shared/src/goals.ts` — extend `GoalInput`; restrict allocation to assigned accounts; priority ordering.
- `packages/shared/src/goals.test.ts` — update 5 allocation tests; add a shared-account contention test.
- `apps/api/src/lib/goals.ts` — load assignments; add `accountIds`/`contributionAccountId` to analysis; nullable `onTrack`.
- `apps/api/src/lib/goals.test.ts` — assignment-aware analysis assertions.
- `apps/api/src/routes/goals.ts` — `contributionAccountId` in POST/PATCH; `PUT /:id/accounts`.
- `apps/api/src/routes/goals.test.ts` — assignment route test.

---

## Task 1: Schema — `goal_accounts` table + `contribution_account_id`

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/drizzle/<generated>.sql` (via drizzle-kit)

- [ ] **Step 1: Add the column to the `goals` table**

In `apps/api/src/db/schema.ts`, inside the `goals` table definition, add `contributionAccountId` right after `monthlyContributionMinor` (line 151):

```ts
  // Assumed planned saving toward this goal (base of the projected line).
  monthlyContributionMinor: integer("monthly_contribution_minor").notNull().default(0),
  // Which assigned account the monthly contribution lands in (null = none chosen yet).
  contributionAccountId: text("contribution_account_id"),
```

- [ ] **Step 2: Add the `goalAccounts` join table**

In the same file, immediately after the `goals` table block (after line 161), add:

```ts
// Which accounts fund a goal (many-to-many). An account may fund several goals;
// contention between goals sharing an account is resolved by goal priority
// (goals.sortOrder) in allocateGoals.
export const goalAccounts = sqliteTable("goal_accounts", {
  goalId: text("goal_id").notNull(),       // FK -> goals.id
  accountId: text("account_id").notNull(), // FK -> accounts.id
}, (t) => [
  primaryKey({ columns: [t.goalId, t.accountId] }),
  index("goal_accounts_account_idx").on(t.accountId),
]);
```

`primaryKey` and `index` are already imported at the top of the file (line 1).

- [ ] **Step 3: Generate the migration**

Run: `bun run db:generate`
Expected: drizzle-kit prints a new migration file under `apps/api/drizzle/` creating `goal_accounts` and adding `contribution_account_id` to `goals`.

- [ ] **Step 4: Apply the migration to the dev DB**

Run: `bun run db:migrate`
Expected: migration applies with no error.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle
git commit -m "feat(db): goal_accounts join + goals.contribution_account_id"
```

---

## Task 2: Shared — extend `GoalInput`

**Files:**
- Modify: `packages/shared/src/goals.ts:104-109`

- [ ] **Step 1: Add `accountIds` and `priority` to `GoalInput`**

Replace the `GoalInput` type (lines 104-109) with:

```ts
export type GoalInput = {
  id: string;
  targetAmountMinor: number;   // already in base currency
  targetYear: number | null;   // year component of targetDate; null = indefinite (no deadline)
  ownerScope: string;          // 'household' | a userId
  accountIds: string[];        // accounts assigned to fund this goal
  priority: number;            // lower = funded first (goals.sortOrder)
};
```

No test in this step — it is exercised by Task 3.

---

## Task 3: Shared — allocate only from assigned accounts, by priority

**Files:**
- Modify: `packages/shared/src/goals.ts:173-232` (`allocateGoals`)
- Test: `packages/shared/src/goals.test.ts`

- [ ] **Step 1: Write the failing contention test**

Add to `packages/shared/src/goals.test.ts` after the existing `allocateGoals` tests (after line 147):

```ts
test("allocateGoals: a shared account funds higher-priority goal first", () => {
  const checking = acct("chk", 25_000_000, liquid);
  const goals: GoalInput[] = [
    { id: "car",  targetAmountMinor: 20_000_000, targetYear: 2030, ownerScope: "household", accountIds: ["chk"], priority: 0 },
    { id: "reno", targetAmountMinor: 15_000_000, targetYear: 2031, ownerScope: "household", accountIds: ["chk"], priority: 1 },
  ];
  const r = allocateGoals({ goals, accounts: [checking] });
  const car = r.goals.find((g) => g.id === "car")!;
  const reno = r.goals.find((g) => g.id === "reno")!;
  expect(car.allocatedMinor).toBe(20_000_000);  // priority 0 fills first
  expect(reno.allocatedMinor).toBe(5_000_000);  // gets the remaining 5m
  expect(reno.progressPct).toBe(33);            // round(5/15*100)
  expect(r.unallocatedMinor).toBe(0);
});

test("allocateGoals: an unassigned account never funds a goal", () => {
  const checking = acct("chk", 10_000_000, liquid);
  const savings = acct("sav", 10_000_000, liquid);
  const goals: GoalInput[] = [
    { id: "car", targetAmountMinor: 20_000_000, targetYear: 2030, ownerScope: "household", accountIds: ["chk"], priority: 0 },
  ];
  const r = allocateGoals({ goals, accounts: [checking, savings] });
  expect(r.goals[0].allocatedMinor).toBe(10_000_000); // only the assigned chk
  expect(r.unallocatedMinor).toBe(10_000_000);         // sav stays free
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `cd packages/shared && bun test src/goals.test.ts`
Expected: FAIL — the current `allocateGoals` ignores `accountIds`, so `reno` gets `0` (today's code fills `car` from all eligible accounts) and the unassigned `sav` is consumed.

- [ ] **Step 3: Restrict eligibility to assigned accounts and order by priority**

In `packages/shared/src/goals.ts`, change the `ordered` sort (lines 185-191) to put `priority` first:

```ts
  // Goal priority first (sortOrder), then soonest deadline (indefinite last),
  // then smallest target, then id for stable ordering.
  const ordered = [...goals].sort((g1, g2) => {
    if (g1.priority !== g2.priority) return g1.priority - g2.priority;
    const y1 = g1.targetYear ?? Number.POSITIVE_INFINITY;
    const y2 = g2.targetYear ?? Number.POSITIVE_INFINITY;
    if (y1 !== y2) return y1 - y2;
    if (g1.targetAmountMinor !== g2.targetAmountMinor) return g1.targetAmountMinor - g2.targetAmountMinor;
    return g1.id < g2.id ? -1 : g1.id > g2.id ? 1 : 0;
  });
```

Then restrict `eligible` (lines 199-201) to the goal's assigned accounts:

```ts
    const assigned = new Set(goal.accountIds);
    const eligible = accounts
      .filter((a) => assigned.has(a.id) && (remaining.get(a.id) ?? 0) > 0 && ownerScopeAllows(a, goal.ownerScope))
      .sort((x, y) => liquidityRank(x) - liquidityRank(y));
```

- [ ] **Step 4: Update the 5 existing `allocateGoals` tests to assign accounts**

These tests pre-date assignment and must now declare `accountIds` + `priority`. Apply each change in `packages/shared/src/goals.test.ts`:

In "soonest-first…" (lines 85-89), replace the goals array with:

```ts
  const goals: GoalInput[] = [
    { id: "long",  targetAmountMinor: 20_000_000, targetYear: 2050, ownerScope: "household", accountIds: ["cash", "cpf"], priority: 1 },
    { id: "short", targetAmountMinor: 3_000_000,  targetYear: 2030, ownerScope: "household", accountIds: ["cash", "cpf"], priority: 0 },
  ];
```

(`priority` reproduces the old soonest-first order: short=0, long=1.)

In "penalty account…" (lines 104-107):

```ts
  const goals: GoalInput[] = [
    { id: "g", targetAmountMinor: 2_000_000, targetYear: 2030, ownerScope: "household", accountIds: ["srs"], priority: 0 },
  ];
```

In "illiquid excluded…" (lines 116-119):

```ts
  const goals: GoalInput[] = [
    { id: "g", targetAmountMinor: 100_000_000, targetYear: 2050, ownerScope: "household", accountIds: ["prop", "prop2"], priority: 0 },
  ];
```

In "ownerScope…" (lines 129-131):

```ts
  const goals: GoalInput[] = [
    { id: "mine", targetAmountMinor: 9_000_000, targetYear: 2030, ownerScope: "u1", accountIds: ["a", "b", "c"], priority: 0 },
  ];
```

(All three accounts are assigned; the scope guard still limits a u1-personal goal to u1's solo account.)

In "liabilities / negative balances…" (lines 141-143):

```ts
  const goals: GoalInput[] = [
    { id: "g", targetAmountMinor: 5_000_000, targetYear: 2030, ownerScope: "household", accountIds: ["debt", "cash"], priority: 0 },
  ];
```

- [ ] **Step 5: Run the full shared goals test file**

Run: `cd packages/shared && bun test src/goals.test.ts`
Expected: PASS — all allocation tests (updated 5 + 2 new) green.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/goals.ts packages/shared/src/goals.test.ts
git commit -m "feat(shared): allocate goals from assigned accounts by priority"
```

---

## Task 4: API lib — fix test baseline, read assignments, expose them, nullable on-track

**Files:**
- Modify: `apps/api/src/lib/goals.ts`
- Test: `apps/api/src/lib/goals.test.ts`

> **Why a baseline fix first:** `apps/api/src/lib/goals.test.ts` currently has 2 failing tests — its `addAccount` helper inserts a `"USD"` instrument on every call, which collides with the `instruments_symbol_uq` unique index when a test seeds two accounts. These are the "pre-existing 8 failures" from the build-status memory. We must green this file before we can TDD the assignment changes, and the same change un-breaks the other suites that seed multiple same-currency accounts.

- [ ] **Step 0a: Make `addAccount` reuse a single USD instrument**

In `apps/api/src/lib/goals.test.ts`, add the `eq` import at the top (after line 4):

```ts
import { eq } from "drizzle-orm";
```

Add this helper just above `addAccount` (before line 13):

```ts
// Reuse one USD instrument across accounts — the instruments_symbol_uq index
// forbids two rows with the same symbol.
async function usdInstrumentId(): Promise<string> {
  const existing = await db.select().from(instruments).where(eq(instruments.symbol, "USD"));
  if (existing.length) return existing[0].id;
  const id = createId();
  await db.insert(instruments).values({
    id, symbol: "USD", isin: null, name: "US Dollar",
    kind: "currency", currency: "USD", createdAt: nowEpoch(),
  });
  return id;
}
```

Then replace the instrument-insert block inside `addAccount` (lines 30-34) with:

```ts
  const instrId = await usdInstrumentId();
```

(The opening-transaction insert below it already uses `instrId` — leave it unchanged.)

- [ ] **Step 0b: Run the file to confirm a green baseline**

Run: `bun test src/lib/goals.test.ts` (from `apps/api`)
Expected: 6 pass, 0 fail.

- [ ] **Step 0c: Commit the baseline fix**

```bash
git add apps/api/src/lib/goals.test.ts
git commit -m "test(api): reuse one USD instrument in goals test helper (fixes uq collision)"
```

- [ ] **Step 1: Import the join table and add a loader**

In `apps/api/src/lib/goals.ts`, extend the schema import (line 2):

```ts
import { goals as goalsTable, memberProfiles, goalAccounts } from "../db/schema";
```

Add this helper after `targetInBaseMinor` (after line 133):

```ts
// goalId -> assigned accountIds (order not significant; allocation sorts by liquidity).
async function loadAssignments(): Promise<Map<string, string[]>> {
  const links = await db.select().from(goalAccounts);
  const byGoal = new Map<string, string[]>();
  for (const l of links) {
    const arr = byGoal.get(l.goalId);
    if (arr) arr.push(l.accountId);
    else byGoal.set(l.goalId, [l.accountId]);
  }
  return byGoal;
}
```

- [ ] **Step 2: Add fields to the `GoalAnalysis` type and make `onTrack` nullable**

In `apps/api/src/lib/goals.ts`, update the `GoalAnalysis` type (lines 21-37). Change the `onTrack` line and add two fields before `sources`:

```ts
  onTrack: boolean | null;            // dated: projected reaches target by date; undated: null (no pass/fail)
  reachDate: string | null;          // YYYY-MM-DD the plan first reaches target (null = not within ~100y)
  spendType: SpendType;              // how this goal spends at/after targetDate
  annualIncomeMinor: number | null;  // derived recurring income (monthly/percent); null otherwise
  accountIds: string[];              // accounts assigned to fund this goal
  contributionAccountId: string | null; // assigned account the monthly contribution lands in
  sources: GoalSource[];
```

- [ ] **Step 3: Build goal inputs with assignment + priority, set nullable on-track**

In `analyzeGoals`, after loading `goalRows`/`profiles` (after line 163) add:

```ts
  const accountIdsByGoal = await loadAssignments();
```

Replace the `goalInputs.push({...})` block (lines 177-180) with:

```ts
    goalInputs.push({
      id: g.id, targetAmountMinor: targetBase, targetYear: g.targetDate ? yearOf(g.targetDate) : null,
      ownerScope: g.ownerScope,
      accountIds: accountIdsByGoal.get(g.id) ?? [],
      priority: g.sortOrder,
    });
```

Replace the `onTrack` computation (lines 204-206) with:

```ts
    const onTrack: boolean | null = monthsToTarget === null
      ? null
      : reachMonths !== null && reachMonths <= monthsToTarget;
```

Add the two new fields to the `analyses.push({...})` object (insert before `sources:` at line 219):

```ts
      accountIds: accountIdsByGoal.get(g.id) ?? [],
      contributionAccountId: g.contributionAccountId,
```

Update `behindCount` (line 227) to count only dated-and-behind goals:

```ts
  const behindCount = analyses.filter((a) => a.onTrack === false).length;
```

- [ ] **Step 4: Mirror the changes in `goalProjection`**

In `goalProjection`, after loading `profiles` (after line 279) add:

```ts
  const accountIdsByGoal = await loadAssignments();
```

Replace its `goalInputs.push({...})` block (lines 289-292) with:

```ts
    goalInputs.push({
      id: g.id, targetAmountMinor: tb, targetYear: g.targetDate ? yearOf(g.targetDate) : null,
      ownerScope: g.ownerScope,
      accountIds: accountIdsByGoal.get(g.id) ?? [],
      priority: g.sortOrder,
    });
```

Change the `GoalProjectionResult.onTrack` type (line in the type block, currently `onTrack: boolean;`) to:

```ts
  onTrack: boolean | null;
```

Replace its `onTrack` computation (lines 324-326) with:

```ts
  const onTrack: boolean | null = monthsToTarget === null
    ? null
    : reachMonths !== null && reachMonths <= monthsToTarget;
```

- [ ] **Step 5: Assign accounts in all six existing lib tests (behaviour-preserving)**

The new allocation rule funds a goal only from its assigned accounts, so every existing test must now create `goalAccounts` rows. Assigning **every seeded account to every goal in that test** reproduces the old "all accounts eligible" behaviour, so all existing numeric assertions stay valid.

First, add `goalAccounts` to the schema import (line 3):

```ts
import { accounts, instruments, transactions, goals, memberProfiles, user, goalAccounts } from "../db/schema";
```

Then edit each test to capture the account ids `addAccount` returns and insert assignments after the goal insert:

**Test "soonest-first allocation" (line 44):** change the two `addAccount` calls (lines 52-53) to capture ids, and add an assignment insert after the `goals` insert (after line 58):

```ts
  const cashId = await addAccount({ name: "Cash", subtype: "bank", openingMinor: 5_000_000, ownerId: userId });
  const cpfId = await addAccount({ name: "CPF", subtype: "other", accessibleFromAge: 55, openingMinor: 10_000_000, ownerId: userId });
```

```ts
  await db.insert(goalAccounts).values([
    { goalId: "short", accountId: cashId }, { goalId: "short", accountId: cpfId },
    { goalId: "long", accountId: cashId },  { goalId: "long", accountId: cpfId },
  ]);
```

**Test "a sufficient monthly contribution" (line 85):** capture the cash id (line 88) and assign it to goal `c` after its insert (after line 95):

```ts
  const cashId = await addAccount({ name: "Cash", subtype: "bank", openingMinor: 1_000_000, ownerId: owner.id });
```

```ts
  await db.insert(goalAccounts).values({ goalId: "c", accountId: cashId });
```

**Test "goalProjection: past actual…" (line 105):** capture both ids (lines 111-112) and assign both to goal `g` (after line 118):

```ts
  const cashId = await addAccount({ name: "Cash", subtype: "bank", openingMinor: 5_000_000, ownerId: userId });
  const cpfId = await addAccount({ name: "CPF", subtype: "other", accessibleFromAge: 55, openingMinor: 10_000_000, ownerId: userId });
```

```ts
  await db.insert(goalAccounts).values([
    { goalId: "g", accountId: cashId }, { goalId: "g", accountId: cpfId },
  ]);
```

**Test "indefinite goal" (line 158):** capture the cash id (line 161) and assign it to `indef` (after line 167):

```ts
  const cashId = await addAccount({ name: "Cash", subtype: "bank", openingMinor: 1_000_000, ownerId: owner.id });
```

```ts
  await db.insert(goalAccounts).values({ goalId: "indef", accountId: cashId });
```

**Test "monthly-spend goal" (line 184):** capture the cash id (line 187) and assign it to `draw` (after line 194):

```ts
  const cashId = await addAccount({ name: "Cash", subtype: "bank", openingMinor: 50_000_000, ownerId: owner.id });
```

```ts
  await db.insert(goalAccounts).values({ goalId: "draw", accountId: cashId });
```

**Test "percent-spend goal" (line 213):** capture the cash id (line 216) and assign it to `swr` (after line 223):

```ts
  const cashId = await addAccount({ name: "Cash", subtype: "bank", openingMinor: 100_000_000, ownerId: owner.id });
```

```ts
  await db.insert(goalAccounts).values({ goalId: "swr", accountId: cashId });
```

- [ ] **Step 6: Fix the indefinite-goal on-track assertion**

In the "indefinite goal" test, the goal has no `targetDate`, so `onTrack` is now `null`. Change line 174 from:

```ts
  expect(a.onTrack).toBe(true);                    // reachable within the cap
```

to:

```ts
  expect(a.onTrack).toBeNull();                    // undated -> no pass/fail
```

- [ ] **Step 7: Add a new test for assignment-restricted allocation + null on-track**

Append to `apps/api/src/lib/goals.test.ts`:

```ts
test("analyzeGoals: an unassigned account never funds a goal; undated goal has null onTrack", async () => {
  await initAndLogin({ baseCurrency: "USD" });
  const [owner] = await db.select().from(user);
  const chkId = await addAccount({ name: "Checking", subtype: "bank", openingMinor: 10_000_000, ownerId: owner.id });
  await addAccount({ name: "Savings", subtype: "bank", openingMinor: 10_000_000, ownerId: owner.id }); // unassigned

  await db.insert(goals).values([
    { id: "car", name: "Car", targetAmountMinor: 20_000_000, currency: "USD", targetDate: "2030-01-01", ownerScope: "household", anchorDate: null, monthlyContributionMinor: 0, sortOrder: 0, createdAt: nowEpoch(), createdBy: "seed" },
    { id: "buffer", name: "Buffer", targetAmountMinor: 5_000_000, currency: "USD", targetDate: null, ownerScope: "household", anchorDate: null, monthlyContributionMinor: 0, sortOrder: 1, createdAt: nowEpoch(), createdBy: "seed" },
  ]);
  await db.insert(goalAccounts).values({ goalId: "car", accountId: chkId }); // buffer is unassigned

  const res = await analyzeGoals();
  const car = res.goals.find((g) => g.id === "car")!;
  const buffer = res.goals.find((g) => g.id === "buffer")!;

  expect(car.allocatedMinor).toBe(10_000_000);     // only the assigned Checking (Savings ignored)
  expect(car.accountIds).toEqual([chkId]);
  expect(typeof car.onTrack).toBe("boolean");       // dated -> boolean
  expect(buffer.allocatedMinor).toBe(0);            // no assigned account
  expect(buffer.onTrack).toBeNull();                // undated -> null
  expect(res.unallocatedMinor).toBe(10_000_000);    // Savings stays free
});
```

- [ ] **Step 8: Run the lib tests**

Run: `bun test src/lib/goals.test.ts` (from `apps/api`)
Expected: 7 pass, 0 fail (6 updated + 1 new).

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/lib/goals.ts apps/api/src/lib/goals.test.ts
git commit -m "feat(api): goal analysis from assignments; null on-track for undated goals"
```

---

## Task 5: API routes — persist assignment + contribution account

**Files:**
- Modify: `apps/api/src/routes/goals.ts`
- Test: `apps/api/src/routes/goals.test.ts`

- [ ] **Step 1: Import the join table**

In `apps/api/src/routes/goals.ts`, extend the schema import (line 3):

```ts
import { goals, goalAccounts } from "../db/schema";
```

- [ ] **Step 2: Accept `contributionAccountId` on create**

In the POST handler `db.insert(goals).values({...})` (lines 38-53), add after `monthlyContributionMinor`:

```ts
          monthlyContributionMinor: body.monthlyContributionMinor ?? 0,
          contributionAccountId: body.contributionAccountId ?? null,
```

Add to the POST body schema (after the `monthlyContributionMinor` line ~72):

```ts
        monthlyContributionMinor: t.Optional(t.Number()),
        contributionAccountId: t.Optional(t.Union([t.String(), t.Null()])),
```

- [ ] **Step 3: Accept `contributionAccountId` on patch**

In the PATCH handler's update assembly (after line 99), add:

```ts
      if (body.contributionAccountId !== undefined) update.contributionAccountId = body.contributionAccountId;
```

Add to the PATCH body schema (after its `monthlyContributionMinor` line ~115):

```ts
        monthlyContributionMinor: t.Optional(t.Number()),
        contributionAccountId: t.Optional(t.Union([t.String(), t.Null()])),
```

- [ ] **Step 4: Add the assignment-replace route**

Insert this chained route before `.delete(...)` (before line 123):

```ts
  // Replace the full set of accounts funding a goal.
  .put(
    "/:id/accounts",
    async ({ params, body }: any) => {
      await db.delete(goalAccounts).where(eq(goalAccounts.goalId, params.id));
      if (body.accountIds.length) {
        await db.insert(goalAccounts).values(
          body.accountIds.map((accountId: string) => ({ goalId: params.id, accountId })),
        );
      }
      return { ok: true };
    },
    { body: t.Object({ accountIds: t.Array(t.String()) }) },
  )
```

- [ ] **Step 5: Write the failing route test**

Add to `apps/api/src/routes/goals.test.ts` (after the existing CRUD test):

```ts
test("PUT /goals/:id/accounts replaces the funding set; analysis reflects it", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const id = crypto.randomUUID();
  await app.handle(new Request("http://localhost/goals", {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      id, name: "Car", targetAmountMinor: 20_000_000, currency: "USD",
      targetDate: "2030-01-01", ownerScope: "household",
    }),
  }));

  const put = await app.handle(new Request(`http://localhost/goals/${id}/accounts`, {
    method: "PUT", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ accountIds: ["acc-1", "acc-2"] }),
  }));
  expect(put.status).toBe(200);

  const analysis = await (await app.handle(
    new Request("http://localhost/goals/analysis", { headers: { cookie } }),
  )).json();
  const g = analysis.goals.find((x: any) => x.id === id);
  expect(new Set(g.accountIds)).toEqual(new Set(["acc-1", "acc-2"]));

  // Replacing with an empty set clears funding.
  await app.handle(new Request(`http://localhost/goals/${id}/accounts`, {
    method: "PUT", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ accountIds: [] }),
  }));
  const analysis2 = await (await app.handle(
    new Request("http://localhost/goals/analysis", { headers: { cookie } }),
  )).json();
  expect(analysis2.goals.find((x: any) => x.id === id).accountIds).toEqual([]);
});
```

- [ ] **Step 6: Run the route tests**

Run: `cd apps/api && bun test src/routes/goals.test.ts`
Expected: PASS — assignment persists and surfaces in `/goals/analysis`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/goals.ts apps/api/src/routes/goals.test.ts
git commit -m "feat(api): goal account-assignment route + contributionAccountId"
```

---

## Task 6: Whole-suite verification + typecheck

**Files:** none (verification only)

- [ ] **Step 1: Run the API + shared test suites**

Run: `bun run test`
Expected: the goals suites (`src/lib/goals.test.ts`, `src/routes/goals.test.ts`) and shared `goals.test.ts` are green. NOTE: the build-status memory's "~8 pre-existing failures" are `instruments_symbol_uq` collisions from the same duplicate-instrument bug in *other* test files' seed helpers (Task 4 only fixes the goals helper). Any remaining failures should be confined to those other files and are out of scope for Plan 1 — confirm none are in goals/projection tests. (Optionally note them for a future cleanup.)

- [ ] **Step 2: Strict typecheck via the web build (tsgo)**

Run: `cd apps/web && bun run build`
Expected: build succeeds. This is the project's strict typecheck (bun test does not strict-typecheck). The web still reads the old analysis shape; the added fields and `onTrack: boolean | null` must not break the web's consumption — if the web narrows `onTrack` to `boolean`, adjust the local type in `apps/web/src/routes/goals.tsx` `GoalAnalysis` to `boolean | null` (display handling for null arrives in Plan 3).

- [ ] **Step 3: Commit any typecheck fix**

```bash
git add -A
git commit -m "chore(web): widen goal onTrack type to boolean | null"
```

---

## Self-review notes

- **Spec coverage:** explicit assignment (Tasks 1,3,5), shared-account contention by priority (Task 3), accessibility preserved (unchanged `accessibleValueMinor` path in `allocateGoals`), on-track only for dated goals (Task 4). Decumulation-on-goals, contributions-on-goals, dropping account columns, and the `/plan` UI are intentionally **Plans 2 & 3**.
- **Deferred within this plan:** `simulateGoals` still orders the cascade by deadline, not `priority`; reordering changes today's allocation but not the cascade stream. Acceptable for Plan 1; revisit in Plan 2 when flows move onto goals.
- **Type consistency:** `GoalInput` now carries `accountIds`/`priority` everywhere it is constructed (`lib/goals.ts` both call sites, all shared tests). `onTrack` is `boolean | null` in both `GoalAnalysis` and `GoalProjectionResult`.
