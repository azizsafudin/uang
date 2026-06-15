# Per-group header colors — design

**Date:** 2026-06-15
**Status:** Approved

## Goal

On `/dashboard`, right-clicking a group header (in the Assets or Liabilities
section) offers a **"Set color"** action that opens a palette of swatches. The
chosen color tints that group's header and is persisted to the database, so it
survives reloads and is shared across the household.

Only user-created **groups** get this action. Owner buckets (auto-generated
cards) keep no menu actions, consistent with how Rename/Delete already work.

## Data model

Add a nullable `color` column to the `groups` table:

```ts
// apps/api/src/db/schema.ts — groups
color: text("color"),   // nullable; semantic key (e.g. "blue") or null = default
```

We store a **semantic key**, not a raw hex value. Rationale:

- Theming stays consistent and the frontend owns the actual color values.
- Avoids light/dark contrast problems that arbitrary hex would introduce.
- Validatable on the server against a fixed set.

`null` (or absent) = current default appearance (primary tint).

A drizzle migration is generated for the new column (`drizzle-kit generate`).

## Palette

A single frontend constant owns the keys and their base colors:

```
apps/web/src/lib/group-colors.ts
```

12 keys, in display order:

```
slate, red, orange, amber, yellow, lime, green, teal, cyan, blue, violet, pink
```

Each maps to a base color (oklch/hex) chosen to read well as both a soft
background tint and as foreground text in light and dark themes. The module
exports:

- `GROUP_COLORS`: ordered array of `{ key, base }`.
- `GROUP_COLOR_KEYS`: `readonly string[]` of just the keys (used for server
  validation and the `color` TS type).
- A helper to resolve a key → base color (returns `null` for unknown/null).

The picker UI also shows a **Default** (⊘) chip that clears the color
(sets `null`).

## Rendering

`AccountGroupRow` currently tints the header with:

```
bg-[color-mix(in_oklab,var(--color-primary)_6%,var(--color-card))]
```

and uses `text-primary` for the title, arrow, and subtotal.

When the group has a resolved color, the row instead:

- sets the header background to `color-mix(in oklab, <base> 8%, var(--color-card))`
- uses `<base>` for the title / arrow / subtotal text

This is driven by an inline CSS custom property (e.g. `--group-accent`) set on
the row when a color is present, with Tailwind/inline styles referencing it, so
it works in both themes and avoids per-key utility classes. No color → markup
and classes are exactly as today (zero visual change).

## Interaction

Add **"Set color"** to the existing group context menu in `AccountGroupRow`
(the menu that already holds Add account / Rename / Delete). Selecting it opens
the swatch palette — a submenu or popover containing the 12 swatches plus the
Default chip. Clicking a swatch:

1. Persists the new key immediately (optimistic via the collection).
2. Closes the menu.

The action is only wired up for real groups (an `onSetColor` prop, undefined for
buckets — same gating as `onRename`/`onDelete`).

## Persistence path

Mirrors the existing name / sortOrder flow end-to-end.

- **`apps/api/src/db/schema.ts`** — add `color` column (+ generated migration).
- **`apps/api/src/routes/groups.ts`**
  - `GET /` already returns all columns — no change needed.
  - `POST /` accepts optional `color`, persisted on insert.
  - `PATCH /:id` accepts optional `color`; when present, included in the update.
  - Validate `color` with `t.Optional(t.Union([...GROUP_COLOR_KEYS.map(t.Literal)]))`
    so only known keys (or a clear-to-null) are accepted. Allow explicit `null`
    to clear.
- **`apps/web/src/lib/collections.ts`**
  - `GroupRow.color: string | null`.
  - `onInsert` / `onUpdate` include `color` in the API payload.
- **`apps/web/src/components/dashboard-section.tsx`**
  - `setGroupColor(id, color)` → `groupsCollection.update(id, draft => { draft.color = color })`.
  - Pass the group's `color` and an `onSetColor` callback to `AccountGroupRow`
    (groups only; `undefined` for buckets).

## Type safety

No `as any`. The server validates against `GROUP_COLOR_KEYS` literals. On the
client, `color` is typed `string | null` on `GroupRow`; the picker only ever
emits one of the known keys or `null`.

## Testing

- **`apps/api/src/routes/groups.test.ts`**: PATCH persists `color`; invalid key
  is rejected (validation error); `color` round-trips through GET.
- **Web build** (`cd apps/web && bun run build`) for strict typecheck after API
  changes.
- **E2E**: run only the affected spec(s) at end of slice (accounts/dashboard
  grouping); full suite not required for this isolated change.

## Out of scope (YAGNI)

- Custom / arbitrary hex colors.
- Coloring owner buckets or individual accounts.
- Per-user color preferences (color is a property of the shared group).
