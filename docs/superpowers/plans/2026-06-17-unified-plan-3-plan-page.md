# Unified Plan — Plan 3: the `/plan` page (goals + projections unified UI)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge `/goals` + `/projections` into one **`/plan`** page (Layout A: net-worth curve with goal markers → goals priority list → accounts), give the goal form **account assignment + a contribution-account picker + drag-to-reorder priority**, and redirect the old routes. This is the user-facing payoff of the redesign.

**Architecture:** A new `PlanPage` composes the existing `ProjectionChart` (now with goal markers), a goals priority list (extracted into a reusable `GoalsList` with `@dnd-kit` reorder persisting `sortOrder`), and the existing `ProjectionAccounts` (vessels) + the assumptions/members controls. The goal form gains an account-assignment multiselect (eligible by owner scope) and a `contributionAccountId` select, persisting assignment via `PUT /goals/:id/accounts`. `/goals` and `/projections` redirect to `/plan`; `/goals/$id` (detail) stays. Backend is unchanged except a tiny ordering tidy.

**Tech Stack:** React, TanStack Router/Query/DB, `@dnd-kit`, shadcn/base-ui, Eden treaty, `@uang/shared`.

**Spec:** `docs/superpowers/specs/2026-06-17-unified-plan-goals-projections-design.md` · **Predecessors:** Plans 1 & 2 (merged).

---

## File structure

- `apps/api/src/lib/goals.ts` — tiny: sort `loadAssignments` output for stable chip order (Plan-1 review follow-up).
- `apps/web/src/lib/collections.ts` — forward `contributionAccountId` in the goals collection `onInsert`/`onUpdate`.
- `apps/web/src/components/goal-form.tsx` — account-assignment multiselect + `contributionAccountId` select + persist assignment on create/edit.
- `apps/web/src/components/goals-list.tsx` (new) — extracted goal cards + `@dnd-kit` reorder (persists `sortOrder`). Consumes the analysis query.
- `apps/web/src/routes/goals.tsx` — slim to re-export / or delete (route redirects); keep `GoalCard`/`GoalDonut` usage moving into `goals-list.tsx`.
- `apps/web/src/routes/plan.tsx` (new) — `PlanPage` (Layout A).
- `apps/web/src/components/projection-chart.tsx` — add goal target-date marker reference lines (colored by on-track).
- `apps/web/src/router.tsx` — add `/plan`; redirect `/goals` + `/projections` → `/plan`; keep `/goals/$id`.
- `apps/web/src/components/nav-main.tsx` — replace Goals + Projections with one **Plan** entry.
- `e2e/tests/plan.spec.ts` (new) + update specs that navigate to `/goals`/`/projections`.

---

## Task 1: Persist `contributionAccountId` + stable assignment order

**Files:** `apps/web/src/lib/collections.ts`, `apps/api/src/lib/goals.ts`

- [ ] **Step 1: Forward `contributionAccountId` in the goals collection**

In `apps/web/src/lib/collections.ts`, the `goalsCollection` `onInsert` calls `api.goals.post({...})` (~line 364) and `onUpdate` calls `api.goals({ id: m.id }).patch({...})` (~line 383). Both currently send `monthlyContributionMinor`, `spendType`, etc. but NOT `contributionAccountId`. Add to BOTH payloads (next to `monthlyContributionMinor`):

```ts
        contributionAccountId: m.contributionAccountId,
```

(`m` is the goal row; `GoalRow` already includes `contributionAccountId` from the API type.)

- [ ] **Step 2: Stable assignment order (Plan-1 review follow-up)**

In `apps/api/src/lib/goals.ts`, `loadAssignments()` builds `Map<goalId, accountId[]>` in DB-scan order. Sort each list for deterministic chip order. After the loop that fills `byGoal`, before `return byGoal;`, add:

```ts
  for (const arr of byGoal.values()) arr.sort();
```

- [ ] **Step 3: Verify**

Run: `cd apps/api && bun test src/lib/goals.test.ts src/routes/goals.test.ts` → green. `cd apps/web && bun run build` → success.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/collections.ts apps/api/src/lib/goals.ts
git commit -m "feat(web): persist goal contributionAccountId; stable assignment order"
```

---

## Task 2: Goal form — account assignment + contribution-account picker

**Files:** `apps/web/src/components/goal-form.tsx`

Context: the goal form already has name/target/date/monthly-contribution/spend. Add (a) a multiselect of **eligible accounts** (assets the goal may draw from), (b) a `contributionAccountId` select limited to the selected accounts, and persist the assignment via `PUT /goals/:id/accounts` after the goal is created/updated. On open (edit), seed the selection from the analysis (`accountIds`) for this goal.

- [ ] **Step 1: Read current assignment + accounts**

At the top of `GoalForm`, pull the accounts list and (for edit) the goal's current assignment:

```ts
import { accountsCollection } from "@/lib/collections";
import { api } from "@/lib/api";
// ...
const { data: accounts = [] } = useLiveQuery(accountsCollection);
// Eligible = asset accounts whose owner scope matches the goal scope.
// Goals here are household scope (the form sets ownerScope "household"),
// so all asset accounts are eligible. (Scope-aware filtering is future work.)
const eligible = accounts.filter((a) => a.class === "asset" && a.isArchived === 0);
```

Add form state for the selected account ids and the contribution account. Since these aren't simple register fields, hold them in `useState` seeded on open:

```ts
const [accountIds, setAccountIds] = useState<string[]>([]);
const [contributionAccountId, setContributionAccountId] = useState<string | null>(null);
```

In the `useEffect` that re-seeds on open, seed them. For edit, fetch the goal's assignment from the analysis endpoint (it returns `accountIds` + `contributionAccountId` per goal):

```ts
useEffect(() => {
  if (!open) return;
  reset(defaults());
  setError(null);
  if (goal) {
    setContributionAccountId(goal.contributionAccountId ?? null);
    // Seed assigned accounts from analysis (authoritative source of the join rows).
    api.goals.analysis.get().then(({ data }) => {
      const row = (data as unknown as { goals: Array<{ id: string; accountIds: string[] }> } | null)
        ?.goals.find((g) => g.id === goal.id);
      setAccountIds(row?.accountIds ?? []);
    });
  } else {
    setAccountIds([]);
    setContributionAccountId(null);
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [open]);
```

- [ ] **Step 2: Render the assignment UI**

Add a section (after the spend block, before the error line). A simple checkbox list of eligible accounts + a `contributionAccountId` Select limited to chosen accounts:

```tsx
<div className="space-y-2 border-t border-border/70 pt-4">
  <Field label="Funded by">
    <div className="flex flex-col gap-1.5">
      {eligible.length === 0 && (
        <p className="text-sm text-muted-foreground">No asset accounts yet.</p>
      )}
      {eligible.map((a) => {
        const checked = accountIds.includes(a.id);
        return (
          <label key={a.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => {
                setAccountIds((prev) => {
                  const next = e.target.checked ? [...prev, a.id] : prev.filter((id) => id !== a.id);
                  // keep contributionAccountId valid
                  if (!next.includes(contributionAccountId ?? "")) setContributionAccountId(next[0] ?? null);
                  return next;
                });
              }}
            />
            <span>{a.name}</span>
          </label>
        );
      })}
    </div>
  </Field>
  {accountIds.length > 0 && (
    <Field label="Monthly contribution lands in">
      <Select
        value={contributionAccountId ?? accountIds[0]}
        onValueChange={(v) => v && setContributionAccountId(v)}
      >
        <SelectTrigger><SelectValue>{(v: unknown) =>
          eligible.find((a) => a.id === String(v))?.name ?? "—"
        }</SelectValue></SelectTrigger>
        <SelectContent>
          {accountIds.map((id) => (
            <SelectItem key={id} value={id}>{eligible.find((a) => a.id === id)?.name ?? id}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )}
</div>
```

- [ ] **Step 3: Persist assignment on submit**

In `onSubmit`, after the `goalsCollection.insert(...)`/`update(...)` call resolves, write the assignment via the API and set `contributionAccountId` on the row. The insert/update already persist goal columns; add `contributionAccountId` to the object built for insert/update (replace the existing `contributionAccountId: null` on insert with the state value, and set it on update). Then call the assignment route. Because `goalsCollection.insert` is optimistic/sync, capture the id:

```ts
const goalId = editing ? goal!.id : newId();
// ...build payload with contributionAccountId: contributionAccountId...
// insert uses id: goalId; update uses goal!.id
// after the collection write:
await api.goals({ id: goalId }).accounts.put({ accountIds });
```

For the create branch, use `goalId` as the inserted `id` (the collection already supports a client-supplied id — `newId()` is used today). For edit, `goal!.id`. Make `onSubmit` async (it already can be). Keep the existing spend/target-date validation.

- [ ] **Step 4: Verify**

`cd apps/web && bun run build` → success (no `as any` beyond the existing `data as unknown as X` convention). Manually reason: creating a goal with 2 accounts then reopening edit shows them checked.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/goal-form.tsx
git commit -m "feat(web): goal form — assign funding accounts + contribution account"
```

---

## Task 3: Extract `GoalsList` with drag-to-reorder priority

**Files:** `apps/web/src/components/goals-list.tsx` (new), `apps/web/src/routes/goals.tsx`

- [ ] **Step 1: Create `goals-list.tsx`**

Move the goal-card rendering out of `routes/goals.tsx` into a reusable `GoalsList` component. It owns: the `goalsCollection` live query, the `["goals","analysis"]` query (same `fetchAnalysis` as today), the priority ordering, the cards (donut + badge + progress + funding pills), and the empty state + "New goal" trigger. Copy the existing `GoalCard` + `GoalsPage` body from `routes/goals.tsx` verbatim into `goals-list.tsx`, exporting `export function GoalsList()` (drop the `AppShell`/`PageHeader` wrapper — `PlanPage` provides layout). Keep `data-testid="goal-card"`.

- [ ] **Step 2: Add @dnd-kit reorder**

Wrap the list in a `DndContext` + `SortableContext` (mirror the pattern in `apps/web/src/components/dashboard-section.tsx`: `PointerSensor`, `closestCenter`, `arrayMove`, `useSortable` per card with a drag handle). On drag end, compute the new order and persist each goal's new index as `sortOrder` via `goalsCollection.update(id, (d) => { d.sortOrder = i; })`. Because `analyzeGoals` orders by `sortOrder` (Plan 1) and `allocateGoals` uses `priority = sortOrder`, reordering re-runs allocation; invalidate `["goals","analysis"]` after the updates (or rely on the content-signature refetch already in the page). Show a grip handle (`GripVertical` from lucide) on each card.

```tsx
function onDragEnd(e: DragEndEvent) {
  const { active, over } = e;
  if (!over || active.id === over.id) return;
  const ids = ordered.map((g) => g.id);
  const next = arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)));
  next.forEach((id, i) => goalsCollection.update(id, (d) => { d.sortOrder = i; }));
}
```

- [ ] **Step 3: Verify**

`cd apps/web && bun run build` → success.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/goals-list.tsx apps/web/src/routes/goals.tsx
git commit -m "feat(web): extract GoalsList with drag-to-reorder priority"
```

---

## Task 4: Goal markers on the projection chart

**Files:** `apps/web/src/components/projection-chart.tsx`

- [ ] **Step 1: Add target-date reference lines**

`ProjectionChart` already fetches goal analysis (`goalsQ`). Build markers from goals with a `targetDate` within the chart's year range, colored by status (`onTrack === false` → destructive; else primary). Add inside the `useMemo` return and render `ReferenceLine`s (reuse the existing `MilestoneLabel` pattern, or a simpler label):

```ts
const goalMarkers = goalRows
  .filter((g) => g.targetDate)
  .map((g) => ({ year: parseInt(g.targetDate!.slice(0, 10), 10), name: g.name, behind: g.onTrack === false }))
  .filter((m) => m.year >= thisYear && m.year <= (rows.at(-1)?.year ?? thisYear));
```

Render each as a vertical `ReferenceLine x={m.year}` stroked `var(--destructive)` when `behind` else `var(--primary)`, dashed, with a small label of `m.name`. Place after the milestone lines. Ensure `goalMarkers` is returned from the `useMemo` and consumed in JSX.

- [ ] **Step 2: Verify + commit**

`cd apps/web && bun run build` → success.
```bash
git add apps/web/src/components/projection-chart.tsx
git commit -m "feat(web): goal target-date markers on the projection curve"
```

---

## Task 5: The `/plan` page + routing + nav

**Files:** `apps/web/src/routes/plan.tsx` (new), `apps/web/src/router.tsx`, `apps/web/src/components/nav-main.tsx`

- [ ] **Step 1: Create `PlanPage` (Layout A)**

Create `apps/web/src/routes/plan.tsx`. Compose, in order: net-worth chart, goals, accounts, then the assumptions + member-birth-years controls (moved from `projections.tsx` — copy `ProjectionAssumptionsSection` + `MembersSection` into `plan.tsx` or import them; simplest: copy them, then delete `projections.tsx` in Step 3). Reuse `ProjectionChart`, `GoalsList`, `ProjectionAccounts`.

```tsx
import { ProjectionChart } from "@/components/projection-chart";
import { GoalsList } from "@/components/goals-list";
import { ProjectionAccounts } from "@/components/projection-accounts";
import { AppShell, Section } from "@/components/app-layout";
import { PageHeader } from "@/components/page-header";
// + MembersSection + ProjectionAssumptionsSection (copied from projections.tsx)

export function PlanPage() {
  return (
    <AppShell>
      <PageHeader title="Plan" description="Your net worth over time, the goals it funds, and the accounts behind them." />
      <div className="space-y-6">
        <ProjectionChart />
        <section>
          <h2 className="mb-3 font-heading text-lg">Goals</h2>
          <GoalsList />
        </section>
        <section>
          <h2 className="mb-3 font-heading text-lg">Accounts</h2>
          <ProjectionAccounts />
        </section>
        <div className="grid gap-5 md:grid-cols-2">
          <MembersSection />
          <ProjectionAssumptionsSection />
        </div>
      </div>
    </AppShell>
  );
}
```

- [ ] **Step 2: Wire the route + redirects**

In `apps/web/src/router.tsx`: import `PlanPage`. Add a `planRoute` (`path: "/plan"`, parent `appLayoutRoute`, `component: PlanPage`). Change `projectionsRoute` and `goalsRoute` to redirect: replace their `component` with a `beforeLoad: () => { throw redirect({ to: "/plan" }); }` (keep the route objects so old links/bookmarks resolve), OR remove them and add redirect routes. Keep `goalDetailRoute` (`/goals/$id`) intact. Add `planRoute` to `appLayoutRoute.addChildren([...])`.

```ts
const planRoute = createRoute({ getParentRoute: () => appLayoutRoute, path: "/plan", component: PlanPage });
const goalsRedirect = createRoute({ getParentRoute: () => appLayoutRoute, path: "/goals", beforeLoad: () => { throw redirect({ to: "/plan" }); } });
const projectionsRedirect = createRoute({ getParentRoute: () => appLayoutRoute, path: "/projections", beforeLoad: () => { throw redirect({ to: "/plan" }); } });
```
Replace `projectionsRoute`/`goalsRoute` with these redirect routes in the children array, add `planRoute`, keep `goalDetailRoute`. Remove now-unused `ProjectionsPage`/`GoalsPage` imports if those files are deleted (Step 3).

- [ ] **Step 3: Delete the superseded pages**

Delete `apps/web/src/routes/projections.tsx` and slim `apps/web/src/routes/goals.tsx` (its body moved to `goals-list.tsx`; the route now redirects, so the `GoalsPage` export is unused — delete the file and remove its import). Ensure `goal-detail.tsx` still imports what it needs (it uses `GoalProjectionChart`/`GoalDonut`, not `GoalsPage`).

- [ ] **Step 4: Single "Plan" nav entry**

In `apps/web/src/components/nav-main.tsx`, replace the two entries `{ to: "/goals", label: "Goals", ... }` and `{ to: "/projections", label: "Projections", ... }` with one:

```ts
  { to: "/plan", label: "Plan", icon: TrendingUp },
```
(Drop the now-unused `Target` import if nothing else uses it.)

- [ ] **Step 5: Verify + commit**

`cd apps/web && bun run build` → success. Manually: `/goals` and `/projections` redirect to `/plan`; `/plan` renders chart + goals + accounts; `/goals/$id` still works.
```bash
git add apps/web/src/routes/plan.tsx apps/web/src/router.tsx apps/web/src/components/nav-main.tsx
git rm apps/web/src/routes/projections.tsx
git add apps/web/src/routes/goals.tsx
git commit -m "feat(web): unified /plan page; redirect /goals and /projections"
```

---

## Task 6: E2E + verification

**Files:** `e2e/tests/plan.spec.ts` (new); update specs referencing `/goals` or `/projections`.

- [ ] **Step 1: Update existing specs**

Grep `e2e/` for `/goals`, `/projections`, `"Goals"`, `"Projections"` nav clicks. Repoint navigation to `/plan` (e.g. `sidebar.spec.ts` if it asserts the nav items). Goal CRUD that lived under `/goals` now happens on `/plan`.

- [ ] **Step 2: Write `plan.spec.ts`**

A journey: seed household + an asset account; go to `/plan`; create a goal via the form, assigning the seeded account (check its box) and a target date; assert the goal card appears funded (donut/progress) and the account shows under Accounts; assert the projection chart (`data-testid="projection-chart"`) renders. Use the existing seed helpers + `data-testid` anchors (`goal-card`, `projection-chart`); add testids in the new components where needed (e.g. an account checkbox `data-testid={`assign-${a.id}`}`).

- [ ] **Step 3: Run affected e2e**

Run: `bun run e2e -- plan.spec.ts smoke.spec.ts sidebar.spec.ts accounts.spec.ts` → green (allow the documented one-retry cold-compile flake).

- [ ] **Step 4: Full verification + commit**

`cd packages/shared && bun test` ; `cd apps/api && bun test src/lib/goals.test.ts src/routes/goals.test.ts src/routes/accounts.test.ts` ; `cd apps/web && bun run build` — all green.
```bash
git add e2e
git commit -m "test(e2e): /plan journey; repoint nav specs"
```

---

## Self-review notes

- **Spec coverage:** unified `/plan` (Layout A) ✓, account assignment + contribution picker ✓, drag-reorder priority ✓, goal markers on the curve ✓, redirects + single nav ✓. Backend already done in Plans 1–2.
- **Reuse:** `ProjectionChart`, `ProjectionAccounts`, `GoalDonut`, `GoalProjectionChart`, the `@dnd-kit` pattern from `dashboard-section.tsx`, and the analysis query are all reused — minimal new surface.
- **Deferred:** scope-aware account eligibility in the form (household-only today); the per-account *accessible* payout approximation from Plan 2; combined-flow goal test from Plan 2.
- **Risk:** the goal form now does an async API call (`PUT /goals/:id/accounts`) in addition to the optimistic collection write — order matters (write goal first so the id exists, then assignment). Covered in Task 2 Step 3.
