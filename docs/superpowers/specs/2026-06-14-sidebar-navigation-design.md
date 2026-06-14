# Sidebar navigation — design

**Date:** 2026-06-14
**Status:** Approved, ready for planning

## Problem

The top navbar in `AppShell` has become crowded: it mixes the wordmark with a
growing pile of per-page action buttons (Projections link, Settings, Sign out,
"Add account", Back links). Global navigation and page-specific actions live in
the same horizontal strip, which is getting ugly and doesn't scale as more pages
are added.

## Goal

Replace the top-navbar navigation with a left **sidebar** (shadcn `sidebar`
component), separating global navigation from page-specific actions. The sidebar
is icon-collapsible and persists across navigation.

## Decisions

- **Nav items:** Dashboard, Projections, Settings. Sign out lives in the sidebar
  footer.
- **Collapse behavior:** `icon` mode — full sidebar collapses to an icon rail via
  a toggle. On mobile it becomes an off-canvas Sheet.
- **Toggle placement:** inside the sidebar header. No top bar on desktop; mobile
  gets a minimal floating `SidebarTrigger`.
- **Content width:** widen content from `max-w-3xl` to `max-w-5xl` (centered) to
  use the horizontal space the sidebar frees up.
- **Back buttons:** Account Detail keeps its in-content "← Back" link (it's a
  drill-down). Settings drops its Back button (Settings is now a nav item).

## Architecture

### Routing — pathless layout route

Introduce a **pathless layout route** in `apps/web/src/router.tsx` that renders
the persistent sidebar shell once, with the protected pages as children via
`<Outlet />`:

```
rootRoute
├── /onboarding        (no sidebar)
├── /login             (no sidebar)
└── appLayoutRoute (pathless, beforeLoad: requireInitializedAndAuthed)
    │   renders: <SidebarProvider><AppSidebar/><SidebarInset><Outlet/></SidebarInset></SidebarProvider>
    ├── /              Dashboard
    ├── /accounts/$id  Account Detail
    ├── /settings      Settings
    └── /projections   Projections
```

Rationale:
- The sidebar mounts once and survives navigation — collapse state intact, no
  remount flicker.
- The `requireInitializedAndAuthed` guard moves to the single layout route
  (removed from the four child routes).
- `/onboarding` and `/login` stay chrome-free.

Alternative considered: keep per-page `AppShell` wrapping that internally renders
the sidebar. Smaller diff, but the sidebar remounts on every route change.
Rejected in favor of the layout route.

### Components

**`AppSidebar`** (new, `apps/web/src/components/app-sidebar.tsx`)
- Installed via `bunx shadcn@latest add sidebar` (base-nova registry → base-ui
  compatible; the CLI pulls Sheet, Tooltip, Separator, Skeleton, and the
  `use-mobile` hook as needed).
- Uses the `--sidebar-*` CSS tokens already defined in `index.css`.
- **Header:** "uang." wordmark with gold dot + `SidebarTrigger` collapse toggle.
- **Content:** `SidebarMenu` with three `SidebarMenuButton` items (Dashboard,
  Projections, Settings), each a lucide icon + label. `isActive` is driven by the
  current route (TanStack Router location/`useMatchRoute`). Labels hide in icon
  mode; icons + tooltips remain.
- **Footer:** Sign out `SidebarMenuButton` → `signOut()` then redirect to
  `/login`.
- **Mobile:** off-canvas Sheet opened by a minimal floating `SidebarTrigger`.

**Content wrapper** (repurpose `AppShell` or replace with a thin wrapper around
`SidebarInset`)
- No longer renders global nav.
- Wraps content at `max-w-5xl` (centered) with the existing horizontal padding.
- Keeps an optional **page-header slot** for *page-specific* content/actions,
  rendered inside the content area (not global chrome).
- `Eyebrow` export is preserved unchanged.

### Page changes

- **Dashboard (`routes/dashboard.tsx`):** remove Projections/Settings/Sign out
  from `actions`. The `AccountForm` ("Add account") moves into the page-header
  slot at the top of the dashboard content.
- **Account Detail (`routes/account-detail.tsx`):** keep the "← Back" link as an
  in-content element (page-header slot).
- **Settings (`routes/settings.tsx`):** drop the Back button entirely.
- **Projections (`routes/projections.tsx`):** migrate off its standalone
  `<main className="max-w-3xl">` onto the shared inset; inherits the wider width.

## Out of scope

- Dark mode toggle (the app has no theme switching yet; not adding it here).
- Any change to onboarding/login chrome.
- Restyling page content beyond the width change.

## Testing

- Manual: verify sidebar renders on all four protected routes, collapses to icons
  and back, active item highlights per route, Sign out works, mobile off-canvas
  opens/closes, and onboarding/login show no sidebar.
- Confirm existing e2e tests still pass (account flows, net worth). Update any
  selectors that depended on the old navbar Back/Settings/Sign-out buttons if the
  suite references them.
