# Account Edit / Delete / Archive + Form Tooltips

**Date:** 2026-06-14
**Branch:** slice6-projections (or a new slice off main)

## Summary

Two features in one slice:

1. **Edit & delete accounts** — users can rename an account, archive it (soft delete, reversible), and permanently delete archived accounts.
2. **Form tooltips** — every ambiguous field in the account creation (and edit) form gets a small ⓘ tooltip explaining what it means.

---

## Architecture

### API (apps/api)

**New endpoint: `DELETE /accounts/:id`**
- Only succeeds if the account's `isArchived = 1`. Returns `422` if not archived.
- Cascades in a transaction: delete `accountOwners` rows, then `entries` rows, then `lots` rows, then the `accounts` row.
- No `instruments` or `prices` are deleted — those are shared across accounts.

No other API changes are needed. The existing `PATCH /accounts/:id` already accepts `isArchived` (boolean → stored as 0/1 integer).

### Collection (apps/web/src/lib/collections.ts)

Add `onDelete` to `accountsCollection`:
- Reads the original row's `id` from the mutation.
- Calls `DELETE /accounts/:id` via Eden.
- On error, throws so TanStack DB rolls back the optimistic update.

### Dashboard (apps/web/src/routes/dashboard.tsx)

Filter out accounts where `isArchived === 1` before rendering the Assets / Liabilities lists. Archived accounts are not counted in group totals.

### Account detail page (apps/web/src/routes/account-detail.tsx)

Three additions:

1. **Archived banner** — if `account.isArchived === 1`, show a yellow/amber notice at the top of the page.
2. **Inline edit section** — below the account header, an "Edit account" button expands an inline form (same visual card pattern as "Edit owners"). Contains: Name (required), Institution (optional). Class, subtype, currency, and valuationMode are intentionally not editable (changing them would corrupt existing entries/lots). On Save: `accountsCollection.update()` → triggers existing `onUpdate` → `PATCH /accounts/:id`.
3. **Danger zone section** — at the bottom of the page, below history:
   - When not archived: "Archive account" button → `accountsCollection.update({ isArchived: 1 })` → navigate to dashboard. No confirmation required (reversible).
   - When archived: "Restore" button → `accountsCollection.update({ isArchived: 0 })`. Plus "Delete permanently" button → opens an `AlertDialog` requiring the user to type the account name exactly → `accountsCollection.delete(id)` → navigate to dashboard.

### New component: EditAccountInline

`apps/web/src/components/edit-account-inline.tsx`

Props: `account: AccountRow`. Manages its own open/closed state. Renders the inline card when open, an "Edit account" ghost button when closed. Calls `accountsCollection.update()` on save.

### Tooltip helper

`apps/web/src/components/field-tooltip.tsx`

A tiny wrapper: `<FieldTooltip content="..." />` renders an ⓘ icon that shows a shadcn `Tooltip` on hover. Used inline after a `<Label>`.

Tooltip text (canonical, used in both create and edit forms):

| Field | Text |
|---|---|
| Type | "Asset = something you own; Liability = a debt or obligation" |
| Category | "How this account is categorised on the dashboard" |
| Valuation | "Ledger: you record the balance manually from your statement. Holdings: value is calculated from your investment positions (units × current price)" |
| Currency | "3-letter ISO code, e.g. SGD, USD, MYR" |

### Account form (apps/web/src/components/account-form.tsx)

Add `<FieldTooltip>` after the `<Label>` for Type, Category, Valuation, and Currency. No structural changes to the form logic.

---

## Data flow: permanent delete

```
User types account name → clicks "Delete permanently"
  → accountsCollection.delete(id)          [optimistic: removes row from UI]
  → onDelete fires → DELETE /accounts/:id
      → server checks isArchived = 1
      → transaction: delete accountOwners, entries, lots, account row
      → 200 ok
  → navigate("/")
  → qc.invalidateQueries(["networth"])
```

If the server returns an error (e.g. account not archived), TanStack DB rolls back the optimistic delete and the account reappears.

---

## Error handling

- `DELETE` on a non-archived account → API returns 422; collection throws; optimistic delete rolls back.
- `DELETE` on a non-existent account → API returns 404 (or no-op); navigate away regardless.
- Edit save with empty name → `required` on the input; form doesn't submit.
- Archive/restore failures → collection throws; UI snaps back (TanStack DB rollback).

---

## What is NOT in scope

- Drag-to-reorder accounts (sortOrder exists but is not exposed in this slice).
- Editing class, subtype, currency, or valuationMode (structural fields — would require migrating existing entries/lots).
- Bulk archive/delete.
- Showing archived accounts on the dashboard (a future "Show archived" toggle).
- Adding a "Retirement" subtype (separate slice if needed).
