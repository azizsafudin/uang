# Dashboard: toolbar dot-menu, owner-filtered list, and group add-account actions

**Date:** 2026-06-15
**Status:** Approved (pending spec review)

## Summary

Three related dashboard improvements, plus a supporting refactor of the
account-creation form to react-hook-form:

1. **Toolbar 3-dot menu** — collapse each section's `Add account` + `New group`
   controls into a `DropdownMenu` (everywhere, not just mobile), leaving the
   subtotal inline. Declutters the crowded header.
2. **Owner toggle filters the account list** — selecting a member (e.g. "Aziz")
   shows only the accounts that member owns, including shared accounts.
3. **"Add account to this group" context menu** — add an action to both default
   owner buckets and custom groups that opens the account form prefilled for
   that group/bucket. Requires adding a **Group** field to the form.

## Context

- Dashboard route: `apps/web/src/routes/dashboard.tsx` — owns the `owner`
  toggle state, fetches net worth, splits accounts into asset/liability
  `DashboardSection`s.
- `apps/web/src/components/dashboard-section.tsx` — renders the section header
  toolbar (`Add account` via the `actions` prop, subtotal, inline `New group`
  flow) and the group rows.
- `apps/web/src/components/account-group-row.tsx` — renders a group/bucket row;
  already has a shadcn `ContextMenu` with Rename / Delete for **custom groups
  only** (owner buckets currently have no menu).
- `apps/web/src/components/account-form.tsx` — self-contained Dialog with its
  own open state and trigger button; fields: Name, Type (class), Category
  (subtype), Currency, Owners. Always inserts `groupId: null`.
- `apps/web/src/components/net-worth-toggle.tsx` — `Household | <member> …`
  toggle. Today it only drives the headline; the list always reflects the whole
  household (see the comment in `dashboard.tsx`).
- Grouping logic: `apps/web/src/lib/account-grouping.ts` — `build()` produces
  custom-group members plus owner buckets (`homeBucketId` → `owner:<ownerKey>`)
  for ungrouped accounts. `AccountValuation` carries `ownerIds: string[]`,
  `shared: boolean`, `groupId: string | null`.
- Available shadcn primitives: `dropdown-menu.tsx`, `select.tsx`,
  `context-menu.tsx`. **react-hook-form is not installed**; there is no shadcn
  `form.tsx`.

## Decisions (resolved during brainstorming)

- Dot menu applies **everywhere** (all breakpoints), not mobile-only.
- Owner filter **includes shared accounts**: an account is shown when
  `owner === "household"` or `account.ownerIds.includes(owner)`.
- Owner buckets get the **Add account** menu item too; for a bucket it prefills
  **Owners** (no group), since a bucket is not a real group. Custom groups
  prefill the **Group** select.
- Each section's dot menu is **per-section**: "Add account" prefills that
  section's **class** (asset vs liability). (Previously "Add account" appeared
  only in the assets section.)
- Form state moves to **raw react-hook-form** (`useForm` + `Controller`),
  keeping the existing `Field` wrapper and custom controlled inputs. We do
  **not** add shadcn's `form.tsx` layer — it would duplicate `Field`.

## Design

### Feature 1 — Section toolbar dot menu

In `dashboard-section.tsx`, replace the inline `actions` (Add account button)
and the `+ New group` button with a single `DropdownMenu` triggered by a
`MoreVertical` icon button (ghost, `size="icon"`, `h-6 w-6`), placed after the
subtotal. Menu items:

- **Add account** → calls `openAddAccount({ class: <section class> })`.
- **New group** → enters the existing inline-input new-group flow
  (`setNewGroupOpen(true)`), unchanged otherwise.

The inline new-group `Input`/`Create`/`Cancel` UI stays as-is; only its
entry point moves into the menu. The subtotal `Money` span remains inline.

The `actions` prop on `DashboardSection` is removed; `dashboard.tsx` no longer
passes `<AccountForm/>` as `actions`. Instead each `DashboardSection` owns its
own controlled `AccountForm` instance (see Feature 3 wiring).

### Feature 2 — Owner toggle filters the list

In `dashboard.tsx`, derive the displayed accounts from the household list
filtered by the current `owner`:

```ts
const visible = (listData?.accounts ?? []).filter(
  (a) => owner === "household" || a.ownerIds.includes(owner),
);
```

Split `visible` (instead of the full list) into asset/liability sets passed to
the sections. Consequences, all automatic:

- Owner buckets reduce to the selected member's buckets (their solo bucket and
  any shared buckets they co-own) via the existing `build()`.
- Custom groups show only matching accounts; a group with zero matches is
  hidden (already handled by `build()` / empty members).
- Section subtotals (computed from the passed accounts) reflect the filtered
  view. The headline keeps using `fetchNw(owner)`.

**Shared-account balances:** the list shows each account's **full** balance,
while the headline `fetchNw(owner)` splits a shared account across owners. So
under "Aziz" a shared account appears at full value in the list but contributes
only Aziz's share to the headline. Accepted: the list answers "accounts Aziz is
part of," not "Aziz's share."

No backend or query changes — the household list query is unchanged; filtering
is purely client-side.

### Feature 3 — Group field + "Add account to this group"

**Form refactor (react-hook-form).** Convert `AccountForm` to:

- A **controlled** dialog: props `open: boolean`, `onOpenChange`,
  `initial?: Partial<FormValues>`, `groups: GroupRow[]`, `defaultCurrency?`.
  Remove the internal `DialogTrigger`/button — the parent owns the trigger.
- `useForm<FormValues>()` where
  `FormValues = { name; class: "asset"|"liability"; subtype; currency; ownerIds: string[]; groupId: string | null }`.
- On open, `reset({ ...defaults, ...initial })` (effect keyed on `open`), so a
  prefill from a context menu lands cleanly. `defaults` sets currency from
  `defaultCurrency`, ownerIds to `[meId]`, class to `"asset"`, subtype `"bank"`,
  `groupId: null`.
- Native inputs (`name`) via `register`; controlled inputs (`Select` for
  class/subtype, `CurrencySelect`, `OwnersField`, and the new Group `Select`)
  via `Controller`. Keep the existing `Field` label/hint wrapper.
- `onSubmit` (via `handleSubmit`) builds the `AccountRow` as today but reads
  `groupId` from the form (instead of hard-coding `null`) and `ownerIds` from
  the form. Then `accountsCollection.insert`, invalidate `["networth"]`, close.

**Group field.** A new `Field label="Group"` with a `Select`:

- Options: custom groups whose `class` matches the current form `class`, plus a
  "No group" option (value sentinel, maps to `groupId: null`).
- When the form `class` changes and the selected group no longer matches the new
  class, reset `groupId` to null.

`DashboardSection` already receives the section's groups (it passes them to
`build()`); it forwards those same groups into its `AccountForm` instance to
populate the Group select.

**Context menu.** In `account-group-row.tsx`, add an **Add account to this
group** `ContextMenuItem` available for **both** owner buckets and custom
groups (so owner buckets now get a context menu where they had none):

- Custom group → `onAddAccount({ class, groupId: <group.id> })`.
- Owner bucket → `onAddAccount({ class, ownerIds: <bucket owner ids> })`.

The row needs the bucket's owner ids (derive from the bucket id /
`ownerKey`, or pass through from `build()`), and an `onAddAccount(prefill)`
callback prop threaded down from `DashboardSection`.

**Wiring.** `DashboardSection` owns:

- `const [addState, setAddState] = useState<{ open: boolean; initial?: Partial<FormValues> }>(...)`
- `openAddAccount(prefill)` → sets `initial` (merging the section class) and
  `open: true`. Passed to the dot menu's "Add account" and to each group row's
  context menu.
- One `<AccountForm open=… onOpenChange=… initial=… groups=… />` instance.

## Dependencies / setup

- Add `react-hook-form` to `apps/web` (`bun add react-hook-form`). No resolver
  or zod needed — validation stays light (`required` on name).
- No new shadcn components needed (`dropdown-menu`, `select`, `context-menu`
  already present). `MoreVertical` icon from the existing icon set (lucide).

## Testing

- **Unit:** extend `account-grouping` coverage if filtering helper is extracted;
  otherwise the filter is a one-liner in the route.
- **Route/component:** AccountForm submit still creates an account with the
  selected `groupId` and `ownerIds`.
- **E2E (end of slice):** affected specs — `accounts.spec.ts` (add account,
  now via dot menu + group field) and `ownership.spec.ts` (owner toggle now
  filters the list; shared accounts visible under each co-owner). Update
  selectors where the `Add account` button moved into the dot menu.

## Out of scope

- No change to how shared-account balances are split in the headline.
- No backend/schema changes.
- No drag-and-drop changes.
- Renaming/deleting owner buckets stays disallowed (only Add account is added).
