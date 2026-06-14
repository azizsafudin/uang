# Account Edit / Archive / Delete + Form Tooltips Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users edit an account's name/institution, archive it (reversible soft delete), permanently delete an archived account, and display explanatory tooltips on account form fields.

**Architecture:** New `DELETE /accounts/:id` API endpoint (cascade inside a transaction; only allowed when `isArchived = 1`) + `onDelete` added to `accountsCollection`. Two new components: `FieldTooltip` (thin `@base-ui/react/tooltip` wrapper) and `EditAccountInline` (inline edit card mirroring the existing "Edit owners" pattern). The account detail page gains an inline edit section and a danger zone at the bottom; tooltips are sprinkled into the existing `AccountForm`.

**Tech Stack:** Elysia + Drizzle (API), `@base-ui/react/tooltip` (tooltip primitive), `@tanstack/react-db` collection update/delete, TanStack Router `useNavigate`, Tailwind CSS

---

## File map

| Action | Path |
|--------|------|
| Modify | `apps/api/src/routes/accounts.ts` — add DELETE endpoint |
| Modify | `apps/api/src/routes/accounts.test.ts` — two new DELETE tests |
| Modify | `apps/web/src/lib/collections.ts` — add `onDelete` to `accountsCollection` |
| Create | `apps/web/src/components/field-tooltip.tsx` |
| Modify | `apps/web/src/components/account-form.tsx` — add tooltips |
| Create | `apps/web/src/components/edit-account-inline.tsx` |
| Modify | `apps/web/src/routes/account-detail.tsx` — inline edit + danger zone |

---

## Task 1: DELETE /accounts/:id API endpoint

**Files:**
- Modify: `apps/api/src/routes/accounts.ts`
- Modify: `apps/api/src/routes/accounts.test.ts`

- [ ] **Step 1: Write the two failing tests**

Append to `apps/api/src/routes/accounts.test.ts`:

```typescript
test("DELETE /:id removes an archived account and cascades its data", async () => {
  const app = makeApp(accountsRoutes);
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });

  // Create with an opening balance (produces an entry row)
  const { id } = await (
    await app.handle(
      new Request("http://localhost/accounts", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          name: "Old Bank",
          class: "asset",
          subtype: "bank",
          currency: "USD",
          openingBalanceMinor: 50000,
        }),
      }),
    )
  ).json();

  // Archive first
  await app.handle(
    new Request(`http://localhost/accounts/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ isArchived: true }),
    }),
  );

  // Delete
  const del = await app.handle(
    new Request(`http://localhost/accounts/${id}`, {
      method: "DELETE",
      headers: { cookie },
    }),
  );
  expect(del.status).toBe(200);
  expect((await del.json()).ok).toBe(true);

  // Gone from list
  const list = await (
    await app.handle(
      new Request("http://localhost/accounts", { headers: { cookie } }),
    )
  ).json();
  expect(list.find((a: any) => a.id === id)).toBeUndefined();
});

test("DELETE /:id rejects a non-archived account with 422", async () => {
  const app = makeApp(accountsRoutes);
  const { cookie } = await initAndLogin({ app });

  const { id } = await (
    await app.handle(
      new Request("http://localhost/accounts", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          name: "Active",
          class: "asset",
          subtype: "bank",
          currency: "USD",
        }),
      }),
    )
  ).json();

  const del = await app.handle(
    new Request(`http://localhost/accounts/${id}`, {
      method: "DELETE",
      headers: { cookie },
    }),
  );
  expect(del.status).toBe(422);
  expect((await del.json()).error).toBe("not_archived");
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/api && bun test src/routes/accounts.test.ts 2>&1 | tail -20
```

Expected: both new tests fail with "not a function" or 404 (no DELETE route yet).

- [ ] **Step 3: Add the DELETE endpoint to accounts.ts**

Replace the import line at the top of `apps/api/src/routes/accounts.ts`:

```typescript
import { accounts, entries, accountOwners, lots } from "../db/schema";
```

Then append the `.delete` route at the end of the chain, before the final semicolon:

```typescript
  .delete("/:id", async ({ params, set }: any) => {
    const [account] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.id, params.id));
    if (!account) {
      set.status = 404;
      return { error: "not_found" };
    }
    if (!account.isArchived) {
      set.status = 422;
      return { error: "not_archived" };
    }
    await db.transaction(async (tx) => {
      await tx
        .delete(accountOwners)
        .where(eq(accountOwners.accountId, params.id));
      await tx.delete(entries).where(eq(entries.accountId, params.id));
      await tx.delete(lots).where(eq(lots.accountId, params.id));
      await tx.delete(accounts).where(eq(accounts.id, params.id));
    });
    return { ok: true };
  });
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && bun test src/routes/accounts.test.ts 2>&1 | tail -20
```

Expected: all tests pass, including the two new DELETE tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/accounts.ts apps/api/src/routes/accounts.test.ts
git commit -m "feat(api): DELETE /accounts/:id — cascade delete, archived-only guard"
```

---

## Task 2: Add onDelete to accountsCollection

**Files:**
- Modify: `apps/web/src/lib/collections.ts`

No new tests needed — the API is already tested. The collection's `onDelete` is a thin adapter.

- [ ] **Step 1: Add onDelete inside accountsCollection**

In `apps/web/src/lib/collections.ts`, inside the `queryCollectionOptions` block for `accountsCollection`, add `onDelete` after the existing `onUpdate` handler:

```typescript
    onDelete: async ({ transaction }) => {
      const id = (transaction.mutations[0]?.original as AccountRow | undefined)
        ?.id;
      if (!id) return;
      const { error } = await api.accounts({ id }).delete();
      if (error) throw new Error(String(error));
    },
```

- [ ] **Step 2: Verify TypeScript is happy**

```bash
cd apps/web && bun tsc --noEmit 2>&1 | head -20
```

Expected: no errors (the Eden client derives the DELETE method automatically from the API schema).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/collections.ts
git commit -m "feat(web): accountsCollection onDelete — calls DELETE /accounts/:id"
```

---

## Task 3: FieldTooltip component

**Files:**
- Create: `apps/web/src/components/field-tooltip.tsx`

`@base-ui/react/tooltip` is already installed (it ships with `@base-ui/react`).

- [ ] **Step 1: Create the component**

Create `apps/web/src/components/field-tooltip.tsx`:

```tsx
import { Tooltip } from "@base-ui/react/tooltip";
import { InfoIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function FieldTooltip({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return (
    <Tooltip.Root delay={200}>
      <Tooltip.Trigger
        className={cn(
          "ml-1 inline-flex cursor-default items-center text-muted-foreground hover:text-foreground focus:outline-none",
          className,
        )}
        aria-label={content}
      >
        <InfoIcon className="size-3.5" />
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner sideOffset={4}>
          <Tooltip.Popup className="z-50 max-w-xs rounded-lg bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-md ring-1 ring-foreground/10">
            {content}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd apps/web && bun tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/field-tooltip.tsx
git commit -m "feat(web): FieldTooltip — base-ui tooltip wrapper for form labels"
```

---

## Task 4: Add tooltips to AccountForm

**Files:**
- Modify: `apps/web/src/components/account-form.tsx`

- [ ] **Step 1: Add the FieldTooltip import**

At the top of `apps/web/src/components/account-form.tsx`, add:

```typescript
import { FieldTooltip } from "@/components/field-tooltip";
```

- [ ] **Step 2: Replace the four plain Labels with tooltip-annotated Labels**

Replace the `<Label>Type</Label>` line:

```tsx
<Label className="inline-flex items-center">
  Type
  <FieldTooltip content="Asset = something you own; Liability = a debt or obligation" />
</Label>
```

Replace the `<Label>Category</Label>` line:

```tsx
<Label className="inline-flex items-center">
  Category
  <FieldTooltip content="How this account is categorised on the dashboard" />
</Label>
```

Replace the `<Label>Valuation</Label>` line:

```tsx
<Label className="inline-flex items-center">
  Valuation
  <FieldTooltip content="Ledger: you record the balance manually from your statement. Holdings: value is calculated from your investment positions (units × current price)" />
</Label>
```

Replace the `<Label>Currency</Label>` line (inside the `grid grid-cols-2` block):

```tsx
<Label className="inline-flex items-center">
  Currency
  <FieldTooltip content="3-letter ISO code, e.g. SGD, USD, MYR" />
</Label>
```

- [ ] **Step 3: Verify TypeScript**

```bash
cd apps/web && bun tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/account-form.tsx
git commit -m "feat(web): add field tooltips to AccountForm (Type, Category, Valuation, Currency)"
```

---

## Task 5: EditAccountInline component

**Files:**
- Create: `apps/web/src/components/edit-account-inline.tsx`

- [ ] **Step 1: Create the component**

Create `apps/web/src/components/edit-account-inline.tsx`:

```tsx
import { useState } from "react";
import { accountsCollection, type AccountRow } from "@/lib/collections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Eyebrow } from "@/components/app-layout";

export function EditAccountInline({ account }: { account: AccountRow }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(account.name);
  const [institution, setInstitution] = useState(account.institution ?? "");

  function openForm() {
    setName(account.name);
    setInstitution(account.institution ?? "");
    setOpen(true);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    await accountsCollection.update(account.id, (draft) => {
      draft.name = name.trim();
      draft.institution = institution.trim() || null;
    });
    setOpen(false);
  }

  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={openForm}>
        Edit account
      </Button>
    );
  }

  return (
    <div className="max-w-xs space-y-3 rounded-xl border border-border bg-card p-4">
      <Eyebrow>Edit account</Eyebrow>
      <form onSubmit={save} className="space-y-3">
        <div>
          <Label>Name</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <div>
          <Label>Institution</Label>
          <Input
            value={institution}
            onChange={(e) => setInstitution(e.target.value)}
            placeholder="optional"
          />
        </div>
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={!name.trim()}>
            Save
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd apps/web && bun tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/edit-account-inline.tsx
git commit -m "feat(web): EditAccountInline — inline name/institution editor"
```

---

## Task 6: Account detail page — inline edit + danger zone

**Files:**
- Modify: `apps/web/src/routes/account-detail.tsx`

The existing page already handles ledger entries (history section) and holdings (HoldingsDetail). We add:
1. An "Edit account" section below the header (uses `EditAccountInline`).
2. A danger zone at the bottom: archive (or restore) + permanent delete.
3. Archived banner at the top when `isArchived === 1`.

The delete confirmation is a Dialog with a name-match input (re-uses the existing Dialog component).

- [ ] **Step 1: Add new imports to account-detail.tsx**

At the top of `apps/web/src/routes/account-detail.tsx`, add these imports:

```typescript
import { useNavigate } from "@tanstack/react-router";
import { EditAccountInline } from "@/components/edit-account-inline";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
```

- [ ] **Step 2: Add state for delete confirmation and wire up navigate**

Inside `AccountDetailPage`, add these **before the first `if` early return** (hooks must not come after early returns):

```typescript
const nav = useNavigate();
const [deleteOpen, setDeleteOpen] = useState(false);
const [deleteName, setDeleteName] = useState("");
```

- [ ] **Step 3: Add archive, restore, and delete handlers**

Add these three functions **between the two early returns** — after `if (accountsLoading || !account) { return ... }` but BEFORE `if (account.valuationMode === "holdings") { return ... }`. They are used in both the holdings and ledger JSX branches:

```typescript
async function archiveAccount() {
  await accountsCollection.update(account.id, (draft) => {
    draft.isArchived = 1;
  });
  await qc.invalidateQueries({ queryKey: ["networth"] });
}

async function restoreAccount() {
  await accountsCollection.update(account.id, (draft) => {
    draft.isArchived = 0;
  });
  await qc.invalidateQueries({ queryKey: ["networth"] });
}

async function deleteAccount() {
  await accountsCollection.delete(account.id);
  await qc.invalidateQueries({ queryKey: ["networth"] });
  await nav({ to: "/" });
}
```

- [ ] **Step 4: Add the archived banner, edit section, and danger zone to the JSX**

In the ledger branch of the return statement (the main `<AppShell>` return — not the holdings branch), make the following three additions:

**a) Archived banner** — insert immediately after the opening `<AppShell actions={<BackButton />}>` tag:

```tsx
{account.isArchived === 1 && (
  <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
    This account is archived and hidden from the dashboard.
  </div>
)}
```

**b) Edit section** — insert after `</header>` and before the owners section (`<section className="mt-4">`):

```tsx
<section className="mt-4">
  <EditAccountInline account={account} />
</section>
```

**c) Danger zone** — insert at the very end of the page, after the `</section>` that wraps the history list:

```tsx
<section className="mt-12 border-t border-border pt-6">
  <Eyebrow className="mb-3 text-destructive">Danger zone</Eyebrow>
  {account.isArchived === 0 ? (
    <div className="flex items-center justify-between rounded-xl border border-border bg-card px-4 py-3">
      <div>
        <p className="text-sm font-medium">Archive account</p>
        <p className="text-xs text-muted-foreground">
          Hides it from the dashboard. You can restore it later.
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={archiveAccount}>
        Archive
      </Button>
    </div>
  ) : (
    <div className="space-y-3">
      <div className="flex items-center justify-between rounded-xl border border-border bg-card px-4 py-3">
        <div>
          <p className="text-sm font-medium">Restore account</p>
          <p className="text-xs text-muted-foreground">
            Makes it visible on the dashboard again.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={restoreAccount}>
          Restore
        </Button>
      </div>
      <div className="flex items-center justify-between rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3">
        <div>
          <p className="text-sm font-medium text-destructive">
            Delete permanently
          </p>
          <p className="text-xs text-muted-foreground">
            Removes all history. Cannot be undone.
          </p>
        </div>
        <Dialog
          open={deleteOpen}
          onOpenChange={(open) => {
            setDeleteOpen(open);
            if (!open) setDeleteName("");
          }}
        >
          <DialogTrigger render={<Button variant="destructive" size="sm" />}>
            Delete permanently
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete "{account.name}" permanently?</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              This deletes the account and all its history. Type the account
              name to confirm.
            </p>
            <Input
              value={deleteName}
              onChange={(e) => setDeleteName(e.target.value)}
              placeholder={account.name}
            />
            <DialogFooter>
              <Button
                variant="destructive"
                disabled={deleteName !== account.name}
                onClick={deleteAccount}
              >
                Delete permanently
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  )}
</section>
```

- [ ] **Step 5: Apply the same archived banner + edit section to the holdings branch**

The holdings branch is the `if (account.valuationMode === "holdings")` early return. Add the same archived banner and edit section there, and a matching danger zone, so holdings accounts can also be archived/deleted:

```tsx
if (account.valuationMode === "holdings") {
  return (
    <AppShell actions={<BackButton />}>
      {account.isArchived === 1 && (
        <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
          This account is archived and hidden from the dashboard.
        </div>
      )}
      <section className="mb-4">
        <EditAccountInline account={account} />
      </section>
      <HoldingsDetail accountId={id} accountName={account.name} />
      <section className="mt-12 border-t border-border pt-6">
        <Eyebrow className="mb-3 text-destructive">Danger zone</Eyebrow>
        {account.isArchived === 0 ? (
          <div className="flex items-center justify-between rounded-xl border border-border bg-card px-4 py-3">
            <div>
              <p className="text-sm font-medium">Archive account</p>
              <p className="text-xs text-muted-foreground">
                Hides it from the dashboard. You can restore it later.
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={archiveAccount}>
              Archive
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-xl border border-border bg-card px-4 py-3">
              <div>
                <p className="text-sm font-medium">Restore account</p>
                <p className="text-xs text-muted-foreground">
                  Makes it visible on the dashboard again.
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={restoreAccount}>
                Restore
              </Button>
            </div>
            <div className="flex items-center justify-between rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3">
              <div>
                <p className="text-sm font-medium text-destructive">
                  Delete permanently
                </p>
                <p className="text-xs text-muted-foreground">
                  Removes all history. Cannot be undone.
                </p>
              </div>
              <Dialog
                open={deleteOpen}
                onOpenChange={(open) => {
                  setDeleteOpen(open);
                  if (!open) setDeleteName("");
                }}
              >
                <DialogTrigger render={<Button variant="destructive" size="sm" />}>
                  Delete permanently
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Delete "{account.name}" permanently?</DialogTitle>
                  </DialogHeader>
                  <p className="text-sm text-muted-foreground">
                    This deletes the account and all its history. Type the
                    account name to confirm.
                  </p>
                  <Input
                    value={deleteName}
                    onChange={(e) => setDeleteName(e.target.value)}
                    placeholder={account.name}
                  />
                  <DialogFooter>
                    <Button
                      variant="destructive"
                      disabled={deleteName !== account.name}
                      onClick={deleteAccount}
                    >
                      Delete permanently
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </div>
        )}
      </section>
    </AppShell>
  );
}
```

- [ ] **Step 6: Verify TypeScript**

```bash
cd apps/web && bun tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 7: Run all API tests to confirm nothing regressed**

```bash
cd apps/api && bun test 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/routes/account-detail.tsx
git commit -m "feat(web): account detail — inline edit, archive/restore, delete permanently"
```
