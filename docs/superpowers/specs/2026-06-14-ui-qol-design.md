# UI Quality-of-Life — Design Spec
_2026-06-14_

## Goal

Make it faster to understand the state of the household at a glance, and easier to manage accounts with fewer clicks and less confusion.

## Scope

Three interconnected areas:

1. **Dashboard** — improved account row layout, collapsible account groups, drag-to-reorder
2. **Account groups** — new data model + API to support named groups of accounts
3. **Account detail** — reorganised page layout, single-toggle edit mode, inline field hints

---

## 1. Account Groups — Data Model & API

### Schema additions

```sql
-- New table
groups (
  id        text primary key,   -- client-generated UUID
  name      text not null,
  class     text not null,      -- "asset" | "liability"
  sortOrder integer not null default 0
)

-- Existing table additions
accounts (
  + groupId   text references groups(id) on delete set null,
  + sortOrder integer not null default 0
)
```

`class` on a group mirrors the account class so groups only appear in their correct dashboard section. Deleting a group nullifies `groupId` on member accounts (does not delete them).

### New API routes

| Method | Route | Purpose |
|--------|-------|---------|
| `POST` | `/groups` | Create group |
| `PATCH` | `/groups/:id` | Rename group |
| `DELETE` | `/groups/:id` | Delete group (nullifies groupId on members) |
| `PATCH` | `/accounts/reorder` | Bulk-update sortOrder + groupId after drag |

`PATCH /accounts/reorder` body:
```ts
{
  items: Array<{ id: string; kind: "account" | "group"; sortOrder: number; groupId?: string | null }>
}
```

Groups themselves carry a `sortOrder` too (updated via the same endpoint under `kind: "group"`).

---

## 2. Dashboard

### Account row (spacious + icon)

Each account row:
- **Left**: round-cornered initials tile (28×28px), colored by subtype — green (`primary`) for bank/cash, gold for investment, red (`destructive`) for liability
- **Middle**: account name (medium weight), subtype · currency below (muted, small)
- **Right**: balance in native currency (serif, semi-bold); base currency equivalent below it if currency ≠ base (muted, small)
- **On hover**: drag handle (⠿) fades in on the far left

### Account groups

A collapsed group row:
- Tinted green background (`color-mix(primary, card, 6%)`)
- ▶ chevron, group name (semi-bold), member count (muted), combined base-currency total (serif, right-aligned)
- Clicking the row expands/collapses it

An expanded group:
- Group header row still shows subtotal (with ▼ chevron)
- Member account rows appear below, indented with a left border accent

### "New group" button

Small `+ New group` button in each section header (Assets / Liabilities), adjacent to the section total. Opens a small inline popover: name input + confirm. Creates the group at the bottom of that section, empty, ready to receive accounts via drag.

### Drag-to-reorder

Library: `@dnd-kit/core` + `@dnd-kit/sortable`.

- Every account row and group header row is draggable
- Dragging an account onto a group row (or between its expanded members) assigns it to that group (`groupId` updated)
- Dragging an account out to the top-level clears its `groupId`
- On drop: fire `PATCH /accounts/reorder` with updated `sortOrder` + `groupId` for all affected items
- Sort order is persisted; dashboard loads accounts pre-sorted by `sortOrder`

---

## 3. Account Detail Page

### Layout

```
[← Back]

ASSET · BANK · SGD          ← eyebrow
DBS Multiplier               ← Fraunces heading
S$42,100.00                  ← Fraunces large balance

┌─────────────────────────────────────┐
│ Account info              [✏ / ✕]  │  ← card header (muted bg)
├─────────────────────────────────────┤
│ Name        DBS Multiplier          │  ← view mode: kv rows
│ Institution DBS Bank                │
│ Group       —                       │
│ Owners      [You] [Partner]         │
└─────────────────────────────────────┘

[+ Set balance]  [Revalue]           ← action buttons

HISTORY
┌─────────────────────────────────────┐
│ S$42,100   2026-06-10 · Balance set │
│ S$40,000   2026-05-01 · Balance set │
└─────────────────────────────────────┘

── Danger zone ─────────────────────
Archive account                [Archive]
```

### Edit mode

Clicking ✏ (pencil icon, top-right of info card) toggles the entire card into edit mode:
- Icon changes to ✕; clicking it cancels without saving
- All four fields render as inputs simultaneously:
  - **Name** — text input
  - **Institution** — text input + hint: _"Optional. The bank or provider holding this account."_
  - **Group** — select (lists existing groups for this account's class + "New group…" option at the bottom). Selecting "New group…" reveals a text input below the dropdown to type the group name, with a small "Create" confirm button. On confirm: POST /groups, then set the new group's id as the selected value. + hint: _"Accounts in the same group are shown together on the dashboard."_
  - **Owners** — checkbox list + hint: _"Shared accounts (2+ owners) appear in household total only, not personal net worth."_
- Card footer: `Save` (primary) + `Cancel` (ghost)
- Save fires `PATCH /accounts/:id` (name, institution, groupId) and `PATCH /accounts/:id/owners` in parallel, then exits edit mode

### Form clarity (AccountForm — create dialog)

The existing hover-only `FieldTooltip` components are replaced with always-visible inline hints (one line of muted text below the input) for fields that are consistently confusing. Users should not need to hover to understand a field.

- **Type** — _"Assets grow your net worth; Liabilities reduce it."_
- **Category** — _"The kind of account: bank account, investment portfolio, property, etc."_
- **Valuation** — _"Ledger: you record balances manually. Holdings: valued from investment lots × prices."_
- **Owners** — _"Shared accounts (2+ owners) appear in household total only, not personal net worth."_

---

## Out of scope

- Dark mode for new components (follows existing CSS variable system automatically)
- Bulk operations (multi-select, bulk archive)
- Group-level currency or metadata beyond name + class + sortOrder
- Mobile-specific drag UX (drag-to-reorder is desktop-first; mobile can scroll-only for now)
