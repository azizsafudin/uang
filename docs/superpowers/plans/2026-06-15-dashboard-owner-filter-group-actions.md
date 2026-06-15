# Dashboard owner-filter + group add-account actions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Declutter each dashboard section header into a 3-dot menu, make the owner toggle filter the account list (shared accounts included), and add an "Add account to this group" action to groups/owner-buckets that opens a react-hook-form-powered account form prefilled for that group/bucket.

**Architecture:** `AccountForm` becomes a *controlled* dialog driven by react-hook-form, owned per-section by `DashboardSection`. Each section exposes an `openAddAccount(prefill)` callback to its dot menu and its group rows. The owner filter is a pure helper applied in `dashboard.tsx` before splitting accounts into sections.

**Tech Stack:** React, react-hook-form (new dep), TanStack Query/DB, shadcn (`DropdownMenu`, `ContextMenu`, `Select`), Bun, Playwright (e2e).

---

## File Structure

- `apps/web/package.json` — add `react-hook-form` dependency.
- `apps/web/src/lib/account-grouping.ts` — add pure `visibleForOwner()` filter helper (+ test).
- `apps/web/src/lib/account-grouping.test.ts` — **new**, unit test for the filter.
- `apps/web/src/components/account-form.tsx` — rewrite to controlled + react-hook-form, add Group field, export `FormValues` / `AccountFormInitial`.
- `apps/web/src/components/account-group-row.tsx` — add optional `onAddAccount` → "Add account to this group" context-menu item (works for buckets too).
- `apps/web/src/components/dashboard-section.tsx` — replace inline Add-account/New-group controls with a dot `DropdownMenu`; own one controlled `AccountForm`; thread `openAddAccount` to the menu and to each group row.
- `apps/web/src/routes/dashboard.tsx` — apply owner filter; stop passing `<AccountForm/>` via `actions`.
- `e2e/tests/helpers.ts` + `e2e/tests/dashboard-tiles.spec.ts` — open "Add account" via the dot menu.

---

### Task 1: Add react-hook-form dependency

**Files:**
- Modify: `apps/web/package.json`

- [ ] **Step 1: Install**

Run:
```bash
cd apps/web && bun add react-hook-form
```
Expected: `react-hook-form` appears under `dependencies` in `apps/web/package.json`; lockfile updated.

- [ ] **Step 2: Verify it resolves**

Run:
```bash
cd apps/web && bun pm ls | grep react-hook-form
```
Expected: prints a `react-hook-form@7.x` line.

- [ ] **Step 3: Commit**

```bash
git add apps/web/package.json bun.lock
git commit -m "chore(web): add react-hook-form"
```

---

### Task 2: Pure owner-filter helper (TDD)

The toggle must show accounts the selected owner is part of, **including shared accounts**. Extract this as a pure helper so it's unit-testable.

**Files:**
- Create: `apps/web/src/lib/account-grouping.test.ts`
- Modify: `apps/web/src/lib/account-grouping.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/account-grouping.test.ts`:
```ts
import { expect, test } from "bun:test";
import { visibleForOwner, type AccountValuation } from "./account-grouping";

function acct(id: string, ownerIds: string[]): AccountValuation {
  return {
    id,
    name: id,
    class: "asset",
    subtype: "bank",
    currency: "USD",
    balanceMinor: 0,
    baseMinor: 0,
    missingRate: false,
    ownerIds,
    shared: ownerIds.length >= 2,
    illiquid: false,
    groupId: null,
    sortOrder: 0,
  };
}

const accounts = [
  acct("solo-a", ["aziz"]),
  acct("solo-j", ["jihan"]),
  acct("shared", ["aziz", "jihan"]),
];

test("household shows everything", () => {
  expect(visibleForOwner(accounts, "household").map((a) => a.id)).toEqual([
    "solo-a",
    "solo-j",
    "shared",
  ]);
});

test("a member shows their solo accounts and any shared account they co-own", () => {
  expect(visibleForOwner(accounts, "aziz").map((a) => a.id)).toEqual([
    "solo-a",
    "shared",
  ]);
});

test("a member does not see another member's solo accounts", () => {
  expect(visibleForOwner(accounts, "jihan").map((a) => a.id)).toEqual([
    "solo-j",
    "shared",
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd apps/web && bun test src/lib/account-grouping.test.ts
```
Expected: FAIL — `visibleForOwner` is not exported / not a function.

- [ ] **Step 3: Implement the helper**

In `apps/web/src/lib/account-grouping.ts`, add after the `homeBucketId` function (around line 39):
```ts
// Accounts visible for the dashboard owner toggle. "household" shows all;
// a member id shows accounts they own — including shared accounts they co-own.
export function visibleForOwner(
  accounts: AccountValuation[],
  owner: string,
): AccountValuation[] {
  if (owner === "household") return accounts;
  return accounts.filter((a) => a.ownerIds.includes(owner));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd apps/web && bun test src/lib/account-grouping.test.ts
```
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/account-grouping.ts apps/web/src/lib/account-grouping.test.ts
git commit -m "feat(web): visibleForOwner filter helper"
```

---

### Task 3: Rewrite AccountForm as controlled react-hook-form dialog with a Group field

Convert `AccountForm` from self-contained (own open state + trigger button) to **controlled** (parent owns `open`/trigger), backed by react-hook-form, and add a **Group** select. Replace the file entirely.

**Files:**
- Modify (full rewrite): `apps/web/src/components/account-form.tsx`

- [ ] **Step 1: Replace the file contents**

Write `apps/web/src/components/account-form.tsx`:
```tsx
import { useEffect } from "react";
import { useForm, Controller } from "react-hook-form";
import { useQueryClient } from "@tanstack/react-query";
import { SUBTYPES, subtypeLabel, classLabel } from "@/components/labels";
import {
  accountsCollection,
  newId,
  type AccountRow,
  type GroupRow,
} from "@/lib/collections";
import { defaultAssumptions } from "@/lib/assumptions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { useSession } from "@/lib/auth";
import { OwnersField } from "@/components/owners-field";
import { CurrencySelect } from "@/components/currency-select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type FormValues = {
  name: string;
  class: "asset" | "liability";
  subtype: string;
  currency: string;
  ownerIds: string[];
  groupId: string | null;
};

// Prefill payload for openers (section dot menu, group context menu).
export type AccountFormInitial = Partial<
  Pick<FormValues, "class" | "subtype" | "currency" | "ownerIds" | "groupId">
>;

const NO_GROUP = "__none__";

export function AccountForm({
  open,
  onOpenChange,
  initial,
  groups,
  defaultCurrency,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: AccountFormInitial;
  groups: GroupRow[];
  defaultCurrency?: string;
}) {
  const qc = useQueryClient();
  const { data: session } = useSession();
  const meId = session?.user?.id;

  const { register, handleSubmit, control, reset, setValue, watch } =
    useForm<FormValues>({
      defaultValues: {
        name: "",
        class: "asset",
        subtype: "bank",
        currency: defaultCurrency ?? "USD",
        ownerIds: meId ? [meId] : [],
        groupId: null,
      },
    });

  // Re-seed the form each time the dialog opens, applying any prefill.
  useEffect(() => {
    if (!open) return;
    reset({
      name: "",
      class: initial?.class ?? "asset",
      subtype: initial?.subtype ?? "bank",
      currency: (initial?.currency ?? defaultCurrency ?? "USD").toUpperCase(),
      ownerIds: initial?.ownerIds ?? (meId ? [meId] : []),
      groupId: initial?.groupId ?? null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const currentClass = watch("class");
  const groupOptions = groups.filter((g) => g.class === currentClass);

  async function onSubmit(values: FormValues) {
    const currency = values.currency.toUpperCase();
    const assumptions = defaultAssumptions(values.subtype);
    const row: AccountRow = {
      id: newId(),
      name: values.name,
      class: values.class,
      subtype: values.subtype,
      currency,
      institution: null,
      isArchived: 0,
      sortOrder: 0,
      balanceMinor: 0,
      createdAt: Math.floor(Date.now() / 1000),
      createdBy: meId ?? "",
      groupId: values.groupId,
      ownerIds: values.ownerIds.length > 0 ? values.ownerIds : meId ? [meId] : [],
      growthRateBps: assumptions.growthRateBps,
      accessibleFromAge: assumptions.accessibleFromAge,
      earlyWithdrawal: assumptions.earlyWithdrawal,
      earlyHaircutBps: assumptions.earlyHaircutBps,
      illiquid: assumptions.illiquid ? 1 : 0,
      liquidationAge: assumptions.liquidationAge,
      spendType: "none",
      spendAmountMinor: null,
      spendRateBps: null,
      spendStartKind: "age",
      spendStartAge: null,
      spendStartTargetMinor: null,
      contributionMinor: 0,
      contributionUntilAge: null,
      compoundInterval: "annually",
    };
    await accountsCollection.insert(row);
    await qc.invalidateQueries({ queryKey: ["networth"] });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New account</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <Field label="Name">
            <Input data-testid="account-name" {...register("name", { required: true })} />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Type" hint="Assets grow your net worth; Liabilities reduce it.">
              <Controller
                control={control}
                name="class"
                render={({ field }) => (
                  <Select
                    value={field.value}
                    onValueChange={(v: string | null) => {
                      if (!v) return;
                      field.onChange(v);
                      // A group belongs to one class — clear it when class flips.
                      setValue("groupId", null);
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue>{(v: unknown) => classLabel(String(v))}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="asset">Asset</SelectItem>
                      <SelectItem value="liability">Liability</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
            <Field label="Category" hint="The kind of account: bank account, investment portfolio, property, etc.">
              <Controller
                control={control}
                name="subtype"
                render={({ field }) => (
                  <Select
                    value={field.value}
                    onValueChange={(v: string | null) => v && field.onChange(v)}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue>{(v: unknown) => subtypeLabel(String(v))}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {SUBTYPES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {subtypeLabel(s)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Currency">
              <Controller
                control={control}
                name="currency"
                render={({ field }) => (
                  <CurrencySelect
                    data-testid="account-currency"
                    value={field.value}
                    onValueChange={(code) => field.onChange(code)}
                  />
                )}
              />
            </Field>
            <Field label="Group" hint="Optional — organise this account under a group.">
              <Controller
                control={control}
                name="groupId"
                render={({ field }) => (
                  <Select
                    value={field.value ?? NO_GROUP}
                    onValueChange={(v: string | null) =>
                      field.onChange(v === NO_GROUP || !v ? null : v)
                    }
                  >
                    <SelectTrigger className="w-full" data-testid="account-group">
                      <SelectValue>
                        {(v: unknown) => {
                          const id = String(v);
                          if (id === NO_GROUP) return "No group";
                          return groupOptions.find((g) => g.id === id)?.name ?? "No group";
                        }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_GROUP}>No group</SelectItem>
                      {groupOptions.map((g) => (
                        <SelectItem key={g.id} value={g.id}>
                          {g.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
          </div>
          <Field label="Owners">
            <Controller
              control={control}
              name="ownerIds"
              render={({ field }) => (
                <OwnersField value={field.value} onChange={field.onChange} />
              )}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Create</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Typecheck**

Run:
```bash
cd apps/web && bun run build
```
Expected: build fails ONLY in `dashboard.tsx` / `dashboard-section.tsx` (they still pass the old `AccountForm` props). `account-form.tsx` itself must be error-free. If `account-form.tsx` has type errors, fix them before continuing. (Tasks 4–5 fix the callers.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/account-form.tsx
git commit -m "feat(web): controlled react-hook-form AccountForm with Group field"
```

---

### Task 4: Add "Add account to this group" to AccountGroupRow

Give the row an optional `onAddAccount` callback and a context-menu item. The item must appear even for owner buckets (which currently pass neither `onRename` nor `onDelete`, so they get no menu today).

**Files:**
- Modify: `apps/web/src/components/account-group-row.tsx`

- [ ] **Step 1: Add the prop**

In the `Props` type (after `onDelete?`), add:
```tsx
  onAddAccount?: () => void;
```
And add `onAddAccount` to the destructured params in the function signature (after `onDelete`).

- [ ] **Step 2: Make the menu show when any action exists, and render the item**

Replace the `hasMenu` line:
```tsx
  const hasMenu = Boolean(onRename || onDelete);
```
with:
```tsx
  const hasMenu = Boolean(onRename || onDelete || onAddAccount);
```

Replace the `ContextMenuContent` block:
```tsx
      <ContextMenuContent>
        {onRename && <ContextMenuItem onClick={startRename}>Rename</ContextMenuItem>}
        {onRename && onDelete && <ContextMenuSeparator />}
        {onDelete && (
          <ContextMenuItem variant="destructive" onClick={onDelete}>
            Delete group
          </ContextMenuItem>
        )}
      </ContextMenuContent>
```
with:
```tsx
      <ContextMenuContent>
        {onAddAccount && (
          <ContextMenuItem onClick={onAddAccount}>Add account to this group</ContextMenuItem>
        )}
        {onAddAccount && (onRename || onDelete) && <ContextMenuSeparator />}
        {onRename && <ContextMenuItem onClick={startRename}>Rename</ContextMenuItem>}
        {onRename && onDelete && <ContextMenuSeparator />}
        {onDelete && (
          <ContextMenuItem variant="destructive" onClick={onDelete}>
            Delete group
          </ContextMenuItem>
        )}
      </ContextMenuContent>
```

- [ ] **Step 3: Typecheck**

Run:
```bash
cd apps/web && bun run build
```
Expected: still fails only in `dashboard-section.tsx` / `dashboard.tsx`; `account-group-row.tsx` is error-free.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/account-group-row.tsx
git commit -m "feat(web): 'Add account to this group' context-menu item"
```

---

### Task 5: DashboardSection — dot menu, owned AccountForm, thread openAddAccount

Replace the inline Add-account/New-group header controls with a `DropdownMenu`, own one controlled `AccountForm`, and pass `openAddAccount` to the menu and each group row.

**Files:**
- Modify: `apps/web/src/components/dashboard-section.tsx`

- [ ] **Step 1: Update imports**

Change the existing `account-form` / icon imports. Add at the top with the other component imports:
```tsx
import { MoreVertical } from "lucide-react";
import { AccountForm, type AccountFormInitial } from "@/components/account-form";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
```
(`GripVertical` is imported inside `account-group-row`, not here — only add `MoreVertical`.)

- [ ] **Step 2: Remove the `actions` prop**

In the `Props` type, delete the line:
```tsx
  actions?: React.ReactNode; // rendered at the right of the section header
```
And remove `actions` from the destructured params in `DashboardSection({ ... })`.

- [ ] **Step 3: Add add-account state + opener**

Just after `const [newGroupName, setNewGroupName] = useState("");` (around line 139), add:
```tsx
  const [addState, setAddState] = useState<{ open: boolean; initial?: AccountFormInitial }>({
    open: false,
  });

  function openAddAccount(prefill?: Omit<AccountFormInitial, "class">) {
    setAddState({ open: true, initial: { class: cls, ...prefill } });
  }
```

- [ ] **Step 4: Replace the header right-hand controls**

Replace the entire `<div className="flex items-center gap-3">…</div>` block (currently lines 380–436, starting at `{actions}` and ending before the closing `</div>` of the header) with:
```tsx
        <div className="flex items-center gap-3">
          {hasData && accounts.length > 0 && (
            <span className="font-heading text-sm tabular-nums text-muted-foreground">
              <Money minor={sectionTotalMinor} currency={baseCurrency} />
            </span>
          )}
          {newGroupOpen ? (
            <div className="flex items-center gap-1.5">
              <Input
                autoFocus
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                placeholder="Group name"
                className="h-7 w-32 text-xs"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void createGroup();
                  if (e.key === "Escape") {
                    setNewGroupOpen(false);
                    setNewGroupName("");
                  }
                }}
              />
              <Button
                size="sm"
                className="h-7 text-xs"
                onClick={() => void createGroup()}
                disabled={!newGroupName.trim()}
              >
                Create
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                onClick={() => {
                  setNewGroupOpen(false);
                  setNewGroupName("");
                }}
              >
                ✕
              </Button>
            </div>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button variant="ghost" size="icon-sm" aria-label={`${label} actions`} />
                }
              >
                <MoreVertical size={16} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => openAddAccount()}>Add account</DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    setNewGroupOpen(true);
                    setNewGroupName("");
                  }}
                >
                  New group
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
```

- [ ] **Step 5: Pass `onAddAccount` to each group row**

In the `<AccountGroupRow .../>` JSX (around lines 485–498), add a prop after `onDelete`:
```tsx
                          onAddAccount={() =>
                            openAddAccount(
                              bucket
                                ? { ownerIds: ownerIdsOf(cardId) }
                                : { groupId: cardId },
                            )
                          }
```
(`ownerIdsOf` is already imported from `@/lib/account-grouping`; `bucket` and `cardId` are already in scope in this map callback.)

- [ ] **Step 6: Render the owned AccountForm**

Immediately before the closing `</section>` tag (last line of the returned JSX), add:
```tsx
      <AccountForm
        open={addState.open}
        onOpenChange={(v) => setAddState((s) => ({ ...s, open: v }))}
        initial={addState.initial}
        groups={groups}
        defaultCurrency={baseCurrency || undefined}
      />
```

- [ ] **Step 7: Typecheck**

Run:
```bash
cd apps/web && bun run build
```
Expected: now fails ONLY in `dashboard.tsx` (still passes the removed `actions` prop). `dashboard-section.tsx` is error-free.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/dashboard-section.tsx
git commit -m "feat(web): section dot menu + owned AccountForm + add-to-group wiring"
```

---

### Task 6: dashboard.tsx — owner filter + drop the `actions` prop

**Files:**
- Modify: `apps/web/src/routes/dashboard.tsx`

- [ ] **Step 1: Import the filter helper**

Find the import from `@/lib/account-grouping` (or add one). Add `visibleForOwner` to it, e.g.:
```tsx
import { visibleForOwner } from "@/lib/account-grouping";
```
(If there's no existing import from that module in this file, add this line near the other `@/lib` imports.)

- [ ] **Step 2: Apply the filter before splitting into sections**

Replace:
```tsx
  const accounts = listData?.accounts ?? [];
```
with:
```tsx
  const allAccounts = listData?.accounts ?? [];
  const accounts = visibleForOwner(allAccounts, owner);
```
(`accounts` is now the owner-filtered list; section subtotals, tiles, and groups all derive from it, which is what we want.)

- [ ] **Step 3: Remove the `actions` prop on DashboardSection**

In the `CLASS_SECTIONS.map(...)` block, delete the line:
```tsx
              actions={cls === "asset" ? <AccountForm defaultCurrency={base || undefined} /> : undefined}
```

- [ ] **Step 4: Remove the now-unused AccountForm import**

Delete the `import { AccountForm } from "@/components/account-form";` line from `dashboard.tsx` (it's now owned by `DashboardSection`). If the editor/tsgo reports `AccountForm` still used, leave it; otherwise remove it.

- [ ] **Step 5: Typecheck (full web build)**

Run:
```bash
cd apps/web && bun run build
```
Expected: PASS — no type errors. (`tsgo -b && vite build` both succeed.)

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/routes/dashboard.tsx
git commit -m "feat(web): owner toggle filters the account list"
```

---

### Task 7: Update e2e helpers/specs for the dot menu

"Add account" is no longer a top-level button; it's a `DropdownMenuItem` behind each section's actions menu (`aria-label="Assets actions"` / `"Liabilities actions"`).

**Files:**
- Modify: `e2e/tests/helpers.ts`
- Modify: `e2e/tests/dashboard-tiles.spec.ts`

- [ ] **Step 1: Update the `createAccount` helper**

In `e2e/tests/helpers.ts`, replace:
```ts
  await page.getByRole("button", { name: "Add account" }).click();
```
with:
```ts
  await page.getByRole("button", { name: "Assets actions" }).click();
  await page.getByRole("menuitem", { name: "Add account" }).click();
```

- [ ] **Step 2: Update the inline open in `ownership.spec.ts`**

In `e2e/tests/ownership.spec.ts`, replace the line (around line 27):
```ts
    await page.getByRole("button", { name: "Add account" }).click();
```
with:
```ts
    await page.getByRole("button", { name: "Assets actions" }).click();
    await page.getByRole("menuitem", { name: "Add account" }).click();
```

- [ ] **Step 3: Update `dashboard-tiles.spec.ts`**

In `e2e/tests/dashboard-tiles.spec.ts`, replace the assertion (around line 14):
```ts
  // Add account lives in the Assets section now (not top-right).
  await expect(page.getByRole("button", { name: "Add account" })).toBeVisible();
```
with:
```ts
  // Add account now lives behind the Assets section actions (dot) menu.
  await expect(page.getByRole("button", { name: "Assets actions" })).toBeVisible();
  await page.getByRole("button", { name: "Assets actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Add account" })).toBeVisible();
```

- [ ] **Step 4: Commit**

```bash
git add e2e/tests/helpers.ts e2e/tests/ownership.spec.ts e2e/tests/dashboard-tiles.spec.ts
git commit -m "test(e2e): open Add account via section dot menu"
```

---

### Task 8: Run affected e2e specs

**Files:** none (verification).

- [ ] **Step 1: Run the affected specs**

Run:
```bash
bun run e2e -- accounts.spec.ts ownership.spec.ts dashboard-tiles.spec.ts
```
Expected: all pass. If `accounts.spec.ts` does not exist, run the specs that use `createAccount` plus `ownership.spec.ts dashboard-tiles.spec.ts`. Investigate and fix any failure before finishing (common culprits: the actions-menu `aria-label`, or the Group `Select` intercepting focus in the dialog).

- [ ] **Step 2: Final web build**

Run:
```bash
cd apps/web && bun run build
```
Expected: PASS.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix(web): address e2e fallout for dashboard section actions"
```
(Skip if there was nothing to fix.)

---

## Self-Review notes

- **Spec coverage:** Feature 1 (dot menu everywhere, per-section, prefills class) → Task 5. Feature 2 (owner filter incl. shared) → Tasks 2 + 6. Feature 3 (Group field + add-to-group/bucket context menu, RHF) → Tasks 1, 3, 4, 5. e2e updates → Task 7–8.
- **Manual check before declaring done** (no automated coverage): toggling to a member hides other members' solo accounts but keeps shared ones; right-clicking an owner bucket → "Add account to this group" opens the form with that bucket's owners checked and no group; right-clicking a custom group prefills the Group select; the dot menu shows on both Assets and Liabilities and both can add accounts of the right class.
- **Type consistency:** `FormValues` / `AccountFormInitial` (Task 3) are consumed in Task 5; `visibleForOwner` (Task 2) consumed in Task 6; `onAddAccount` (Task 4) wired in Task 5.
