# Goal Detail Page + Projection Chart — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each goal clickable into a `/goals/$id` detail page with a donut progress chart and a time-series projection (history → on-plan vs eligible-accounts trajectory toward target), and move per-goal Edit/Delete into a 3-dot (⋮) menu.

**Architecture:** A new server function `goalProjection()` in `apps/api/src/lib/goals.ts` reuses the existing pure shared engine (`compoundMonthlyMinor`, `annuityFutureValueMinor`, `allocateGoals`, `goalOnTrack`) and `netWorth({asOf})` to produce a monthly series (past actual + future on-plan/eligible), exposed at `GET /goals/:id/projection`. The web app gains a `/goals/$id` detail route (donut + Recharts line chart), a controllable `GoalForm`, and a shadcn `dropdown-menu` kebab on goal cards + the detail header.

**Tech Stack:** Bun + ElysiaJS + Drizzle (SQLite) on the API; React + TanStack Router/Query/DB + Recharts 3.8 + shadcn/ui (base-ui flavored) on the web; `bun:test` for unit tests.

**Spec:** `docs/superpowers/specs/2026-06-14-goal-detail-projection-design.md`.

**Conventions:** No `as any` (except the existing Elysia `({ ... }: any)` handler convention). Money is integer minor units; all goal math lives in `packages/shared` and is called server-side. New shadcn components via the CLI. Frequent commits.

---

## File structure

**Create:**
- `apps/web/src/routes/goal-detail.tsx` — the `/goals/$id` page (header + donut + projection chart).
- `apps/web/src/components/goal-projection-chart.tsx` — the Recharts time-series chart.
- `apps/web/src/components/goal-donut.tsx` — the allocated-vs-remaining donut.
- `apps/web/src/components/ui/dropdown-menu.tsx` — shadcn (added via CLI).

**Modify:**
- `apps/api/src/lib/goals.ts` — add `goalProjection()` + `GoalProjectionResult` type + `addMonthsISO` helper; add two shared imports.
- `apps/api/src/lib/goals.test.ts` — add a `goalProjection` test.
- `apps/api/src/routes/goals.ts` — add `GET /:id/projection`.
- `apps/api/src/routes/goals.test.ts` — add route tests (200 + 404).
- `apps/web/src/components/goal-form.tsx` — add controlled-open + `hideTrigger` props.
- `apps/web/src/routes/goals.tsx` — clickable cards + ⋮ kebab (Edit/Delete) replacing inline buttons.
- `apps/web/src/router.tsx` — register `/goals/$id`.

---

## Task 1: API — `goalProjection()` server function

**Files:**
- Modify: `apps/api/src/lib/goals.ts`
- Test: `apps/api/src/lib/goals.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/lib/goals.test.ts`:

```ts
import { goalProjection } from "./goals";

test("goalProjection: past actual + future on-plan/eligible series toward target", async () => {
  await initAndLogin({ baseCurrency: "USD" });
  const [owner] = await db.select().from(user);
  const userId = owner.id;
  await db.insert(memberProfiles).values({ userId, birthYear: 1990 });

  await addAccount({ name: "Cash", subtype: "bank", openingMinor: 5_000_000, ownerId: userId });
  await addAccount({ name: "CPF", subtype: "other", accessibleFromAge: 55, openingMinor: 10_000_000, ownerId: userId });

  await db.insert(goals).values({
    id: "g", name: "Retire", term: "long", targetAmountMinor: 20_000_000, currency: "USD",
    targetDate: "2050-01-01", ownerScope: "household", anchorDate: null, sortOrder: 0,
    createdAt: nowEpoch(), createdBy: "seed",
  });

  const r = await goalProjection("g", 2);
  if (!r) throw new Error("expected a projection");

  // Single goal sees both accounts by 2050 (owner age 60 -> CPF unlocked): 5M + 10M.
  expect(r.allocatedMinor).toBe(15_000_000);
  expect(r.progressPct).toBe(75);
  expect(r.targetMinor).toBe(20_000_000);
  expect(r.requiredMonthlyMinor).toBeGreaterThan(0); // 5M gap to fund
  expect(r.onTrack).toBe(true);                       // fresh goal, anchored at today

  const today = new Date().toISOString().slice(0, 10);
  const todayPoint = r.series.find((p) => p.date === today);
  if (!todayPoint) throw new Error("expected a today point");
  // At today all three series meet at the current allocation.
  expect(todayPoint.actual).toBe(15_000_000);
  expect(todayPoint.onPlan).toBe(15_000_000);
  expect(todayPoint.eligible).toBe(15_000_000);

  // Past points: actual present, on-plan/eligible null.
  const past = r.series.filter((p) => p.date < today);
  expect(past.length).toBeGreaterThan(0);
  expect(past.every((p) => p.actual !== null && p.onPlan === null && p.eligible === null)).toBe(true);

  // Future points: actual null, on-plan/eligible present; on-plan rises above flat eligible (0% growth here).
  const future = r.series.filter((p) => p.date > today);
  expect(future.length).toBeGreaterThan(0);
  expect(future.every((p) => p.actual === null && p.onPlan !== null && p.eligible !== null)).toBe(true);
  const last = r.series[r.series.length - 1];
  expect(last.date).toBe("2050-01-01");              // final point lands on the target date
  expect((last.onPlan ?? 0)).toBeGreaterThan(last.eligible ?? 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bun test src/lib/goals.test.ts`
Expected: FAIL — `goalProjection` is not exported.

- [ ] **Step 3: Implement**

In `apps/api/src/lib/goals.ts`, extend the shared import to add the two monthly primitives. Replace the existing import block:

```ts
import {
  convertToBase, toBig, fromBig, compoundMinor,
  allocateGoals, requiredMonthlyContributionMinor, goalOnTrack,
  type AllocAccount, type GoalInput,
} from "@uang/shared";
```

with:

```ts
import {
  convertToBase, toBig, fromBig, compoundMinor,
  compoundMonthlyMinor, annuityFutureValueMinor,
  allocateGoals, requiredMonthlyContributionMinor, goalOnTrack,
  type AllocAccount, type GoalInput,
} from "@uang/shared";
```

Then append to the end of `apps/api/src/lib/goals.ts`:

```ts
// Shift an ISO date (YYYY-MM-DD) by whole months (UTC).
function addMonthsISO(iso: string, deltaMonths: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + deltaMonths);
  return d.toISOString().slice(0, 10);
}

export type GoalProjectionPoint = {
  date: string;
  actual: number | null;   // realized allocated value (past + today)
  onPlan: number | null;   // glide path (today + future)
  eligible: number | null; // allocated capital left to grow (today + future)
};

export type GoalProjectionResult = {
  baseCurrency: string;
  goal: { id: string; name: string; term: "short" | "long"; targetDate: string; currency: string };
  targetMinor: number;
  allocatedMinor: number;
  progressPct: number;
  requiredMonthlyMinor: number;
  onTrack: boolean;
  aheadByMinor: number;
  series: GoalProjectionPoint[];
};

// Per-goal time series: realized allocation over the last `historyMonths`,
// then the on-plan glide path vs the eligible-accounts trajectory to the target
// date. All goal allocations are computed globally (no double-counting), then
// this goal's slice is taken. Returns null if the goal does not exist.
export async function goalProjection(
  goalId: string,
  historyMonths = 12,
): Promise<GoalProjectionResult | null> {
  const s = await getSettings();
  const base = s?.baseCurrency ?? "USD";
  const planRateBps = s?.contributionGrowthRateBps ?? 800;

  const goalRows = await db.select().from(goalsTable).orderBy(goalsTable.sortOrder);
  const goal = goalRows.find((g) => g.id === goalId);
  if (!goal) return null;

  const profiles = await db.select().from(memberProfiles);
  const birthByUser = new Map<string, number | null>(profiles.map((p) => [p.userId, p.birthYear]));

  const todayISO = new Date().toISOString().slice(0, 10);
  const thisYear = yearOf(todayISO);

  // Inputs for ALL goals (allocation is global), with base-currency targets.
  const goalInputs: GoalInput[] = [];
  const targetBaseById = new Map<string, number>();
  for (const g of goalRows) {
    const tb = await targetInBaseMinor(g, base);
    targetBaseById.set(g.id, tb);
    goalInputs.push({
      id: g.id, targetAmountMinor: tb, targetYear: yearOf(g.targetDate),
      ownerScope: g.ownerScope, term: g.term, sortOrder: g.sortOrder,
    });
  }
  const targetBase = targetBaseById.get(goal.id)!;

  // Today's allocation for this goal.
  const nwToday = await netWorth({ owner: "household" });
  const allocToday = allocateGoals({ goals: goalInputs, accounts: toAllocAccounts(nwToday.accounts, birthByUser) });
  const mine = allocToday.goals.find((g) => g.id === goal.id)!;
  const allocatedToday = mine.allocatedMinor;

  // Required monthly (same model as analyzeGoals): grow allocated at per-account
  // annual rates to the target year, fill the gap at the plan rate.
  const yearsToTarget = Math.max(0, yearOf(goal.targetDate) - thisYear);
  let projectedAllocated = 0;
  for (const line of mine.lines) projectedAllocated += compoundMinor(line.allocatedMinor, line.growthRateBps, yearsToTarget);
  const monthsToTarget = monthsBetween(todayISO, goal.targetDate);
  const requiredMonthly = requiredMonthlyContributionMinor(targetBase - projectedAllocated, planRateBps, monthsToTarget);

  // On-track, anchored (same as analyzeGoals).
  const anchor = goal.anchorDate ?? new Date(goal.createdAt * 1000).toISOString().slice(0, 10);
  const nwAnchor = await netWorth({ asOf: anchor, owner: "household" });
  const allocAnchor = allocateGoals({ goals: goalInputs, accounts: toAllocAccounts(nwAnchor.accounts, birthByUser) });
  const startAnchor = allocAnchor.goals.find((g) => g.id === goal.id)?.allocatedMinor ?? allocatedToday;
  const ot = goalOnTrack({
    targetMinor: targetBase,
    startAnchorMinor: startAnchor,
    allocatedTodayMinor: allocatedToday,
    planRateBps,
    monthsAnchorToToday: monthsBetween(anchor, todayISO),
    monthsAnchorToTarget: monthsBetween(anchor, goal.targetDate),
  });

  const series: GoalProjectionPoint[] = [];

  // Past: realized allocation as of each month-end (oldest first).
  for (let k = historyMonths; k >= 1; k--) {
    const date = addMonthsISO(todayISO, -k);
    const nwPast = await netWorth({ asOf: date, owner: "household" });
    const allocPast = allocateGoals({ goals: goalInputs, accounts: toAllocAccounts(nwPast.accounts, birthByUser) });
    const realized = allocPast.goals.find((g) => g.id === goal.id)?.allocatedMinor ?? 0;
    series.push({ date, actual: realized, onPlan: null, eligible: null });
  }

  // Today: all three series meet at the current allocation.
  series.push({ date: todayISO, actual: allocatedToday, onPlan: allocatedToday, eligible: allocatedToday });

  // Future: step so a far-dated goal stays under ~120 points; always include the target month.
  const step = Math.max(1, Math.ceil(monthsToTarget / 120));
  const futureMonths: number[] = [];
  for (let m = step; m < monthsToTarget; m += step) futureMonths.push(m);
  if (monthsToTarget > 0) futureMonths.push(monthsToTarget);
  for (const m of futureMonths) {
    const date = addMonthsISO(todayISO, m);
    const onPlan = compoundMonthlyMinor(allocatedToday, planRateBps, m) + annuityFutureValueMinor(requiredMonthly, planRateBps, m);
    let eligible = 0;
    for (const line of mine.lines) eligible += compoundMonthlyMinor(line.allocatedMinor, line.growthRateBps, m);
    series.push({ date, actual: null, onPlan, eligible });
  }

  return {
    baseCurrency: base,
    goal: { id: goal.id, name: goal.name, term: goal.term, targetDate: goal.targetDate, currency: goal.currency },
    targetMinor: targetBase,
    allocatedMinor: allocatedToday,
    progressPct: mine.progressPct,
    requiredMonthlyMinor: requiredMonthly,
    onTrack: ot.onTrack,
    aheadByMinor: ot.aheadByMinor,
    series,
  };
}
```

> Note: the final future month is `addMonthsISO(today, monthsToTarget)`, which equals the target month (same year+month as `targetDate`); the test asserts the day-exact `2050-01-01` because today's day-of-month drives `addMonthsISO` and the seed uses `-01`. If a future run lands on a different day-of-month, that's only a label nuance — but with the fixed `targetDate: "2050-01-01"` and `monthsBetween` counting whole months, the last point's month is January 2050. Keep the assertion; if it ever proves brittle on day-of-month, relax it to `last.date.slice(0,7) === "2050-01"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && bun test src/lib/goals.test.ts`
Expected: PASS (the new test + the existing analyzeGoals test).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/goals.ts apps/api/src/lib/goals.test.ts
git commit -m "feat(api): goalProjection — per-goal history + on-plan/eligible series"
```

---

## Task 2: API — `GET /goals/:id/projection` route

**Files:**
- Modify: `apps/api/src/routes/goals.ts`
- Test: `apps/api/src/routes/goals.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/routes/goals.test.ts`:

```ts
test("GET /goals/:id/projection returns a series; 404 for unknown id", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const id = crypto.randomUUID();
  await app.handle(new Request("http://localhost/goals", {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      id, name: "House", term: "long", targetAmountMinor: 50_000_000,
      currency: "USD", targetDate: "2040-01-01", ownerScope: "household",
    }),
  }));

  const ok = await app.handle(new Request(`http://localhost/goals/${id}/projection?historyMonths=3`, { headers: { cookie } }));
  expect(ok.status).toBe(200);
  const body = await ok.json();
  expect(body.goal.id).toBe(id);
  expect(body.targetMinor).toBe(50_000_000);
  expect(Array.isArray(body.series)).toBe(true);
  expect(body.series.length).toBeGreaterThan(0);

  const missing = await app.handle(new Request(`http://localhost/goals/does-not-exist/projection`, { headers: { cookie } }));
  expect(missing.status).toBe(404);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bun test src/routes/goals.test.ts`
Expected: FAIL — the projection route returns 404 for the valid id (route not defined yet) / unknown route.

- [ ] **Step 3: Implement**

In `apps/api/src/routes/goals.ts`:

(a) Extend the import from `../lib/goals`:

```ts
import { analyzeGoals, goalProjection } from "../lib/goals";
```

(b) Add the route right after the `.get("/analysis", ...)` line:

```ts
  .get(
    "/:id/projection",
    async ({ params, query, set }: any) => {
      const r = await goalProjection(params.id, query.historyMonths ?? 12);
      if (!r) {
        set.status = 404;
        return { error: "not_found" };
      }
      return r;
    },
    { query: t.Object({ historyMonths: t.Optional(t.Numeric()) }) },
  )
```

> `t.Numeric()` coerces the `?historyMonths=` query string to a number. The `/:id/projection` path has two segments and cannot collide with the single-segment static `/analysis` route or the `/:id` PATCH/DELETE handlers.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && bun test src/routes/goals.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/goals.ts apps/api/src/routes/goals.test.ts
git commit -m "feat(api): GET /goals/:id/projection route"
```

---

## Task 3: Web — controllable GoalForm + dropdown-menu component

**Files:**
- Modify: `apps/web/src/components/goal-form.tsx`
- Create: `apps/web/src/components/ui/dropdown-menu.tsx` (via shadcn CLI)

- [ ] **Step 1: Add the shadcn dropdown-menu component**

Run: `cd apps/web && bunx shadcn@latest add dropdown-menu`
Expected: creates `apps/web/src/components/ui/dropdown-menu.tsx`.

Then open the generated file and note the exact exported names and the trigger API. This repo's shadcn is **base-ui flavored** (see `dialog.tsx` / `select.tsx`, which use a `render={<Button .../>}` trigger prop). Confirm whether the generated dropdown exports `DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem` and whether `DropdownMenuTrigger` takes a `render` prop. Task 4 uses those names with a `render` trigger; if the generated names differ, use the generated ones consistently in Task 4.

- [ ] **Step 2: Make GoalForm controllable**

Replace the `GoalForm` signature and the `open` state wiring in `apps/web/src/components/goal-form.tsx`. Change:

```tsx
export function GoalForm({ goal, defaultCurrency = "USD" }: { goal?: GoalRow; defaultCurrency?: string }) {
  const editing = !!goal;
  const currency = goal?.currency ?? defaultCurrency;
  const [open, setOpen] = useState(false);
```

to:

```tsx
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
```

Then in the returned JSX, make the trigger conditional. Change:

```tsx
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant={editing ? "outline" : "default"} size="sm" />}>
        {editing ? "Edit" : "New goal"}
      </DialogTrigger>
      <DialogContent>
```

to:

```tsx
    <Dialog open={open} onOpenChange={setOpen}>
      {!hideTrigger && (
        <DialogTrigger render={<Button variant={editing ? "outline" : "default"} size="sm" />}>
          {editing ? "Edit" : "New goal"}
        </DialogTrigger>
      )}
      <DialogContent>
```

Everything else in the component stays the same. (Existing call sites pass neither `open` nor `hideTrigger`, so they keep their self-triggering button — no behavior change.)

- [ ] **Step 3: Type-check**

Run: `cd apps/web && bunx tsc -b`
Expected: no type errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/goal-form.tsx apps/web/src/components/ui/dropdown-menu.tsx
git commit -m "feat(web): controllable GoalForm + dropdown-menu component"
```

---

## Task 4: Web — clickable goal cards + ⋮ kebab menu

**Files:**
- Modify: `apps/web/src/routes/goals.tsx`

- [ ] **Step 1: Add imports**

In `apps/web/src/routes/goals.tsx`, add to the imports:

```ts
import { useState } from "react";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { type GoalRow } from "@/lib/collections";
```

(Keep the existing imports. Adjust the dropdown export names if Task 3 Step 1 found different ones.)

- [ ] **Step 2: Add the complete GoalCard component (clickable card + kebab + analysis)**

In `apps/web/src/routes/goals.tsx`, add this component above `GoalsPage`. `GoalAnalysis` is the type already declared at the top of this file:

```tsx
function GoalCard({ g, a, base }: { g: GoalRow; a: GoalAnalysis | undefined; base: string }) {
  const [editOpen, setEditOpen] = useState(false);
  return (
    <div className="relative rounded-2xl border border-border bg-card">
      <Link
        to="/goals/$id"
        params={{ id: g.id }}
        className="block rounded-2xl p-4 pr-12 transition-colors hover:bg-accent"
        data-testid="goal-card"
      >
        <p className="truncate font-medium">{g.name}</p>
        <p className="text-xs text-muted-foreground">
          {formatMoney(g.targetAmountMinor, g.currency)} by {g.targetDate}
        </p>
        {a && (
          <>
            <div className="mt-2">
              <Badge variant={a.onTrack ? "default" : "destructive"}>
                {a.onTrack ? "On track" : "Behind"}
              </Badge>
            </div>
            <div className="mt-3 space-y-2">
              <Progress value={a.progressPct} />
              <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
                <span>{formatMoney(a.allocatedMinor, base)} allocated · {a.progressPct}%</span>
                <span>
                  {a.requiredMonthlyMinor > 0
                    ? `${formatMoney(a.requiredMonthlyMinor, base)}/mo to fund`
                    : "Fully funded"}
                </span>
              </div>
            </div>
          </>
        )}
      </Link>

      <div className="absolute right-2 top-2">
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Goal actions" />}>
            ⋮
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setEditOpen(true)}>Edit</DropdownMenuItem>
            <DropdownMenuItem className="text-destructive" onClick={() => goalsCollection.delete(g.id)}>
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {/* Controlled edit dialog (no own trigger); opened from the menu item. */}
        <GoalForm goal={g} defaultCurrency={base || undefined} open={editOpen} onOpenChange={setEditOpen} hideTrigger />
      </div>
    </div>
  );
}
```

> The kebab lives in an absolutely-positioned sibling **outside** the `<Link>`, so clicking it never triggers navigation (no `stopPropagation` needed). The card's `pr-12` reserves room for it. If the generated `DropdownMenuTrigger` does not accept `render`, wrap a `<Button>` child per the generated component's API; if `DropdownMenuItem` uses `onSelect` rather than `onClick`, use that. "⋮" is the vertical 3-dot glyph.

- [ ] **Step 3: Replace the inline card markup in GoalsPage with `<GoalCard>`**

In `GoalsPage`, replace the whole `{termRows.map((g) => { ... })}` block (the `<div key={g.id} className="rounded-2xl border ...">...</div>` returned per goal) with:

```tsx
                  {termRows.map((g) => (
                    <GoalCard key={g.id} g={g} a={byId.get(g.id)} base={base} />
                  ))}
```

This removes the old inline "Edit" `<GoalForm goal={g} ... />` button and the "✕" delete `<Button>` (now in the kebab).

- [ ] **Step 4: Verify build**

Run: `cd apps/web && bunx tsc -b`
Expected: no type errors.

Manual: open `/goals` — each card is clickable (cursor + hover), the ⋮ menu opens with Edit/Delete, Edit opens the dialog, Delete removes the goal, and clicking the ⋮ does NOT navigate.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/goals.tsx
git commit -m "feat(web): clickable goal cards + kebab (edit/delete) menu"
```

---

## Task 5: Web — goal detail page (donut + projection chart)

**Files:**
- Create: `apps/web/src/components/goal-donut.tsx`, `apps/web/src/components/goal-projection-chart.tsx`, `apps/web/src/routes/goal-detail.tsx`
- Modify: `apps/web/src/router.tsx`

- [ ] **Step 1: Build the donut component**

Create `apps/web/src/components/goal-donut.tsx`:

```tsx
import { Cell, Pie, PieChart } from "recharts";
import { ChartContainer, type ChartConfig } from "@/components/ui/chart";

const config = {
  allocated: { label: "Allocated", color: "var(--chart-1)" },
  remaining: { label: "Remaining", color: "var(--muted)" },
} satisfies ChartConfig;

export function GoalDonut({
  allocatedMinor,
  targetMinor,
  progressPct,
}: {
  allocatedMinor: number;
  targetMinor: number;
  progressPct: number;
}) {
  const remaining = Math.max(0, targetMinor - allocatedMinor);
  const data = [
    { key: "allocated", value: Math.max(0, allocatedMinor) },
    { key: "remaining", value: remaining },
  ];
  return (
    <div className="relative">
      <ChartContainer config={config} className="mx-auto aspect-square h-[180px]">
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="key" innerRadius={60} outerRadius={80} strokeWidth={2}>
            {data.map((d) => (
              <Cell key={d.key} fill={`var(--color-${d.key})`} />
            ))}
          </Pie>
        </PieChart>
      </ChartContainer>
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <span className="font-heading text-2xl tabular-nums">{progressPct}%</span>
      </div>
    </div>
  );
}
```

> Verify `var(--muted)` resolves in this theme (it is a standard shadcn token). If the slice it renders is invisible against the card, switch `remaining` to `var(--border)`.

- [ ] **Step 2: Build the projection chart component**

Create `apps/web/src/components/goal-projection-chart.tsx`:

```tsx
import { CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts";
import { formatMoney } from "@/components/money";
import {
  ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig,
} from "@/components/ui/chart";

export type GoalProjectionPoint = {
  date: string;
  actual: number | null;
  onPlan: number | null;
  eligible: number | null;
};

const config = {
  actual: { label: "Actual", color: "var(--chart-1)" },
  onPlan: { label: "On plan", color: "var(--chart-2)" },
  eligible: { label: "Eligible (no new saving)", color: "var(--chart-4)" },
} satisfies ChartConfig;

const LABELS: Record<string, string> = {
  actual: "Actual",
  onPlan: "On plan",
  eligible: "Eligible (no new saving)",
};

export function GoalProjectionChart({
  series,
  targetMinor,
  targetDate,
  baseCurrency,
}: {
  series: GoalProjectionPoint[];
  targetMinor: number;
  targetDate: string;
  baseCurrency: string;
}) {
  return (
    <ChartContainer config={config} className="h-[280px] w-full">
      <LineChart data={series} margin={{ left: 8, right: 8, top: 16, bottom: 0 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8}
          tickFormatter={(d: string) => String(d).slice(0, 7)} minTickGap={32} />
        <YAxis hide />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(l) => String(l)}
              formatter={(value, name) => `${LABELS[String(name)] ?? String(name)}: ${formatMoney(Number(value), baseCurrency)}`}
            />
          }
        />
        <ReferenceLine y={targetMinor} stroke="var(--chart-3)" strokeDasharray="4 4"
          label={{ value: "Target", position: "insideTopRight", fontSize: 10 }} />
        <ReferenceLine x={targetDate} stroke="var(--border)" strokeDasharray="3 3" />
        <Line dataKey="actual" type="monotone" stroke="var(--color-actual)" strokeWidth={2} dot={false} connectNulls={false} />
        <Line dataKey="onPlan" type="monotone" stroke="var(--color-onPlan)" strokeWidth={2} strokeDasharray="5 3" dot={false} connectNulls={false} />
        <Line dataKey="eligible" type="monotone" stroke="var(--color-eligible)" strokeWidth={2} dot={false} connectNulls={false} />
      </LineChart>
    </ChartContainer>
  );
}
```

> The `ReferenceLine x={targetDate}` only renders if `targetDate` exactly matches a category value on the axis; the series' final point is the target month, but its `date` may be e.g. `2050-01-03` (today's day-of-month). If the marker doesn't show, it's cosmetic — the target line (y) already conveys the goal. Leave as-is.

- [ ] **Step 3: Build the detail page**

Create `apps/web/src/routes/goal-detail.tsx`:

```tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { api } from "@/lib/api";
import { goalsCollection } from "@/lib/collections";
import { formatMoney } from "@/components/money";
import { GoalForm } from "@/components/goal-form";
import { GoalDonut } from "@/components/goal-donut";
import { GoalProjectionChart, type GoalProjectionPoint } from "@/components/goal-projection-chart";
import { AppShell, Eyebrow } from "@/components/app-layout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";

type ProjectionResponse = {
  baseCurrency: string;
  goal: { id: string; name: string; term: "short" | "long"; targetDate: string; currency: string };
  targetMinor: number;
  allocatedMinor: number;
  progressPct: number;
  requiredMonthlyMinor: number;
  onTrack: boolean;
  aheadByMinor: number;
  series: GoalProjectionPoint[];
};

async function fetchProjection(id: string): Promise<ProjectionResponse> {
  const { data, error } = await api.goals({ id }).projection.get({ query: { historyMonths: 12 } });
  if (error) throw new Error(String(error));
  return data as unknown as ProjectionResponse;
}

export function GoalDetailPage() {
  const { id } = useParams({ from: "/goals/$id" });
  const nav = useNavigate();
  const [editOpen, setEditOpen] = useState(false);

  const { data: rows = [] } = useLiveQuery(goalsCollection);
  const row = rows.find((g) => g.id === id);

  const projQ = useQuery({
    queryKey: ["goals", "projection", id, row?.targetAmountMinor, row?.targetDate],
    queryFn: () => fetchProjection(id),
  });
  const p = projQ.data;
  const base = p?.baseCurrency ?? "";

  return (
    <AppShell
      actions={
        <Link to="/goals">
          <Button variant="ghost" size="sm">← Goals</Button>
        </Link>
      }
    >
      {!p ? (
        <div className="h-[420px] animate-pulse rounded-2xl bg-muted/40" />
      ) : (
        <>
          <div className="mb-6 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <Eyebrow className="mb-2">{p.goal.term === "short" ? "Short term" : "Long term"}</Eyebrow>
              <h1 className="font-heading text-3xl tracking-tight">{p.goal.name}</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {formatMoney(p.targetMinor, base)} by {p.goal.targetDate}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Badge variant={p.onTrack ? "default" : "destructive"}>
                {p.onTrack ? "On track" : "Behind"}
              </Badge>
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Goal actions" />}>
                  ⋮
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => setEditOpen(true)}>Edit</DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-destructive"
                    onClick={async () => {
                      goalsCollection.delete(id);
                      await nav({ to: "/goals" });
                    }}
                  >
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              {row && (
                <GoalForm goal={row} defaultCurrency={base || undefined} open={editOpen} onOpenChange={setEditOpen} hideTrigger />
              )}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-[220px_1fr]">
            <section className="rounded-2xl border border-border bg-card p-4">
              <GoalDonut allocatedMinor={p.allocatedMinor} targetMinor={p.targetMinor} progressPct={p.progressPct} />
              <dl className="mt-3 space-y-1 text-sm tabular-nums">
                <div className="flex justify-between"><dt className="text-muted-foreground">Allocated</dt><dd>{formatMoney(p.allocatedMinor, base)}</dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">Target</dt><dd>{formatMoney(p.targetMinor, base)}</dd></div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Required</dt>
                  <dd>{p.requiredMonthlyMinor > 0 ? `${formatMoney(p.requiredMonthlyMinor, base)}/mo` : "—"}</dd>
                </div>
              </dl>
            </section>

            <section className="rounded-2xl border border-border bg-card px-4 py-4 md:px-6 md:py-5">
              <Eyebrow className="mb-3">Projection</Eyebrow>
              <GoalProjectionChart
                series={p.series}
                targetMinor={p.targetMinor}
                targetDate={p.goal.targetDate}
                baseCurrency={base}
              />
            </section>
          </div>
        </>
      )}
    </AppShell>
  );
}
```

> The projection query key includes `row?.targetAmountMinor`/`targetDate` so an edit refetches the chart. `row` (live collection row) drives the Edit dialog + optimistic delete; the projection response drives the chart/stats.

- [ ] **Step 4: Register the route**

In `apps/web/src/router.tsx`:

Add the import (after the `GoalsPage` import):

```ts
import { GoalDetailPage } from "./routes/goal-detail";
```

Add the route definition (after the existing `goalsRoute`):

```ts
const goalDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/goals/$id",
  component: GoalDetailPage,
  beforeLoad: requireInitializedAndAuthed,
});
```

Add `goalDetailRoute` to the `rootRoute.addChildren([...])` array (after `goalsRoute`).

- [ ] **Step 5: Verify build**

Run: `cd apps/web && bunx tsc -b`
Expected: no type errors.

Manual: click a goal on `/goals` → lands on `/goals/$id`; donut shows progress %, the projection chart shows a rising actual line into today, then on-plan (dashed) above eligible toward the target line; Edit (kebab) opens the dialog; Delete returns to `/goals`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/goal-donut.tsx apps/web/src/components/goal-projection-chart.tsx apps/web/src/routes/goal-detail.tsx apps/web/src/router.tsx
git commit -m "feat(web): goal detail page — donut + projection chart"
```

---

## Task 6: Full verification

- [ ] **Step 1: Run the API + shared suites**

Run: `cd packages/shared && bun test` then `cd apps/api && bun test`
Expected: all green (existing + new goalProjection lib test + projection route test).

- [ ] **Step 2: Type-check the web app**

Run: `cd apps/web && bunx tsc -b`
Expected: no errors.

- [ ] **Step 3: Manual end-to-end**

The dev stack hot-reloads. In the browser: open `/goals`, click into a goal, confirm the donut + projection chart render and the kebab Edit/Delete work on both the list and the detail header.

---

## Self-review notes (coverage vs spec)

- Spec §1 navigation + list (clickable cards, ⋮ kebab, controllable GoalForm) → Tasks 3, 4.
- Spec §2 detail contents (header, donut, projection chart with past actual + future on-plan/eligible + target line/marker) → Task 5 (+ Tasks 1–2 for data).
- Spec §3 endpoint `GET /goals/:id/projection` + `goalProjection`, 404, point-bounding, history default 12 → Tasks 1, 2.
- Spec §4 architecture (server-side math over shared engine, reuse helpers) → Task 1 reuses `yearOf`/`monthsBetween`/`targetInBaseMinor`/`toAllocAccounts` and the shared engine; no `as any`.
- Spec §5 testing → Task 1 (lib test: past/today/future shape, on-plan>eligible, final point at target), Task 2 (route 200 + 404); web via `tsc` + manual.
- Spec §6 out-of-scope respected (no detail-page assumption editing; single eligible line; no global-curve goal markers).
- **Deviation:** the on-plan line reuses the analysis's `requiredMonthly` (per-account-annual projected gap) rather than a monthly-consistent re-solve, so it may not land *exactly* on target — intentional per spec §2 ("small drift … acceptable and not surfaced") to keep one required-contribution figure across list + detail.
```
