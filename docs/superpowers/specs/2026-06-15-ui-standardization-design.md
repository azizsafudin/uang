# UI Standardization & Dashboard Redesign — Design

**Date:** 2026-06-15
**Status:** Approved (pending spec review)

## Problem

The app's pages are visually inconsistent and untidy:

- Forms have no vertical gap between label and input (fields are `<div><Label/><Input/></div>` with no spacing class).
- Button sizes and placement vary across similarly-structured pages.
- The dashboard top is cluttered: "Add account" sits in a weird top-right slot, and the household/member toggle competes with the headline.
- The dashboard lacks a welcoming, attractive header.
- Page headers are hand-rolled per page; no shared component.

This project standardizes the UI and redesigns the dashboard top, using **only data the app already models**. A separate concern (savings rate / cash-flow) is explicitly deferred — see Scope & Decomposition.

## Scope & Decomposition

**In scope:** dashboard hero redesign, configurable dashboard tiles, app-wide value-hide (privacy) toggle, form spacing standard, button standard, page-header standard, breadcrumb-only navigation.

**Deferred to a separate future spec:** **cash-flow / savings tracking.** The `transactions` table records `unitsDelta` (holdings acquired/disposed per instrument) — it models *net worth*, never *income or spending*. Savings rate and runway therefore require a new subsystem (income + expense modeling, or external-contribution detection) and are out of scope here. The tile system below is built as a registry so those tiles can be added later without rework.

## Design

### 1. Dashboard hero

A bespoke header (the dashboard keeps its own header; other pages use the shared `PageHeader`).

- **Greeting:** time-aware ("Good morning/afternoon/evening, *{member name}*."), set in Fraunces with the name in gold italic, followed by the date (e.g. "Sunday, 15 June"). No status line.
- **Background:** "brass-dawn" treatment — a warm radial brass glow from the top-right, a faint pine wash bottom-left, over the paper card gradient, with a polished gold rule across the top edge (3px gradient).
- **Net worth panel:** a pine-green "vault" panel (~58% width on desktop) holding the net-worth number in cream Fraunces numerals, a brass sparkline (period trend), and a gold change pill ("▲ £5,240 (1.9%) this month"). The change pill stays.
- **No eye icon in the hero** — value-hide lives in the top bar (see §4).
- **No household/member toggle in the hero** — it moves to the chart card (see §3).

Reference mockups (in `.superpowers/brainstorm/`): `dashboard-wide-v2.html` is the closest to final, **minus** the hero eye icon (now top-bar only).

### 2. Configurable dashboard tiles

Beside the green vault panel, a configurable set of stat tiles.

**Tile registry.** Each tile is a registry entry: `{ id, label, isAvailable(data), render(data) }`. The dashboard renders the user-selected, ordered subset whose data is available.

**Tiles available now (data exists):**

| Tile | Source |
|------|--------|
| Assets | networth total of `class = "asset"` accounts |
| Liabilities | networth total of `class = "liability"` accounts |
| Liquid assets | sum of asset accounts where `illiquid = 0` |
| Goals on track | goals + `simulateGoals` (count on track / total) |
| Period change | net-worth-series delta (MTD or YTD) |

**Default shown:** Assets, Liabilities, Goals on track.

**Configuration UX:** an edit mode on the dashboard (toggle button) exposing show/hide checkboxes and drag-to-reorder, reusing the existing dnd approach from `DashboardSection`. Persisted **per-household** in the `settings` table as a JSON column (e.g. `dashboard_tiles`), storing an ordered list of enabled tile ids. Requires a Drizzle migration adding the column with a sensible default.

**Future tiles (deferred):** Savings rate, Runway — slot into the same registry once cash-flow modeling exists.

### 3. Toggle + "Add account" relocation

- **Household / member toggle** (`NetWorthToggle`) moves into the **net-worth chart card header** (right-aligned), since the chart redraws per owner and the headline number follows it.
- **"Add account"** moves out of the top-right `AppShell` actions slot into the **Assets section header**. `DashboardSection` gains an optional `actions` slot rendered in its header; the dashboard passes `<AccountForm/>` to the asset section.

### 4. App-wide value privacy (eye toggle)

- A global `valuesHidden` boolean via React context, **persisted in `localStorage`** (a per-device privacy preference, intentionally not synced across devices/members).
- **Single canonical control in the top bar** (the sticky header present on every page, alongside the sidebar trigger and breadcrumb). No hero icon.
- When hidden, every monetary value renders as a masked placeholder (e.g. `••••••`). Achieved by routing all money rendering through the existing `formatMoney`/`money` display path so a single switch masks everywhere (dashboard, accounts, goals, projections, settings).

### 5. Form standard

- Shared `<Field>` wrapper component: `<div className="space-y-1.5">` containing `<Label>`, the control, and an optional hint (`text-xs text-muted-foreground`). This yields a 6px label↔input gap.
- Form/dialog bodies use **`space-y-4`** between fields (up from `space-y-3`). Grid field pairs use `gap-4`.
- Apply to: `account-form`, `goal-form`, `login`, `onboarding`, settings forms, `account-info-card` (inline edit), `add-transaction-dialog`.

### 6. Button standard

- **Default size (`h-8`) everywhere** unless inside a genuinely dense inline row (e.g. a table-row action), which may use `sm`/`xs` — documented as the exception. Retire ad-hoc `sm` on primary and danger-zone actions.
- **Dialog footers:** right-aligned, with an explicit **Cancel** (`variant="ghost"`) plus the primary action (`variant="default"`). Every dialog gets a Cancel.
- **Destructive actions:** `variant="destructive"`, default size.
- **Icon-only buttons:** `size="icon-sm" variant="ghost"`.

### 7. Page header standard & navigation

- Shared `<PageHeader>` component: `Eyebrow` + Fraunces title + optional description + optional `actions` slot. Replaces hand-rolled headers on `goals`, `settings`, `projections`, `account-detail`, `goal-detail`. Settings' existing `<Section>` may compose with or be replaced by it.
- **Navigation is breadcrumb-only.** No back buttons exist today and none will be added. Every non-top-level page must have a correct breadcrumb trail with working parent links (account → Dashboard; goal → Goals). The dashboard keeps its bespoke hero instead of `PageHeader`.

## Components & files (indicative)

**New:**
- `components/ui/field.tsx` — `<Field>` wrapper.
- `components/page-header.tsx` — shared `<PageHeader>`.
- `components/dashboard-hero.tsx` — new hero (greeting + brass-dawn + green vault + sparkline + change pill).
- `components/dashboard-tiles/` — tile registry + tile components + edit mode.
- `lib/values-hidden.tsx` — context + localStorage hook for the privacy toggle.

**Modified:**
- `routes/dashboard.tsx` — compose hero + tiles; remove top-right actions; pass toggle to chart; pass add-account to asset section.
- `components/net-worth-chart.tsx` (or its card) — host the owner toggle in its header.
- `components/dashboard-section.tsx` — add `actions` slot.
- `components/money.tsx` / `formatMoney` path — honor `valuesHidden`.
- Top-bar header (in `router.tsx` layout) — add the eye toggle.
- Forms listed in §5; headers listed in §7.
- `apps/api/src/db/schema.ts` + migration — `dashboard_tiles` JSON column on `settings`; networth/series routes expose any extra fields the tiles need (e.g. `illiquid` per account, period delta).

## Testing

- Unit: tile `isAvailable`/registry selection; `valuesHidden` masking of `formatMoney`; per-household tile persistence round-trip.
- Existing API tests cover networth/series/goals; extend where routes expose new fields.
- Manual: dashboard at `max-w-5xl`, edit-mode reorder, privacy toggle across all pages, form spacing, dialog footers.

## Constraints

- No `as any` (project rule). Add shadcn components via the shadcn CLI.
- Tile config is per-household (backend); value-hide is per-device (localStorage).
