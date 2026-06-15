# UI Standardization & Dashboard Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Standardize the app's forms, buttons, page headers, and navigation, add an app-wide value-privacy toggle, and redesign the dashboard top with a bespoke hero plus a configurable, per-household tile system.

**Architecture:** Four phases, each shippable on its own. Phase 1 (privacy) introduces a `<Money>` component + React context so a single switch masks every monetary value. Phase 2 (standards) adds shared `<Field>` and `<PageHeader>` primitives and applies form/button/header conventions. Phase 3 (tiles backend) adds a `dashboardTiles` JSON column on the singleton `settings` row plus a pure tile registry. Phase 4 (dashboard UI) composes the new hero, the configurable tiles with an edit mode, and relocates the owner toggle and "Add account" control.

**Tech Stack:** Bun, Elysia + Drizzle (libsql/SQLite), React + TanStack Router/Query/DB, Eden treaty for end-to-end types, Tailwind v4 + shadcn (base-ui), `@dnd-kit` for drag-reorder, `bun test` for API/shared unit tests, Playwright (`e2e/`) for integration.

---

## Spec reconciliation (read before starting)

These facts were verified against the codebase and differ from or sharpen the spec:

1. **`settings` is a singleton row keyed by `id = 1`** (`apps/api/src/db/schema.ts:3`). There is no `householdId`. The app is single-household, so "per-household" persistence = storing on this singleton row. Phase 3 adds a `dashboard_tiles` text column there.
2. **Money is rendered by a pure function** `formatMoney(minor, currency)` in `apps/web/src/components/money.ts`. A pure function cannot read React context, so masking is delivered by a new `<Money minor currency />` component (Phase 1) that wraps `formatMoney`. Call sites that render money in JSX switch to `<Money>`; call sites that need a string (chart tooltips, concatenated subtitles) call a new `useMoney()` formatter from context.
3. **Networth already exposes everything the now-available tiles need:** `AccountValuation` (`apps/api/src/lib/valuation.ts:50`) includes `class`, `illiquid` (boolean), and `baseMinor`. The net-worth series route returns `{ baseCurrency, points: [{date,totalBaseMinor}] }`. Period change is derivable client-side. **No networth API change is required.**
4. **Goals "on track" count** comes from `GET /goals/analysis` → `overall: { onTrack, behindCount }` and per-goal `onTrack` (`apps/api/src/lib/goals.ts`). The "Goals on track" tile uses `goals.length` and the count of `onTrack` goals.
5. **There is no web unit-test runner** (no vitest/testing-library). Pure-logic `*.test.ts` files (no JSX) run under root `bun test`. Visual/integration behavior is verified with Playwright e2e in `e2e/tests/`. Component/visual-only changes use manual verification steps.
6. **`account-info-card.tsx` already has a local `Field`** (uppercase label, `gap-1.5`) that already satisfies the label↔input spacing standard. Leave it as-is; the new shared `<Field>` is for dialog/route forms.
7. **Button default size is already `h-8`** (`apps/web/src/components/ui/button.tsx`). The button task is mostly about retiring ad-hoc `size="sm"` on primary/danger actions and adding Cancel buttons to dialogs — not changing the default.

---

## File structure

**New files:**
- `apps/web/src/lib/values-hidden.tsx` — `ValuesHiddenProvider`, `useValuesHidden()` (localStorage-backed), `useMoney()` formatter.
- `apps/web/src/components/money.tsx` — `<Money>` component (re-exports `formatMoney` from `money.ts`).
- `apps/web/src/components/ui/field.tsx` — shared `<Field>` wrapper.
- `apps/web/src/components/page-header.tsx` — shared `<PageHeader>`.
- `apps/web/src/components/dashboard-hero.tsx` — bespoke dashboard hero.
- `apps/web/src/lib/dashboard-tiles/registry.ts` — pure tile registry (`TILE_REGISTRY`, `TileData`, `isAvailable`, `value`).
- `apps/web/src/lib/dashboard-tiles/registry.test.ts` — unit tests for the registry (runs under `bun test`).
- `apps/web/src/components/dashboard-tiles/dashboard-tiles.tsx` — tiles renderer + edit mode.
- `apps/web/src/lib/values-hidden.test.ts` — unit tests for the masking helper.

**Modified files (by phase):**
- Phase 1: `apps/web/src/components/money.ts` (keep), `router.tsx` (provider + top-bar eye toggle), money call sites across routes/components.
- Phase 2: every form in §5, every header in §7, `apps/web/src/components/app-breadcrumb.tsx`, dialogs needing Cancel.
- Phase 3: `apps/api/src/db/schema.ts`, new Drizzle migration, `apps/api/src/routes/settings.ts`, `apps/api/src/routes/settings.test.ts`.
- Phase 4: `apps/web/src/routes/dashboard.tsx`, `apps/web/src/components/dashboard-section.tsx`, `apps/web/src/components/net-worth-chart.tsx`, `apps/web/src/components/net-worth-toggle.tsx`, `apps/web/src/components/app-layout.tsx` (AppShell actions).

---

# Phase 1 — App-wide value privacy

**Outcome:** A single eye toggle in the top bar hides every monetary value (masked as `••••••`), persisted per-device in `localStorage`. Ships independently.

### Task 1.1: Masking helper + unit test

**Files:**
- Create: `apps/web/src/lib/values-hidden.test.ts`
- Create: `apps/web/src/lib/values-hidden.tsx`

- [ ] **Step 1: Write the failing test**

`apps/web/src/lib/values-hidden.test.ts`:
```ts
import { expect, test } from "bun:test";
import { MASK, maskMoney } from "./values-hidden";

test("maskMoney returns the formatted value when not hidden", () => {
  expect(maskMoney("£284,910", false)).toBe("£284,910");
});

test("maskMoney returns the mask placeholder when hidden", () => {
  expect(maskMoney("£284,910", true)).toBe(MASK);
});

test("MASK is a fixed bullet placeholder, independent of value length", () => {
  expect(maskMoney("£1", true)).toBe(MASK);
  expect(maskMoney("£1,234,567.89", true)).toBe(MASK);
  expect(MASK).toBe("••••••");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/web/src/lib/values-hidden.test.ts`
Expected: FAIL — `Cannot find module './values-hidden'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/web/src/lib/values-hidden.tsx` with the pure helper first (provider/hooks added in the next task):
```tsx
export const MASK = "••••••";

// Pure masking gate: returns the placeholder when values are hidden,
// otherwise the already-formatted money string. Kept pure + JSX-free so it
// is unit-testable under `bun test`.
export function maskMoney(formatted: string, hidden: boolean): string {
  return hidden ? MASK : formatted;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/web/src/lib/values-hidden.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/values-hidden.tsx apps/web/src/lib/values-hidden.test.ts
git commit -m "feat(web): add maskMoney privacy helper"
```

### Task 1.2: Context provider + hooks

**Files:**
- Modify: `apps/web/src/lib/values-hidden.tsx`

- [ ] **Step 1: Add the provider, the boolean hook, and the formatter hook**

Append to `apps/web/src/lib/values-hidden.tsx` (keep `MASK`/`maskMoney` from Task 1.1):
```tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { formatMoney } from "@/components/money";

const STORAGE_KEY = "uang.valuesHidden";

type ValuesHiddenContextValue = {
  hidden: boolean;
  toggle: () => void;
  setHidden: (v: boolean) => void;
};

const ValuesHiddenContext = createContext<ValuesHiddenContextValue | null>(null);

function readInitial(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(STORAGE_KEY) === "1";
}

export function ValuesHiddenProvider({ children }: { children: React.ReactNode }) {
  const [hidden, setHidden] = useState<boolean>(readInitial);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, hidden ? "1" : "0");
  }, [hidden]);

  const toggle = useCallback(() => setHidden((h) => !h), []);
  const value = useMemo(() => ({ hidden, toggle, setHidden }), [hidden, toggle]);

  return <ValuesHiddenContext.Provider value={value}>{children}</ValuesHiddenContext.Provider>;
}

export function useValuesHidden(): ValuesHiddenContextValue {
  const ctx = useContext(ValuesHiddenContext);
  if (!ctx) throw new Error("useValuesHidden must be used within ValuesHiddenProvider");
  return ctx;
}

// String formatter for non-JSX call sites (chart tooltips, concatenated
// subtitles). Honors the privacy toggle.
export function useMoney(): (minor: number, currency: string) => string {
  const { hidden } = useValuesHidden();
  return useCallback(
    (minor: number, currency: string) => maskMoney(formatMoney(minor, currency), hidden),
    [hidden],
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `bun --cwd apps/web run build`
Expected: PASS (TypeScript clean). If `formatMoney` import path errors, confirm `@/components/money` resolves to `apps/web/src/components/money.ts` (it does per tsconfig `@/*` alias).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/values-hidden.tsx
git commit -m "feat(web): values-hidden context + useMoney formatter"
```

### Task 1.3: `<Money>` component

**Files:**
- Create: `apps/web/src/components/money.tsx`
- Keep: `apps/web/src/components/money.ts` (unchanged — `<Money>` re-exports its `formatMoney`)

- [ ] **Step 1: Create the component**

`apps/web/src/components/money.tsx`:
```tsx
import { formatMoney } from "./money";
import { maskMoney, useValuesHidden } from "@/lib/values-hidden";

export { formatMoney } from "./money";

// Renders an integer minor-unit amount as currency, honoring the app-wide
// value-privacy toggle. Use this everywhere money is shown in JSX.
export function Money({ minor, currency }: { minor: number; currency: string }) {
  const { hidden } = useValuesHidden();
  return <span className="tabular-nums">{maskMoney(formatMoney(minor, currency), hidden)}</span>;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `bun --cwd apps/web run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/money.tsx
git commit -m "feat(web): <Money> component honoring privacy toggle"
```

### Task 1.4: Mount provider + top-bar eye toggle

**Files:**
- Modify: `apps/web/src/router.tsx:29-48` (wrap layout in provider, add toggle button to the sticky header)

- [ ] **Step 1: Wrap the app layout in `ValuesHiddenProvider` and add the toggle**

In `apps/web/src/router.tsx`, update the `appLayoutRoute` component. Add imports at the top of the file:
```tsx
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ValuesHiddenProvider, useValuesHidden } from "@/lib/values-hidden";
```

Add a small toggle component near the layout component definition:
```tsx
function ValuePrivacyToggle() {
  const { hidden, toggle } = useValuesHidden();
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      onClick={toggle}
      aria-pressed={hidden}
      aria-label={hidden ? "Show values" : "Hide values"}
      title={hidden ? "Show values" : "Hide values"}
    >
      {hidden ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
    </Button>
  );
}
```

Wrap the existing layout JSX in the provider and add the toggle to the right of the header. The current header is:
```tsx
<header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b border-border/70 bg-background/95 px-4 backdrop-blur">
  <SidebarTrigger className="-ml-1" />
  <Separator orientation="vertical" className="mr-1 h-4" />
  <AppBreadcrumb />
</header>
```
Change to (note the `ValuesHiddenProvider` wrapping `TooltipProvider`/`SidebarProvider`, and `ml-auto` toggle):
```tsx
<ValuesHiddenProvider>
  <TooltipProvider>
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b border-border/70 bg-background/95 px-4 backdrop-blur">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-1 h-4" />
          <AppBreadcrumb />
          <div className="ml-auto">
            <ValuePrivacyToggle />
          </div>
        </header>
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  </TooltipProvider>
</ValuesHiddenProvider>
```

- [ ] **Step 2: Verify it compiles**

Run: `bun --cwd apps/web run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/router.tsx
git commit -m "feat(web): mount values-hidden provider + top-bar eye toggle"
```

### Task 1.5: Route all money display through `<Money>` / `useMoney`

**Files (search-driven):** every site calling `formatMoney(...)` in JSX or building money strings. Find them with:
```bash
grep -rn "formatMoney(" apps/web/src --include=*.tsx
```
Known sites (from exploration): `routes/dashboard.tsx`, `routes/goals.tsx`, `routes/goal-detail.tsx`, `routes/account-detail.tsx`, `routes/projections.tsx`, `components/dashboard-section.tsx`, `components/net-worth-chart.tsx`, `components/account-info-card.tsx`.

- [ ] **Step 1: Replace JSX money with `<Money>`**

For each site that renders `{formatMoney(x, ccy)}` directly inside JSX, replace with `<Money minor={x} currency={ccy} />`. Example — `routes/account-detail.tsx:158`:
```tsx
// before
{posLoading || !pos ? "—" : formatMoney(pos.totalMinor, account.currency)}
// after
{posLoading || !pos ? "—" : <Money minor={pos.totalMinor} currency={account.currency} />}
```
Update each file's import from `import { formatMoney } from "@/components/money"` to `import { Money } from "@/components/money"` (the `.tsx` re-exports `formatMoney`, so mixed imports `import { Money, formatMoney } from "@/components/money"` also resolve).

- [ ] **Step 2: Replace string-context money with `useMoney()`**

For sites that need a string (e.g. `net-worth-chart.tsx` Recharts tooltip formatter, `goal-detail.tsx` subtitle `` `${formatMoney(...)} by ${...}` ``), call the hook at the top of the component:
```tsx
const money = useMoney();
// ...later, in a tooltip/template:
money(value, baseCurrency)
```
Import: `import { useMoney } from "@/lib/values-hidden"`.

- [ ] **Step 3: Verify no stray direct calls remain in display paths**

Run: `grep -rn "formatMoney(" apps/web/src --include=*.tsx`
Expected: remaining hits are only inside `components/money.tsx`/`money.ts` or non-display utilities. Every visible amount goes through `<Money>` or `useMoney`.

- [ ] **Step 4: Build**

Run: `bun --cwd apps/web run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): route all money display through privacy-aware Money/useMoney"
```

### Task 1.6: e2e — privacy toggle masks and persists

**Files:**
- Create: `e2e/tests/value-privacy.spec.ts`

- [ ] **Step 1: Write the e2e test (mirrors `e2e/tests/ownership.spec.ts` setup)**

`e2e/tests/value-privacy.spec.ts`:
```ts
import { test, expect } from "./fixtures";
import { seedHousehold, createAccount, addCashDeposit } from "./helpers";

test.beforeEach(async ({ backend, request, context }) => {
  await backend.freshDb();
  await seedHousehold(request, context, backend.apiURL);
});

test("eye toggle masks all values and persists across reload", async ({ page }) => {
  await page.goto("/");
  await createAccount(page, { name: "Checking", currency: "USD" });
  await page.getByTestId("account-row").filter({ hasText: "Checking" }).click();
  await addCashDeposit(page, 1000);
  await page.goto("/");

  const hero = page.getByTestId("networth-hero");
  await expect(hero).not.toHaveText("••••••");

  await page.getByRole("button", { name: "Hide values" }).click();
  await expect(hero).toHaveText("••••••");

  await page.reload();
  await expect(page.getByTestId("networth-hero")).toHaveText("••••••");
});
```

- [ ] **Step 2: Run the e2e test**

Run: `bun run --cwd e2e test value-privacy`
Expected: PASS. (If `addCashDeposit`/`createAccount` signatures differ, align with `e2e/tests/helpers.ts`.)

- [ ] **Step 3: Commit**

```bash
git add e2e/tests/value-privacy.spec.ts
git commit -m "test(e2e): value-privacy toggle masks and persists"
```

---

# Phase 2 — Form, button, and header standards

**Outcome:** Shared `<Field>` and `<PageHeader>` primitives; consistent form spacing (`space-y-4` bodies, `space-y-1.5` fields, `gap-4` grids); every dialog has a Cancel button; ad-hoc `sm` sizing retired from primary/danger actions; correct breadcrumb trails. Ships independently.

### Task 2.1: Shared `<Field>` component

**Files:**
- Create: `apps/web/src/components/ui/field.tsx`

- [ ] **Step 1: Create the component**

`apps/web/src/components/ui/field.tsx`:
```tsx
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

// Standard form field: 6px (space-y-1.5) gap between label, control, and an
// optional hint. Use in dialog and route forms.
export function Field({
  label,
  hint,
  htmlFor,
  className,
  children,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  htmlFor?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
```

- [ ] **Step 2: Build**

Run: `bun --cwd apps/web run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/ui/field.tsx
git commit -m "feat(web): shared <Field> form-field wrapper"
```

### Task 2.2: Apply `<Field>` + spacing standard to `account-form`

**Files:**
- Modify: `apps/web/src/components/account-form.tsx`

- [ ] **Step 1: Bump form body spacing and convert fields**

In `account-form.tsx`: change the form wrapper `className="space-y-3"` to `className="space-y-4"`, and change grid pairs `grid grid-cols-2 gap-3` to `grid grid-cols-2 gap-4`. Convert each `<div><Label>…</Label><Input…/></div>` to a `<Field>`. Example:
```tsx
// before
<div>
  <Label>Name</Label>
  <Input data-testid="account-name" value={f.name} onChange={(e) => set("name", e.target.value)} required />
</div>
// after
<Field label="Name">
  <Input data-testid="account-name" value={f.name} onChange={(e) => set("name", e.target.value)} required />
</Field>
```
For fields with helper text, move the `<p className="text-xs text-muted-foreground">…</p>` into the `hint` prop:
```tsx
<Field label="Type" hint="Assets grow your net worth; Liabilities reduce it.">
  <Select … />
</Field>
```
Add `import { Field } from "@/components/ui/field"`.

- [ ] **Step 2: Build + manual check**

Run: `bun --cwd apps/web run build` (PASS). Then run the app (`bun run web:dev`), open "Add account", confirm 6px label↔input gaps and even field spacing.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/account-form.tsx
git commit -m "refactor(web): account-form uses <Field> + space-y-4"
```

### Task 2.3: Apply `<Field>` + spacing to remaining forms

**Files:**
- Modify: `apps/web/src/components/goal-form.tsx`, `apps/web/src/routes/login.tsx`, `apps/web/src/routes/onboarding.tsx`, `apps/web/src/components/add-transaction-dialog.tsx`, and settings inline forms in `apps/web/src/routes/settings.tsx`.

- [ ] **Step 1: Convert each form using the same transformation as Task 2.2**

Apply identically per file:
- `goal-form.tsx`: form `space-y-3`→`space-y-4`; grids `gap-3`→`gap-4`; bare-div fields → `<Field>`. Keep section dividers (`border-t border-border/70 pt-3` → `pt-4`).
- `login.tsx`: `space-y-3`→`space-y-4`; Email/Password divs → `<Field label="Email">`, `<Field label="Password">`.
- `onboarding.tsx`: `space-y-3`→`space-y-4`; section break `pt-3`→`pt-4`; bare-div fields → `<Field>`.
- `add-transaction-dialog.tsx`: form `space-y-3`→`space-y-4`; grids `gap-3`→`gap-4`; bare-div fields → `<Field>`. Keep the bordered instrument sub-panel but switch its inner `gap-3`→`gap-4`.
- `settings.tsx`: inline forms — wrap each `<div><Label/><Input className="w-32"/></div>` in `<Field>` (keep the `w-32` on the `<Input>`); grid `gap-2`→`gap-4` where it pairs fields.

Add `import { Field } from "@/components/ui/field"` to each.

- [ ] **Step 2: Build + manual check**

Run: `bun --cwd apps/web run build` (PASS). Spot-check each form visually.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src
git commit -m "refactor(web): apply <Field> + space-y-4 to goal/login/onboarding/transaction/settings forms"
```

### Task 2.4: Dialog Cancel buttons + button standard

**Files:**
- Modify: every dialog footer — `account-form.tsx`, `goal-form.tsx`, `add-transaction-dialog.tsx`, and any other `DialogFooter` (find with `grep -rln "DialogFooter" apps/web/src`).

- [ ] **Step 1: Add explicit Cancel to each dialog footer**

The `DialogFooter` (`ui/dialog.tsx`) already right-aligns. Add a ghost Cancel before the primary action. The dialog is controlled by an `open`/`setOpen` state in each form. Example for `account-form.tsx`:
```tsx
// before
<DialogFooter>
  <Button type="submit">Create</Button>
</DialogFooter>
// after
<DialogFooter>
  <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
    Cancel
  </Button>
  <Button type="submit">Create</Button>
</DialogFooter>
```
Where a dialog uses `DialogClose`, prefer `<DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>`.

- [ ] **Step 2: Retire ad-hoc `sm` on primary/danger actions**

Run `grep -rn 'size="sm"' apps/web/src --include=*.tsx`. For primary actions and danger-zone (destructive) buttons that are NOT inside a dense table/inline row, remove `size="sm"` (defaults to `h-8`). Leave `size="sm"`/`xs` only on genuinely inline row actions (e.g. per-row buttons inside `dashboard-section.tsx` group rows). Ensure destructive actions use `variant="destructive"` at default size.

- [ ] **Step 3: Build + manual check**

Run: `bun --cwd apps/web run build` (PASS). Open each dialog, confirm Cancel closes without submitting and primary action still works.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src
git commit -m "refactor(web): add dialog Cancel buttons; retire ad-hoc sm on primary/danger"
```

### Task 2.5: Shared `<PageHeader>` component

**Files:**
- Create: `apps/web/src/components/page-header.tsx`

- [ ] **Step 1: Create the component (reusing existing `Eyebrow`)**

`apps/web/src/components/page-header.tsx`:
```tsx
import { Eyebrow } from "@/components/app-layout";

// Standard page header: optional eyebrow, Fraunces title, optional description,
// optional right-aligned actions slot. The dashboard intentionally does NOT use
// this — it keeps its bespoke hero.
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex items-start justify-between gap-3">
      <div className="min-w-0">
        {eyebrow && <Eyebrow className="mb-2">{eyebrow}</Eyebrow>}
        <h1 className="font-heading text-3xl tracking-tight">{title}</h1>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Build**

Run: `bun --cwd apps/web run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/page-header.tsx
git commit -m "feat(web): shared <PageHeader> component"
```

### Task 2.6: Adopt `<PageHeader>` on hand-rolled headers

**Files:**
- Modify: `apps/web/src/routes/goals.tsx`, `apps/web/src/routes/settings.tsx`, `apps/web/src/routes/projections.tsx`, `apps/web/src/routes/account-detail.tsx`, `apps/web/src/routes/goal-detail.tsx`.

- [ ] **Step 1: Replace each hand-rolled header**

- `goals.tsx` (current `<div className="mb-6 flex items-baseline justify-between"><h1>Goals</h1>…</div>`):
```tsx
<PageHeader
  title="Goals"
  actions={
    analysisQ.data && analysisQ.data.unallocatedMinor !== 0 ? (
      <span className="text-sm text-muted-foreground">
        Unallocated: <span className="font-medium tabular-nums text-foreground">
          <Money minor={analysisQ.data.unallocatedMinor} currency={base} />
        </span>
      </span>
    ) : undefined
  }
/>
```
- `projections.tsx`:
```tsx
<PageHeader title="Projections" description="Total vs accessible net worth over time, at your assumed growth rates." />
```
- `settings.tsx`: replace `<h1 className="mb-6 …">Settings</h1>` with `<PageHeader title="Settings" />`. Leave the local `Section` cards below untouched.
- `account-detail.tsx`: replace the `<header>` block with:
```tsx
<PageHeader
  eyebrow={`${classLabel(account.class)} · ${subtypeLabel(account.subtype)} · ${account.currency}`}
  title={account.name}
  description={
    posLoading || !pos ? "—" : <Money minor={pos.totalMinor} currency={account.currency} />
  }
/>
```
(Keep the missing-rate `<p className="text-sm text-destructive">` directly after, outside the header.)
- `goal-detail.tsx`: replace its header `<div className="mb-6 flex …">` with `<PageHeader>` passing `eyebrow`, `title={p.goal.name}`, `description` (the target/date subtitle using `<Money>`), and `actions={<><Badge…/><DropdownMenu>…</DropdownMenu></>}`.

Add `import { PageHeader } from "@/components/page-header"` to each.

- [ ] **Step 2: Build + manual check**

Run: `bun --cwd apps/web run build` (PASS). Visit each page; confirm headers render with consistent Fraunces title + eyebrow + actions.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src
git commit -m "refactor(web): adopt <PageHeader> on goals/settings/projections/account-detail/goal-detail"
```

### Task 2.7: Breadcrumb trails (navigation is breadcrumb-only)

**Files:**
- Modify: `apps/web/src/components/app-breadcrumb.tsx:22-32` (`crumbsFor`)

- [ ] **Step 1: Make the account-detail crumb show the real account name and a working parent link**

The current account crumb is `[{ label: "Dashboard", to: "/" }, { label: "Account" }]` (static). Improve it to use the account name, mirroring the goal pattern. Add an account lookup alongside the existing goal lookup:
```tsx
import { accountsCollection } from "@/lib/collections"; // confirm the export name used elsewhere
// inside AppBreadcrumb():
const accountId = accountIdFromPath(pathname); // add a small helper like goalIdFromPath
const { data: accounts = [] } = useLiveQuery(accountsCollection);
const accountName = accountId ? accounts.find((a) => a.id === accountId)?.name : undefined;
const crumbs = crumbsFor(pathname, goalName, accountName);
```
Add `accountIdFromPath` near `goalIdFromPath`:
```tsx
function accountIdFromPath(pathname: string): string | undefined {
  const m = pathname.match(/^\/accounts\/([^/]+)/);
  return m?.[1];
}
```
Update `crumbsFor` signature and the account branch:
```tsx
function crumbsFor(pathname: string, goalName?: string, accountName?: string): Crumb[] {
  // …unchanged branches…
  if (pathname.startsWith("/accounts/"))
    return [{ label: "Dashboard", to: "/" }, { label: accountName ?? "Account" }];
  // …
}
```
Verify the goal-detail crumb already links `Goals → /goals` (it does). No back buttons are added anywhere — breadcrumb is the only nav.

- [ ] **Step 2: Build + manual check**

Run: `bun --cwd apps/web run build` (PASS). Navigate to an account and a goal; confirm the trail shows the real name and the parent link works.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/app-breadcrumb.tsx
git commit -m "fix(web): account breadcrumb shows real name with working parent link"
```

---

# Phase 3 — Dashboard tiles backend

**Outcome:** A `dashboard_tiles` JSON column on `settings`, exposed and updatable via the settings route, plus a pure, tested tile registry. Ships independently of the UI.

### Task 3.1: Add `dashboardTiles` column + migration

**Files:**
- Modify: `apps/api/src/db/schema.ts:3-11` (settings table)
- Create: a generated migration under `apps/api/drizzle/`

- [ ] **Step 1: Add the column to the schema**

In `apps/api/src/db/schema.ts`, add to the `settings` table (store the ordered enabled tile-id list as a JSON string; default = the spec's default-shown set):
```ts
export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey(),
  householdName: text("household_name").notNull(),
  baseCurrency: text("base_currency").notNull(),
  contributionGrowthRateBps: integer("contribution_growth_rate_bps").notNull().default(800),
  projectionEndAge: integer("projection_end_age").notNull().default(90),
  // Ordered list of enabled dashboard tile ids, JSON-encoded. Per-household
  // (the singleton row). Default: Assets, Liabilities, Goals on track.
  dashboardTiles: text("dashboard_tiles").notNull().default('["assets","liabilities","goalsOnTrack"]'),
  createdAt: integer("created_at").notNull(),
});
```

- [ ] **Step 2: Generate the migration**

Run: `bun run db:generate`
Expected: a new `apps/api/drizzle/0008_*.sql` adding `dashboard_tiles` with the default. Inspect it — it should be `ALTER TABLE settings ADD column dashboard_tiles text NOT NULL DEFAULT '["assets","liabilities","goalsOnTrack"]';` (SQLite-compatible).

- [ ] **Step 3: Apply the migration**

Run: `bun run db:migrate`
Expected: "migrations applied".

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle
git commit -m "feat(api): add dashboard_tiles column to settings"
```

### Task 3.2: Expose + persist `dashboardTiles` via settings route (TDD)

**Files:**
- Modify: `apps/api/src/routes/settings.test.ts` (add tests)
- Modify: `apps/api/src/routes/settings.ts` (GET returns it; PATCH accepts it)

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/routes/settings.test.ts`:
```ts
test("GET /settings returns the default dashboard tiles", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const res = await app.handle(new Request("http://localhost/settings", { headers: { cookie } }));
  const s = await res.json();
  expect(s.dashboardTiles).toEqual(["assets", "liabilities", "goalsOnTrack"]);
});

test("PATCH /settings persists a reordered/filtered tile list", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const patch = await app.handle(
    new Request("http://localhost/settings", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ dashboardTiles: ["goalsOnTrack", "liquidAssets"] }),
    }),
  );
  expect(patch.status).toBe(200);
  const s = await (
    await app.handle(new Request("http://localhost/settings", { headers: { cookie } }))
  ).json();
  expect(s.dashboardTiles).toEqual(["goalsOnTrack", "liquidAssets"]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test apps/api/src/routes/settings.test.ts`
Expected: FAIL — `dashboardTiles` is `undefined` in the GET response; PATCH ignores the field.

- [ ] **Step 3: Implement in `settings.ts`**

Update GET to parse and return the JSON column, and PATCH to accept and stringify it. The column is stored as a JSON string:
```ts
import { settings } from "../db/schema";
// GET handler:
.get("/", async () => {
  const s = (await db.select().from(settings).where(eq(settings.id, 1)))[0];
  return {
    householdName: s?.householdName ?? "",
    baseCurrency: s?.baseCurrency ?? "USD",
    contributionGrowthRateBps: s?.contributionGrowthRateBps ?? 800,
    projectionEndAge: s?.projectionEndAge ?? 90,
    dashboardTiles: JSON.parse(s?.dashboardTiles ?? '["assets","liabilities","goalsOnTrack"]') as string[],
  };
})
```
PATCH:
```ts
.patch(
  "/",
  async ({ body }: any) => {
    const update: Record<string, unknown> = {};
    if (body.contributionGrowthRateBps !== undefined) update.contributionGrowthRateBps = body.contributionGrowthRateBps;
    if (body.projectionEndAge !== undefined) update.projectionEndAge = body.projectionEndAge;
    if (body.dashboardTiles !== undefined) update.dashboardTiles = JSON.stringify(body.dashboardTiles);
    if (Object.keys(update).length > 0) {
      await db.update(settings).set(update).where(eq(settings.id, 1));
    }
    return { ok: true };
  },
  {
    body: t.Object({
      contributionGrowthRateBps: t.Optional(t.Number()),
      projectionEndAge: t.Optional(t.Number()),
      dashboardTiles: t.Optional(t.Array(t.String())),
    }),
  },
)
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test apps/api/src/routes/settings.test.ts`
Expected: PASS (existing + 2 new tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/settings.ts apps/api/src/routes/settings.test.ts
git commit -m "feat(api): settings route exposes + persists dashboardTiles"
```

### Task 3.3: Pure tile registry (TDD)

**Files:**
- Create: `apps/web/src/lib/dashboard-tiles/registry.test.ts`
- Create: `apps/web/src/lib/dashboard-tiles/registry.ts`

- [ ] **Step 1: Write the failing tests**

`apps/web/src/lib/dashboard-tiles/registry.test.ts`:
```ts
import { expect, test } from "bun:test";
import { TILE_REGISTRY, getTile, type TileData } from "./registry";

const base: TileData = {
  baseCurrency: "GBP",
  accounts: [
    { class: "asset", baseMinor: 31_240_000, illiquid: false },
    { class: "asset", baseMinor: 5_000_000, illiquid: true },
    { class: "liability", baseMinor: 2_749_000, illiquid: false },
  ],
  goalsTotal: 4,
  goalsOnTrack: 3,
  periodDeltaMinor: 524_000,
};

test("assets tile sums asset accounts", () => {
  const tile = getTile("assets")!;
  expect(tile.isAvailable(base)).toBe(true);
  expect(tile.value(base)).toBe(36_240_000);
});

test("liabilities tile sums liability accounts", () => {
  expect(getTile("liabilities")!.value(base)).toBe(2_749_000);
});

test("liquidAssets excludes illiquid asset accounts", () => {
  expect(getTile("liquidAssets")!.value(base)).toBe(31_240_000);
});

test("goalsOnTrack is unavailable when there are no goals", () => {
  const tile = getTile("goalsOnTrack")!;
  expect(tile.isAvailable(base)).toBe(true);
  expect(tile.isAvailable({ ...base, goalsTotal: 0 })).toBe(false);
});

test("periodChange is unavailable without a delta", () => {
  expect(getTile("periodChange")!.isAvailable({ ...base, periodDeltaMinor: null })).toBe(false);
});

test("registry ids are unique", () => {
  const ids = TILE_REGISTRY.map((t) => t.id);
  expect(new Set(ids).size).toBe(ids.length);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test apps/web/src/lib/dashboard-tiles/registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the registry**

`apps/web/src/lib/dashboard-tiles/registry.ts`:
```ts
export type TileAccount = { class: string; baseMinor: number; illiquid: boolean };

export type TileData = {
  baseCurrency: string;
  accounts: TileAccount[];
  goalsTotal: number;
  goalsOnTrack: number;
  periodDeltaMinor: number | null;
};

export type Tile = {
  id: string;
  label: string;
  isAvailable: (d: TileData) => boolean;
  // Numeric value in base minor units (or a count for goalsOnTrack).
  value: (d: TileData) => number;
  // Optional small subtitle line (e.g. "across 9 accounts").
  subtitle?: (d: TileData) => string;
};

const sumAssets = (d: TileData) =>
  d.accounts.filter((a) => a.class === "asset").reduce((s, a) => s + a.baseMinor, 0);
const sumLiabilities = (d: TileData) =>
  d.accounts.filter((a) => a.class === "liability").reduce((s, a) => s + a.baseMinor, 0);
const sumLiquid = (d: TileData) =>
  d.accounts.filter((a) => a.class === "asset" && !a.illiquid).reduce((s, a) => s + a.baseMinor, 0);
const countAssets = (d: TileData) => d.accounts.filter((a) => a.class === "asset").length;
const countLiabilities = (d: TileData) => d.accounts.filter((a) => a.class === "liability").length;

export const TILE_REGISTRY: Tile[] = [
  {
    id: "assets",
    label: "Assets",
    isAvailable: (d) => countAssets(d) > 0,
    value: sumAssets,
    subtitle: (d) => `across ${countAssets(d)} account${countAssets(d) === 1 ? "" : "s"}`,
  },
  {
    id: "liabilities",
    label: "Liabilities",
    isAvailable: (d) => countLiabilities(d) > 0,
    value: sumLiabilities,
    subtitle: (d) => `across ${countLiabilities(d)} account${countLiabilities(d) === 1 ? "" : "s"}`,
  },
  {
    id: "liquidAssets",
    label: "Liquid assets",
    isAvailable: (d) => d.accounts.some((a) => a.class === "asset" && !a.illiquid),
    value: sumLiquid,
  },
  {
    id: "goalsOnTrack",
    label: "Goals on track",
    isAvailable: (d) => d.goalsTotal > 0,
    value: (d) => d.goalsOnTrack,
    subtitle: (d) => `of ${d.goalsTotal}`,
  },
  {
    id: "periodChange",
    label: "Period change",
    isAvailable: (d) => d.periodDeltaMinor !== null,
    value: (d) => d.periodDeltaMinor ?? 0,
  },
];

const BY_ID = new Map(TILE_REGISTRY.map((t) => [t.id, t]));
export function getTile(id: string): Tile | undefined {
  return BY_ID.get(id);
}

export const DEFAULT_TILES = ["assets", "liabilities", "goalsOnTrack"];
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test apps/web/src/lib/dashboard-tiles/registry.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/dashboard-tiles/registry.ts apps/web/src/lib/dashboard-tiles/registry.test.ts
git commit -m "feat(web): pure dashboard tile registry"
```

---

# Phase 4 — Dashboard hero, tiles UI, and relocation

**Outcome:** The bespoke brass-dawn hero with a green vault net-worth panel, configurable tiles with an edit mode persisted per-household, the owner toggle moved into the chart card, and "Add account" moved into the Assets section header.

### Task 4.1: `DashboardSection` gains an `actions` slot

**Files:**
- Modify: `apps/web/src/components/dashboard-section.tsx:55-63` (props), `:438-496` (header)

- [ ] **Step 1: Add an optional `actions` prop and render it in the header**

Extend the props type:
```ts
type Props = {
  cls: "asset" | "liability";
  label: string;
  accounts: AccountValuation[];
  groups: GroupRow[];
  baseCurrency: string;
  sectionTotalMinor: number;
  hasData: boolean;
  actions?: React.ReactNode; // rendered at the right of the section header
};
```
In the header's right-side flex row (where the section total + "New group" live), render `{actions}` first:
```tsx
<div className="flex items-center gap-2">
  {actions}
  {/* existing section total + New group controls */}
</div>
```
Destructure `actions` in the component signature.

- [ ] **Step 2: Build**

Run: `bun --cwd apps/web run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/dashboard-section.tsx
git commit -m "feat(web): DashboardSection actions slot"
```

### Task 4.2: Owner toggle moves into the chart card header

**Files:**
- Modify: `apps/web/src/components/net-worth-chart.tsx:87,127-140` (accept + render the toggle)
- Modify: `apps/web/src/components/net-worth-toggle.tsx` (default button size)

- [ ] **Step 1: Let the chart host the toggle**

Change the chart's props to accept the toggle controls and render them right-aligned in its header:
```tsx
export function NetWorthChart({
  owner,
  onOwnerChange,
}: {
  owner: string;
  onOwnerChange: (v: string) => void;
}) {
```
In the header row (currently the preset buttons), wrap into a two-part flex: presets on the left, `<NetWorthToggle value={owner} onChange={onOwnerChange} />` on the right:
```tsx
<div className="flex flex-wrap items-center justify-between gap-2">
  <div className="flex flex-wrap gap-1.5">{/* existing preset buttons */}</div>
  <NetWorthToggle value={owner} onChange={onOwnerChange} />
</div>
```
Add `import { NetWorthToggle } from "@/components/net-worth-toggle"`.

- [ ] **Step 2: Standardize the toggle button size**

In `net-worth-toggle.tsx`, remove `size="sm"` so the toggle uses the default `h-8` (per the button standard); the toggle is a header control, not a dense inline row.

- [ ] **Step 3: Build**

Run: `bun --cwd apps/web run build`
Expected: PASS (note: `dashboard.tsx` still passes the old props — fixed in Task 4.4).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/net-worth-chart.tsx apps/web/src/components/net-worth-toggle.tsx
git commit -m "feat(web): owner toggle lives in the net-worth chart card header"
```

### Task 4.3: Dashboard hero component

**Files:**
- Create: `apps/web/src/components/dashboard-hero.tsx`

Reference mockup: `.superpowers/brainstorm/26147-1781477085/content/dashboard-wide-v2.html` (closest to final, **minus** the hero eye icon — that lives in the top bar). Theme tokens: pine `--primary #1f5d4c`, gold `--gold`, paper `--card #fffefb`.

- [ ] **Step 1: Create the hero**

`apps/web/src/components/dashboard-hero.tsx`:
```tsx
import { useSession } from "@/lib/auth";
import { Eyebrow } from "@/components/app-layout";
import { Money } from "@/components/money";
import { cn } from "@/lib/utils";

function greeting(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function todayLabel(): string {
  return new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}

export function DashboardHero({
  owner,
  totalBaseMinor,
  baseCurrency,
  series,
  changeMinor,
  changePct,
  tiles,
}: {
  owner: string;
  totalBaseMinor: number | null;
  baseCurrency: string;
  series: { date: string; totalBaseMinor: number }[];
  changeMinor: number | null;
  changePct: number | null;
  tiles: React.ReactNode; // companion tiles, rendered beside the vault
}) {
  const { data: session } = useSession();
  const name = session?.user?.name ?? "there";
  const now = new Date();

  return (
    <section
      data-testid="dashboard-hero"
      className="relative overflow-hidden rounded-[18px] border border-border px-6 py-7 shadow-sm md:px-8 md:py-7"
      style={{
        backgroundImage:
          "radial-gradient(120% 140% at 85% -10%, color-mix(in oklab, var(--gold) 18%, transparent), transparent 55%)," +
          "radial-gradient(90% 120% at 0% 110%, color-mix(in oklab, var(--primary) 10%, transparent), transparent 50%)," +
          "linear-gradient(var(--card), var(--background))",
      }}
    >
      {/* polished gold top rule */}
      <div
        className="absolute inset-x-0 top-0 h-[3px]"
        style={{
          background:
            "linear-gradient(90deg, transparent, color-mix(in oklab, var(--gold) 55%, transparent), var(--gold), color-mix(in oklab, var(--gold) 55%, transparent), transparent)",
        }}
      />
      <div className="font-heading text-[1.8rem] font-medium tracking-tight">
        {greeting(now.getHours())}, <span className="italic text-gold">{name}</span>.
      </div>
      <div className="mt-1 text-sm text-muted-foreground">{todayLabel()}</div>

      <div className="mt-5 grid gap-4 md:grid-cols-[1.45fr_1fr]">
        {/* pine-green vault */}
        <div
          className="relative overflow-hidden rounded-[14px] px-6 py-5 text-[#f6efdf]"
          style={{
            backgroundImage:
              "radial-gradient(130% 130% at 92% -20%, #2a7361, var(--primary) 45%, #17463a)",
          }}
        >
          <Eyebrow className="[&_span:last-child]:text-[rgba(245,239,231,0.7)] [&_span:first-child]:bg-gold/80">
            Net worth · {owner === "household" ? "household" : "personal"}
          </Eyebrow>
          <p
            data-testid="networth-hero"
            className={cn(
              "mt-2 font-heading text-[2.75rem] font-medium leading-none tabular-nums text-[#f6efdf]",
            )}
          >
            {totalBaseMinor === null ? "—" : <Money minor={totalBaseMinor} currency={baseCurrency} />}
          </p>
          <HeroSparkline points={series} />
          {changeMinor !== null && (
            <div className="relative mt-3">
              <span className="rounded-full bg-gold/20 px-3 py-1 text-xs font-medium text-[#dff0e4]">
                {changeMinor >= 0 ? "▲" : "▼"}{" "}
                <Money minor={Math.abs(changeMinor)} currency={baseCurrency} />
                {changePct !== null ? ` (${Math.abs(changePct).toFixed(1)}%)` : ""} this period
              </span>
            </div>
          )}
        </div>

        {/* companion tiles */}
        {tiles}
      </div>
    </section>
  );
}

function HeroSparkline({ points }: { points: { totalBaseMinor: number }[] }) {
  if (points.length < 2) return <div className="mt-2 h-10" />;
  const values = points.map((p) => p.totalBaseMinor);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const stepX = 360 / (values.length - 1);
  const coords = values.map((v, i) => `${(i * stepX).toFixed(1)},${(36 - ((v - min) / span) * 32).toFixed(1)}`);
  return (
    <svg
      width="100%"
      height="40"
      viewBox="0 0 360 40"
      preserveAspectRatio="none"
      className="relative mt-2"
      aria-hidden
    >
      <polyline points={coords.join(" ")} stroke="var(--gold)" strokeWidth={2} fill="none" />
      <polyline points={`${coords.join(" ")} 360,40 0,40`} fill="color-mix(in oklab, var(--gold) 12%, transparent)" stroke="none" />
    </svg>
  );
}
```

Note: the `data-testid="networth-hero"` moves here, preserving the existing e2e selector.

- [ ] **Step 2: Build**

Run: `bun --cwd apps/web run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/dashboard-hero.tsx
git commit -m "feat(web): brass-dawn dashboard hero with green vault + sparkline"
```

### Task 4.4: Tiles renderer + edit mode

**Files:**
- Create: `apps/web/src/components/dashboard-tiles/dashboard-tiles.tsx`

- [ ] **Step 1: Create the tiles component with show/hide + reorder, persisted via settings**

`apps/web/src/components/dashboard-tiles/dashboard-tiles.tsx`:
```tsx
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Pencil, Check } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Money } from "@/components/money";
import { TILE_REGISTRY, getTile, DEFAULT_TILES, type TileData } from "@/lib/dashboard-tiles/registry";
import { cn } from "@/lib/utils";

function SortableTile({ id, children }: { id: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("flex items-center gap-2", isDragging && "opacity-60")}
    >
      <button type="button" className="cursor-grab text-muted-foreground" {...attributes} {...listeners} aria-label="Reorder">
        <GripVertical className="size-4" />
      </button>
      <div className="flex-1">{children}</div>
    </div>
  );
}

export function DashboardTiles({ data, baseCurrency }: { data: TileData; baseCurrency: string }) {
  const qc = useQueryClient();
  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const { data, error } = await api.settings.get();
      if (error) throw new Error(String(error));
      return data;
    },
  });
  const enabled: string[] = settings?.dashboardTiles ?? DEFAULT_TILES;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[] | null>(null);
  const order = draft ?? enabled;

  const save = useMutation({
    mutationFn: async (ids: string[]) => {
      const { error } = await api.settings.patch({ dashboardTiles: ids });
      if (error) throw new Error(String(error));
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
  });

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  // Visible (non-edit) tiles: enabled ∩ available, in saved order.
  const visible = useMemo(
    () => order.map(getTile).filter((t): t is NonNullable<typeof t> => !!t && t.isAvailable(data)),
    [order, data],
  );

  if (!editing) {
    return (
      <div data-testid="dashboard-tiles" className="grid grid-rows-2 gap-4">
        <div className="col-span-full flex justify-end">
          <Button type="button" size="icon-sm" variant="ghost" onClick={() => setEditing(true)} aria-label="Edit tiles">
            <Pencil className="size-4" />
          </Button>
        </div>
        {visible.map((t) => (
          <TileCard key={t.id} label={t.label} valueNode={renderValue(t.id, t.value(data), baseCurrency)} subtitle={t.subtitle?.(data)} />
        ))}
      </div>
    );
  }

  // Edit mode: every registry tile, checkbox + drag, in current draft order.
  const editOrder = order.filter((id) => getTile(id));
  const missing = TILE_REGISTRY.map((t) => t.id).filter((id) => !editOrder.includes(id));
  const allInOrder = [...editOrder, ...missing];

  return (
    <div data-testid="dashboard-tiles-edit" className="rounded-[14px] border border-dashed border-border p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Edit tiles</span>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Done editing tiles"
          onClick={() => {
            save.mutate(order);
            setEditing(false);
          }}
        >
          <Check className="size-4" />
        </Button>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={({ active, over }) => {
          if (!over || active.id === over.id) return;
          const from = allInOrder.indexOf(String(active.id));
          const to = allInOrder.indexOf(String(over.id));
          // Reorder the full list, then keep only enabled ids — the saved order
          // is the enabled set in its new relative order.
          const reordered = arrayMove(allInOrder, from, to).filter((id) => order.includes(id));
          setDraft(reordered);
        }}
      >
        <SortableContext items={allInOrder} strategy={verticalListSortingStrategy}>
          <div className="space-y-2">
            {allInOrder.map((id) => {
              const tile = getTile(id)!;
              const isEnabled = order.includes(id);
              return (
                <SortableTile key={id} id={id}>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={isEnabled}
                      onCheckedChange={(v) => {
                        setDraft(() => (v ? [...order, id] : order.filter((x) => x !== id)));
                      }}
                    />
                    <span>{tile.label}</span>
                    {!tile.isAvailable(data) && <span className="text-xs text-muted-foreground">(no data)</span>}
                  </label>
                </SortableTile>
              );
            })}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}

function renderValue(id: string, value: number, currency: string): React.ReactNode {
  if (id === "goalsOnTrack") return <span className="tabular-nums">{value}</span>;
  return <Money minor={value} currency={currency} />;
}

function TileCard({ label, valueNode, subtitle }: { label: string; valueNode: React.ReactNode; subtitle?: string }) {
  return (
    <div className="flex flex-col justify-center rounded-[14px] border border-border bg-card px-5 py-4">
      <div className="text-[11px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="mt-1 font-heading text-[1.6rem] tabular-nums">{valueNode}</div>
      {subtitle && <div className="mt-0.5 text-xs text-muted-foreground">{subtitle}</div>}
    </div>
  );
}
```

> Implementation note for the executor: the two `setDraft` calls in `onDragEnd` above are intentionally collapsed to the final one — reorder operates on `allInOrder`, then filters to the enabled set so the saved order only contains enabled ids. Simplify to a single `setDraft((/* compute */) => arrayMove(allInOrder, from, to).filter((x) => order.includes(x)))` when implementing; verify with the e2e test in Task 4.6.

- [ ] **Step 2: Build**

Run: `bun --cwd apps/web run build`
Expected: PASS. If `Checkbox` import path differs, confirm `apps/web/src/components/ui/checkbox.tsx` exists (it does).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/dashboard-tiles/dashboard-tiles.tsx
git commit -m "feat(web): configurable dashboard tiles with edit mode"
```

### Task 4.5: Compose the new dashboard

**Files:**
- Modify: `apps/web/src/routes/dashboard.tsx`
- Modify: `apps/web/src/components/app-layout.tsx` (drop the top-right `actions` usage on dashboard)

- [ ] **Step 1: Rebuild `DashboardPage`**

Replace the body of `apps/web/src/routes/dashboard.tsx` so it: (a) drops the `<AppShell actions=…>` Add-account slot, (b) drops the old `NetWorthToggle` block and old hero `<section>`, (c) fetches the net-worth series for the sparkline + period delta, (d) renders `<DashboardHero>` with `<DashboardTiles>` as its `tiles`, (e) passes `onOwnerChange` to `<NetWorthChart>`, (f) passes `<AccountForm>` to the asset `DashboardSection` via `actions`.

```tsx
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import { AppShell } from "@/components/app-layout";
import { AccountForm } from "@/components/account-form";
import { NetWorthChart } from "@/components/net-worth-chart";
import { NetWorthToggle } from "@/components/net-worth-toggle"; // now used inside chart; keep import only if referenced
import { DashboardSection } from "@/components/dashboard-section";
import { DashboardHero } from "@/components/dashboard-hero";
import { DashboardTiles } from "@/components/dashboard-tiles/dashboard-tiles";
import { groupsCollection } from "@/lib/collections";
import { useGoalsAnalysis } from "@/lib/use-goals-analysis"; // see note below
import type { TileData } from "@/lib/dashboard-tiles/registry";

const CLASS_SECTIONS = [
  { cls: "asset" as const, label: "Assets" },
  { cls: "liability" as const, label: "Liabilities" },
];

async function fetchNw(owner: string) {
  const { api } = await import("@/lib/api");
  const { data, error } = await api.networth.get({ query: { owner } });
  if (error) throw new Error(String(error));
  return data;
}

function startOfMonthISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

export function DashboardPage() {
  const [owner, setOwner] = useState("household");

  const { data: listData } = useQuery({ queryKey: ["networth", "household"], queryFn: () => fetchNw("household") });
  const { data: headline } = useQuery({ queryKey: ["networth", owner], queryFn: () => fetchNw(owner) });
  const { data: seriesData } = useQuery({
    queryKey: ["networth-series", owner, startOfMonthISO()],
    queryFn: async () => {
      const { api } = await import("@/lib/api");
      const { data, error } = await api.networth.series.get({ query: { from: startOfMonthISO(), owner } });
      if (error) throw new Error(String(error));
      return data;
    },
  });
  const { data: allGroups } = useLiveQuery(groupsCollection);
  const analysis = useGoalsAnalysis(); // { goals: [...], overall: { onTrack, behindCount } } | undefined

  const base = listData?.baseCurrency ?? "";
  const accounts = listData?.accounts ?? [];

  const points = seriesData?.points ?? [];
  const periodDeltaMinor =
    headline && points.length > 0 ? headline.totalBaseMinor - points[0].totalBaseMinor : null;
  const periodPct =
    periodDeltaMinor !== null && points[0]?.totalBaseMinor
      ? (periodDeltaMinor / Math.abs(points[0].totalBaseMinor)) * 100
      : null;

  const tileData: TileData = useMemo(
    () => ({
      baseCurrency: base,
      accounts: accounts.map((a) => ({ class: a.class, baseMinor: a.baseMinor, illiquid: a.illiquid })),
      goalsTotal: analysis?.goals.length ?? 0,
      goalsOnTrack: analysis?.goals.filter((g) => g.onTrack).length ?? 0,
      periodDeltaMinor,
    }),
    [base, accounts, analysis, periodDeltaMinor],
  );

  return (
    <AppShell>
      <DashboardHero
        owner={owner}
        totalBaseMinor={headline ? headline.totalBaseMinor : null}
        baseCurrency={headline?.baseCurrency ?? base}
        series={points}
        changeMinor={periodDeltaMinor}
        changePct={periodPct}
        tiles={<DashboardTiles data={tileData} baseCurrency={base} />}
      />

      <div className="mt-6">
        <NetWorthChart owner={owner} onOwnerChange={setOwner} />
      </div>

      <div className="mt-9 space-y-8">
        {CLASS_SECTIONS.map(({ cls, label }) => {
          const sectionAccounts = accounts.filter((a) => a.class === cls);
          const sectionGroups = (allGroups ?? []).filter((g) => g.class === cls);
          const sectionTotal = sectionAccounts.filter((a) => !a.missingRate).reduce((sum, a) => sum + a.baseMinor, 0);
          return (
            <DashboardSection
              key={cls}
              cls={cls}
              label={label}
              accounts={sectionAccounts}
              groups={sectionGroups}
              baseCurrency={base}
              sectionTotalMinor={sectionTotal}
              hasData={!!listData}
              actions={cls === "asset" ? <AccountForm defaultCurrency={base || undefined} /> : undefined}
            />
          );
        })}
      </div>
    </AppShell>
  );
}
```

Notes for the executor:
- **`useGoalsAnalysis`**: if no such hook exists, inline a `useQuery` calling `api.goals.analysis.get()` (the route is `GET /goals/analysis` → `{ goals, overall, … }`). Use whatever the existing goals page uses (`goals.tsx` already calls an analysis query — reuse that pattern/hook).
- **series route call**: confirm the Eden path is `api.networth.series.get(...)` (route is `GET /networth/series`). Match the treaty shape used elsewhere.
- Remove the now-unused `Eyebrow`/`formatMoney`/`cn` imports from `dashboard.tsx` if they are no longer referenced.

- [ ] **Step 2: Confirm `AppShell` no longer needs the dashboard `actions`**

`AppShell` keeps its optional `actions` prop for other callers; the dashboard simply stops passing it. No change to `app-layout.tsx` is required unless `actions` was dashboard-only — leave it.

- [ ] **Step 3: Build + manual check**

Run: `bun --cwd apps/web run build` (PASS). Run the app: hero shows greeting + green vault + sparkline + change pill; tiles show Assets/Liabilities/Goals; chart card header has the owner toggle; "Add account" is in the Assets section header; no top-right action button remains.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/dashboard.tsx
git commit -m "feat(web): compose redesigned dashboard (hero + tiles + relocated controls)"
```

### Task 4.6: e2e — tiles edit mode persists; relocation works

**Files:**
- Create: `e2e/tests/dashboard-tiles.spec.ts`

- [ ] **Step 1: Write the e2e test**

`e2e/tests/dashboard-tiles.spec.ts`:
```ts
import { test, expect } from "./fixtures";
import { seedHousehold, createAccount } from "./helpers";

test.beforeEach(async ({ backend, request, context }) => {
  await backend.freshDb();
  await seedHousehold(request, context, backend.apiURL);
});

test("dashboard shows hero + default tiles, Add account in Assets header", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("dashboard-hero")).toBeVisible();
  await expect(page.getByTestId("dashboard-tiles")).toBeVisible();
  // Add account lives in the Assets section now (not top-right).
  await expect(page.getByRole("button", { name: "Add account" })).toBeVisible();
  await createAccount(page, { name: "Checking", currency: "USD" });
  await expect(page.getByTestId("dashboard-tiles")).toContainText("Assets");
});

test("tile edit mode toggles a tile and persists across reload", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Edit tiles" }).click();
  await page.getByRole("checkbox", { name: /Liquid assets/i }).check();
  await page.getByRole("button", { name: "Done editing tiles" }).click();
  await expect(page.getByTestId("dashboard-tiles")).toContainText("Liquid assets");
  await page.reload();
  await expect(page.getByTestId("dashboard-tiles")).toContainText("Liquid assets");
});
```

- [ ] **Step 2: Run the e2e test**

Run: `bun run --cwd e2e test dashboard-tiles`
Expected: PASS. Align selectors/helpers with `e2e/tests/helpers.ts` if names differ (e.g. the checkbox label, the "Liquid assets" tile only appears if a liquid asset exists — seed one first if needed).

- [ ] **Step 3: Commit**

```bash
git add e2e/tests/dashboard-tiles.spec.ts
git commit -m "test(e2e): dashboard tiles edit mode + relocation"
```

### Task 4.7: Full regression + final verification

- [ ] **Step 1: Run all unit tests**

Run: `bun test`
Expected: PASS (API + shared + new pure-logic tests).

- [ ] **Step 2: Run the full e2e suite**

Run: `bun run e2e`
Expected: PASS. The networth-hero selector still resolves (it moved into the hero with the same `data-testid`). Fix any selector drift in existing specs.

- [ ] **Step 3: Typecheck/build both apps**

Run: `bun --cwd apps/web run build && bun --cwd apps/api run build` (or the repo's typecheck script).
Expected: PASS — no `as any` introduced (project rule).

- [ ] **Step 4: Manual pass against the spec's manual checklist**

Verify at `max-w-5xl`: hero layout, edit-mode reorder, privacy toggle masks across dashboard/accounts/goals/projections/settings, form spacing, dialog footers with Cancel.

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "test: regression fixes after UI standardization"
```

---

## Self-review against the spec

- **§1 Dashboard hero** → Task 4.3 (greeting, brass-dawn, green vault, sparkline, change pill; no hero eye icon; no hero toggle). ✓
- **§2 Configurable tiles** → registry (3.3), backend persistence (3.1–3.2), renderer + edit mode (4.4); default Assets/Liabilities/Goals; per-household via singleton settings row. ✓
- **§3 Toggle + Add-account relocation** → toggle into chart card (4.2), Add-account into Assets section via `actions` slot (4.1 + 4.5). ✓
- **§4 Value privacy** → context + localStorage + `<Money>`/`useMoney` (1.1–1.5), single top-bar control (1.4), masks across all pages (1.5), e2e (1.6). ✓
- **§5 Form standard** → shared `<Field>` `space-y-1.5` (2.1), `space-y-4` bodies + `gap-4` grids applied to listed forms (2.2–2.3); `account-info-card`'s existing `Field` already compliant (noted). ✓
- **§6 Button standard** → default `h-8` already; retire ad-hoc `sm`, add Cancel to every dialog, destructive at default size, icon-sm ghost (2.4); toggle desized (4.2). ✓
- **§7 Page header + nav** → shared `<PageHeader>` (2.5) adopted on goals/settings/projections/account-detail/goal-detail (2.6); breadcrumb-only, account crumb fixed (2.7); dashboard keeps bespoke hero (4.x). ✓
- **Testing** → registry/masking/persistence unit tests; e2e for privacy + tiles; full regression (4.7). ✓
- **Constraints** → no `as any`; shadcn components already present (Checkbox/Button/Dialog) — no new CLI adds needed; tile config per-household (backend), value-hide per-device (localStorage). ✓

**Deferred (out of scope, per spec):** cash-flow / savings-rate / runway tiles — the registry leaves room (`Future tiles`) but they are not implemented.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-15-ui-standardization.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration. REQUIRED SUB-SKILL: superpowers:subagent-driven-development.
2. **Inline Execution** — execute tasks in this session with checkpoints. REQUIRED SUB-SKILL: superpowers:executing-plans.

Because the four phases are independently shippable, a natural cadence is to execute and merge one phase at a time (Phase 1 → 2 → 3 → 4).
