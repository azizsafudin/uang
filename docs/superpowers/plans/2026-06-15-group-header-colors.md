# Per-group Header Colors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users set a color on a dashboard group via its right-click "Set color" menu, tinting the group header and persisting the choice to the database.

**Architecture:** Add a nullable `color` column (semantic key) to the `groups` table. A single frontend palette module owns the 12 keys and their base colors and is the source of truth for both server validation and rendering. The existing `groups` POST/PATCH routes and `groupsCollection` carry `color` end-to-end; `AccountGroupRow` gains a "Set color" submenu and tints its header from the resolved color.

**Tech Stack:** Bun, Elysia + Drizzle (libsql/SQLite), React + TanStack DB, shadcn ContextMenu, Tailwind (oklab color-mix).

---

## File Structure

- **Create** `apps/web/src/lib/group-colors.ts` — palette: keys, base colors, validation list, resolver. Shared by client rendering and (via re-export of the key list) referenced by the server route's validation.
- **Modify** `apps/api/src/db/schema.ts` — add `color` column to `groups`.
- **Create** `apps/api/drizzle/00XX_*.sql` — generated migration (via `bun run db:generate`).
- **Modify** `apps/api/src/routes/groups.ts` — accept `color` on POST + PATCH, validated.
- **Modify** `apps/api/src/routes/groups.test.ts` — color round-trip + invalid-key rejection.
- **Modify** `apps/web/src/lib/collections.ts` — `GroupRow.color`; send `color` in onInsert/onUpdate.
- **Modify** `apps/web/src/components/account-group-row.tsx` — "Set color" submenu + tinted header.
- **Modify** `apps/web/src/components/dashboard-section.tsx` — `setGroupColor` + pass `color`/`onSetColor`.

> **Note on the shared key list:** `apps/api` and `apps/web` are separate packages and the API route should not import from the web app. The canonical list of keys is defined **inside the API** in `apps/api/src/routes/groups.ts` (Task 2) and **independently** in `apps/web/src/lib/group-colors.ts` (Task 4). Both lists must contain the same 12 keys. Task 4's list is the rendering source of truth; Task 2's is the validation source of truth. They are small and stable; duplication is intentional to keep the package boundary clean.

---

## Task 1: Add `color` column to the groups schema + migration

**Files:**
- Modify: `apps/api/src/db/schema.ts:62-68`

- [ ] **Step 1: Add the column**

In `apps/api/src/db/schema.ts`, change the `groups` table definition to add a nullable `color` column:

```ts
export const groups = sqliteTable("groups", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  class: text("class").$type<"asset" | "liability">().notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  color: text("color"), // nullable; semantic palette key (see group-colors.ts) or null = default
  createdAt: integer("created_at").notNull(),
});
```

- [ ] **Step 2: Generate the migration**

Run: `bun run db:generate`
Expected: a new file `apps/api/drizzle/00XX_<name>.sql` is created containing `ALTER TABLE groups ADD color text;` (SQLite emits this as `ALTER TABLE \`groups\` ADD \`color\` text;`). The command prints the generated filename.

- [ ] **Step 3: Apply the migration locally**

Run: `bun run db:migrate`
Expected output: `migrations applied`

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle
git commit -m "feat(api): add nullable color column to groups"
```

---

## Task 2: Accept and validate `color` on the groups routes

**Files:**
- Modify: `apps/api/src/routes/groups.ts`
- Test: `apps/api/src/routes/groups.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/routes/groups.test.ts`:

```ts
test("PATCH persists a color and GET returns it", async () => {
  const app = makeApp(groupsRoutes);
  const { cookie } = await initAndLogin({ app });

  const create = await app.handle(
    new Request("http://localhost/groups", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Property", class: "asset" }),
    }),
  );
  const { id } = await create.json();

  const patch = await app.handle(
    new Request(`http://localhost/groups/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ color: "blue" }),
    }),
  );
  expect(patch.status).toBe(200);

  const [row] = await db.select().from(groups).where(eq(groups.id, id));
  expect(row.color).toBe("blue");

  // GET returns the persisted color.
  const list = await app.handle(
    new Request("http://localhost/groups", { headers: { cookie } }),
  );
  const rows = await list.json();
  expect(rows.find((g: { id: string }) => g.id === id)?.color).toBe("blue");
});

test("PATCH can clear a color with null", async () => {
  const app = makeApp(groupsRoutes);
  const { cookie } = await initAndLogin({ app });

  const create = await app.handle(
    new Request("http://localhost/groups", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Cash", class: "asset", color: "teal" }),
    }),
  );
  const { id } = await create.json();

  const patch = await app.handle(
    new Request(`http://localhost/groups/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ color: null }),
    }),
  );
  expect(patch.status).toBe(200);

  const [row] = await db.select().from(groups).where(eq(groups.id, id));
  expect(row.color).toBeNull();
});

test("PATCH rejects an unknown color key", async () => {
  const app = makeApp(groupsRoutes);
  const { cookie } = await initAndLogin({ app });

  const create = await app.handle(
    new Request("http://localhost/groups", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Bad", class: "asset" }),
    }),
  );
  const { id } = await create.json();

  const patch = await app.handle(
    new Request(`http://localhost/groups/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ color: "chartreuse" }),
    }),
  );
  expect(patch.status).toBe(422);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test apps/api/src/routes/groups.test.ts`
Expected: the three new tests FAIL — `color` is not yet read by the routes (persisted value is null / undefined) and the unknown-key request returns 200 instead of 422.

- [ ] **Step 3: Implement color handling + validation**

In `apps/api/src/routes/groups.ts`, add a key list and a reusable validator near the top (after imports):

```ts
// Semantic palette keys. Must stay in sync with apps/web/src/lib/group-colors.ts.
const GROUP_COLOR_KEYS = [
  "slate", "red", "orange", "amber", "yellow", "lime",
  "green", "teal", "cyan", "blue", "violet", "pink",
] as const;

// A valid color is one of the known keys, or null to clear.
const colorSchema = t.Union([
  ...GROUP_COLOR_KEYS.map((k) => t.Literal(k)),
  t.Null(),
]);
```

Update the POST handler to persist `color` (default null) and add it to the POST body schema:

```ts
  .post(
    "/",
    async ({ body, set }: any) => {
      const id = body.id ?? createId();
      try {
        await db.insert(groups).values({
          id,
          name: body.name,
          class: body.class,
          sortOrder: body.sortOrder ?? 0,
          color: body.color ?? null,
          createdAt: nowEpoch(),
        });
      } catch (e) {
        if (isUniqueViolation(e)) {
          set.status = 409;
          return { error: "duplicate_id" };
        }
        throw e;
      }
      return { id };
    },
    {
      body: t.Object({
        id: t.Optional(t.String()),
        name: t.String({ minLength: 1 }),
        class: t.Union([t.Literal("asset"), t.Literal("liability")]),
        sortOrder: t.Optional(t.Number()),
        color: t.Optional(colorSchema),
      }),
    },
  )
```

Update the PATCH handler to apply `color` when the key is present (so `null` clears it, while omitting the field leaves it unchanged) and add it to the PATCH body schema:

```ts
  .patch(
    "/:id",
    async ({ params, body }: any) => {
      const update: Record<string, unknown> = {};
      if (body.name !== undefined) update.name = body.name;
      if (body.sortOrder !== undefined) update.sortOrder = body.sortOrder;
      if (body.color !== undefined) update.color = body.color;
      await db.update(groups).set(update).where(eq(groups.id, params.id));
      return { ok: true };
    },
    {
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1 })),
        sortOrder: t.Optional(t.Number()),
        color: t.Optional(colorSchema),
      }),
    },
  )
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test apps/api/src/routes/groups.test.ts`
Expected: all tests PASS (including the existing ones).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/groups.ts apps/api/src/routes/groups.test.ts
git commit -m "feat(api): accept and validate group color on create/update"
```

---

## Task 3: Carry `color` through the web groups collection

**Files:**
- Modify: `apps/web/src/lib/collections.ts:272-313`

- [ ] **Step 1: Add `color` to the GroupRow type**

In `apps/web/src/lib/collections.ts`, update `GroupRow`:

```ts
export type GroupRow = {
  id: string;
  name: string;
  class: "asset" | "liability";
  sortOrder: number;
  color: string | null;
  createdAt: number;
};
```

- [ ] **Step 2: Send `color` in onInsert and onUpdate**

In the same file, update the collection's `onInsert` payload:

```ts
      const { error } = await api.groups.post({
        id: m.id,
        name: m.name,
        class: m.class,
        sortOrder: m.sortOrder,
        color: m.color,
      });
```

and the `onUpdate` payload:

```ts
      const { error } = await api.groups({ id: m.id }).patch({
        name: m.name,
        sortOrder: m.sortOrder,
        color: m.color,
      });
```

- [ ] **Step 3: Typecheck via the web build**

Run: `cd apps/web && bun run build`
Expected: build succeeds with no type errors. (`color` now flows through the Eden-typed API calls; the route changes from Task 2 make these payload fields valid.)

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/collections.ts
git commit -m "feat(web): carry group color through the groups collection"
```

---

## Task 4: Create the frontend palette module

**Files:**
- Create: `apps/web/src/lib/group-colors.ts`

- [ ] **Step 1: Write the palette module**

Create `apps/web/src/lib/group-colors.ts`:

```ts
// Source of truth for group header colors on the web client.
// The key list must stay in sync with GROUP_COLOR_KEYS in
// apps/api/src/routes/groups.ts (server-side validation).

export type GroupColor = {
  /** Semantic key persisted to the DB. */
  key: string;
  /** Human label for accessibility (aria-label / title). */
  label: string;
  /** Base color used for header text and as the tint source. oklch keeps
   *  it perceptually even across the 12 hues and readable in both themes. */
  base: string;
};

export const GROUP_COLORS: readonly GroupColor[] = [
  { key: "slate",  label: "Slate",  base: "oklch(0.55 0.04 256)" },
  { key: "red",    label: "Red",    base: "oklch(0.58 0.20 25)" },
  { key: "orange", label: "Orange", base: "oklch(0.62 0.17 50)" },
  { key: "amber",  label: "Amber",  base: "oklch(0.66 0.15 75)" },
  { key: "yellow", label: "Yellow", base: "oklch(0.68 0.14 100)" },
  { key: "lime",   label: "Lime",   base: "oklch(0.64 0.18 130)" },
  { key: "green",  label: "Green",  base: "oklch(0.58 0.16 150)" },
  { key: "teal",   label: "Teal",   base: "oklch(0.60 0.12 185)" },
  { key: "cyan",   label: "Cyan",   base: "oklch(0.62 0.13 215)" },
  { key: "blue",   label: "Blue",   base: "oklch(0.58 0.17 250)" },
  { key: "violet", label: "Violet", base: "oklch(0.55 0.20 290)" },
  { key: "pink",   label: "Pink",   base: "oklch(0.62 0.20 350)" },
] as const;

const BY_KEY = new Map(GROUP_COLORS.map((c) => [c.key, c]));

/** Resolve a stored key to its base color, or null for null/unknown keys. */
export function resolveGroupColor(key: string | null | undefined): string | null {
  if (!key) return null;
  return BY_KEY.get(key)?.base ?? null;
}
```

- [ ] **Step 2: Typecheck via the web build**

Run: `cd apps/web && bun run build`
Expected: build succeeds (module is standalone; not yet imported).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/group-colors.ts
git commit -m "feat(web): add group color palette module"
```

---

## Task 5: Render the tint and add the "Set color" submenu in AccountGroupRow

**Files:**
- Modify: `apps/web/src/components/account-group-row.tsx`

- [ ] **Step 1: Extend the props**

In `apps/web/src/components/account-group-row.tsx`, add two props to the `Props` type (after `addAccountLabel`):

```ts
  /** Stored palette key for this group, or null for the default appearance. */
  color?: string | null;
  /** Persist a new color key (or null to clear). Omitted for owner buckets. */
  onSetColor?: (color: string | null) => void;
```

and destructure them in the component signature:

```ts
export function AccountGroupRow({
  name,
  memberCount,
  subtotalMinor,
  baseCurrency,
  expanded,
  onToggle,
  onRename,
  onDelete,
  onAddAccount,
  addAccountLabel = "Add account to this group",
  color,
  onSetColor,
  dragHandleProps,
  dragWholeRow,
  isDragging,
}: Props) {
```

- [ ] **Step 2: Add imports**

Update the imports at the top of the file:

```ts
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { GROUP_COLORS, resolveGroupColor } from "@/lib/group-colors";
```

- [ ] **Step 3: Apply the resolved color to the header**

Resolve the color once inside the component body (after the `wholeRowDrag` line):

```ts
  const accent = resolveGroupColor(color);
```

Then change the `row` element so the background and text follow the accent when present. Replace the row's `className`/style block and the colored spans. The outer `div` becomes:

```tsx
  const row = (
    <div
      {...(wholeRowDrag ? dragHandleProps : {})}
      style={accent ? ({ "--group-accent": accent } as React.CSSProperties) : undefined}
      className={cn(
        "flex w-full items-center gap-2 pl-2 pr-2 py-2.5 transition-colors",
        accent
          ? "bg-[color-mix(in_oklab,var(--group-accent)_8%,var(--color-card))]"
          : "bg-[color-mix(in_oklab,var(--color-primary)_6%,var(--color-card))]",
        wholeRowDrag && "cursor-grab touch-none active:cursor-grabbing",
        isDragging && "opacity-50",
      )}
    >
```

Update the drag-grip span color to follow the accent:

```tsx
      {dragHandleProps && (
        <span
          {...(wholeRowDrag ? {} : dragHandleProps)}
          style={accent ? ({ color: "var(--group-accent)" } as React.CSSProperties) : undefined}
          className={cn(
            "shrink-0 transition-colors",
            accent ? "opacity-50" : "text-primary/50",
            !wholeRowDrag && "cursor-grab touch-none hover:opacity-100 active:cursor-grabbing",
          )}
          aria-label="Drag group"
        >
          <GripVertical size={14} />
        </span>
      )}
```

Update the toggle button's three colored spans (arrow, name, subtotal). The arrow:

```tsx
          <span
            style={accent ? ({ color: "var(--group-accent)" } as React.CSSProperties) : undefined}
            className={cn(
              "text-[9px] transition-transform duration-150",
              accent ? "" : "text-primary",
              expanded ? "rotate-90" : "rotate-0",
            )}
          >
            ▶
          </span>
```

The name:

```tsx
          <span
            style={accent ? ({ color: "var(--group-accent)" } as React.CSSProperties) : undefined}
            className={cn(
              "flex-1 truncate text-sm font-semibold",
              accent ? "" : "text-primary",
            )}
          >
            {name}
          </span>
```

The subtotal:

```tsx
          <span
            style={accent ? ({ color: "var(--group-accent)" } as React.CSSProperties) : undefined}
            className={cn(
              "shrink-0 font-heading text-sm tabular-nums font-semibold",
              accent ? "" : "text-primary",
            )}
          >
            <Money minor={subtotalMinor} currency={baseCurrency} />
          </span>
```

(The middle `memberCount` span keeps `text-muted-foreground` — unchanged.)

- [ ] **Step 4: Include the submenu in the menu gate and content**

Update `hasMenu` to also open the menu when only `onSetColor` is available:

```ts
  const hasMenu = Boolean(onRename || onDelete || onAddAccount || onSetColor);
```

Then add the "Set color" submenu inside `ContextMenuContent`, after the Rename item and before the delete separator. The full content block becomes:

```tsx
      <ContextMenuContent>
        {onAddAccount && (
          <ContextMenuItem onClick={onAddAccount}>{addAccountLabel}</ContextMenuItem>
        )}
        {onAddAccount && (onRename || onDelete || onSetColor) && <ContextMenuSeparator />}
        {onRename && <ContextMenuItem onClick={startRename}>Rename</ContextMenuItem>}
        {onSetColor && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>Set color</ContextMenuSubTrigger>
            <ContextMenuSubContent className="grid grid-cols-6 gap-1 p-1">
              {GROUP_COLORS.map((c) => (
                <ContextMenuItem
                  key={c.key}
                  onClick={() => onSetColor(c.key)}
                  title={c.label}
                  aria-label={c.label}
                  className="flex h-7 w-7 items-center justify-center p-0"
                >
                  <span
                    style={{ backgroundColor: c.base }}
                    className={cn(
                      "h-4 w-4 rounded-full ring-1 ring-black/10",
                      color === c.key && "ring-2 ring-offset-1 ring-foreground",
                    )}
                  />
                </ContextMenuItem>
              ))}
              <ContextMenuItem
                onClick={() => onSetColor(null)}
                title="Default"
                aria-label="Default color"
                className="col-span-6 justify-center text-xs"
              >
                ⊘ Default
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        {(onRename || onSetColor) && onDelete && <ContextMenuSeparator />}
        {onDelete && (
          <ContextMenuItem variant="destructive" onClick={onDelete}>
            Delete group
          </ContextMenuItem>
        )}
      </ContextMenuContent>
```

- [ ] **Step 5: Typecheck via the web build**

Run: `cd apps/web && bun run build`
Expected: build succeeds. (`React` is already in scope via JSX; if a `React` namespace import is missing for `React.CSSProperties`, use `import type React from "react";` — verify the existing file already references `React.HTMLAttributes`, which it does, so the namespace is available.)

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/account-group-row.tsx
git commit -m "feat(web): tint group header and add Set color submenu"
```

---

## Task 6: Wire `setGroupColor` from the dashboard section

**Files:**
- Modify: `apps/web/src/components/dashboard-section.tsx:218-222` (near `renameGroup`) and `:534-556` (the `AccountGroupRow` usage)

- [ ] **Step 1: Add the setter**

In `apps/web/src/components/dashboard-section.tsx`, add a `setGroupColor` function next to `renameGroup`:

```ts
  async function setGroupColor(id: string, color: string | null) {
    await groupsCollection.update(id, (draft) => {
      draft.color = color;
    });
  }
```

- [ ] **Step 2: Pass color + onSetColor to the row (groups only)**

In the `AccountGroupRow` usage, add the two props alongside the existing `onRename`/`onDelete` gating (which already use `bucket ? undefined : ...`):

```tsx
                        <AccountGroupRow
                          name={cardName}
                          memberCount={memberIds.length}
                          subtotalMinor={subtotal}
                          baseCurrency={baseCurrency}
                          expanded={expandedState}
                          onToggle={() => toggleGroup(cardId)}
                          color={bucket ? null : (group?.color ?? null)}
                          onRename={
                            bucket ? undefined : (name) => void renameGroup(cardId, name)
                          }
                          onSetColor={
                            bucket ? undefined : (c) => void setGroupColor(cardId, c)
                          }
                          onDelete={bucket ? undefined : () => void deleteGroup(cardId)}
                          onAddAccount={() =>
                            openAddAccount(
                              bucket
                                ? { ownerIds: ownerIdsOf(cardId) }
                                : { groupId: cardId },
                            )
                          }
                          addAccountLabel={bucket ? "Add account" : "Add account to this group"}
                          dragHandleProps={reordering ? dragHandleProps : undefined}
                          dragWholeRow={reordering}
                          isDragging={isDragging}
                        />
```

Note: `group` is already computed earlier in the same `.map` callback as `groups.find((g) => g.id === cardId)` (`dashboard-section.tsx:511`), so `group?.color` is in scope.

- [ ] **Step 3: Typecheck via the web build**

Run: `cd apps/web && bun run build`
Expected: build succeeds with no type errors.

- [ ] **Step 4: Manual smoke test**

Run the app (`bun run dev` from repo root, or the project's run skill). On `/dashboard`:
1. Right-click a group header → "Set color" → pick a swatch. Header tints immediately; the active swatch shows a ring.
2. Reload the page — the color persists.
3. Right-click → "Set color" → ⊘ Default — header returns to the primary tint.
4. Right-click an **owner bucket** header — confirm no menu appears (no `onSetColor`/`onRename`/`onDelete`/`onAddAccount`... actually buckets still have `onAddAccount`, so the menu shows "Add account" only and no "Set color").

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/dashboard-section.tsx
git commit -m "feat(web): wire group color setter from dashboard section"
```

---

## Task 7: Run affected tests (end of slice)

**Files:** none (verification only)

- [ ] **Step 1: API route tests**

Run: `bun test apps/api/src/routes/groups.test.ts apps/api/src/routes/accounts.test.ts`
Expected: all PASS.

- [ ] **Step 2: Full web typecheck/build**

Run: `cd apps/web && bun run build`
Expected: build succeeds.

- [ ] **Step 3: Affected E2E**

Identify the relevant spec(s) from `e2e/README.md` (dashboard / accounts grouping) and run only those, e.g.:

Run: `bun run e2e -- accounts.spec.ts`
Expected: PASS. (If a dashboard-specific grouping spec exists, include it.)

- [ ] **Step 4: Final commit (if any test adjustments were needed)**

```bash
git add -A
git commit -m "test: verify group header colors slice"
```

---

## Self-Review Notes

- **Spec coverage:** schema/migration (T1), API accept+validate (T2), collection (T3), palette module (T4), render + Set color menu (T5), dashboard wiring (T6), tests (T2, T7). All spec sections covered.
- **Type consistency:** `color: string | null` used consistently across `GroupRow` (T3), `AccountGroupRow` props (T5), and `setGroupColor` (T6). `resolveGroupColor` / `GROUP_COLORS` names match between T4 and T5. Server `GROUP_COLOR_KEYS` (T2) and web `GROUP_COLORS` keys (T4) list the same 12 keys.
- **No `as any`:** server uses `t.Union`/`t.Literal` validation; client casts only to the specific `React.CSSProperties` type for inline custom properties (allowed — specific, not `any`).
- **Key-list duplication** across packages is intentional and documented (package-boundary cleanliness); both lists enumerate the same 12 keys.
