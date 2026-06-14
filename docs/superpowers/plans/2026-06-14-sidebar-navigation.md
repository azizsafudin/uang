# Sidebar Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the crowded top navbar with a left shadcn sidebar (Dashboard / Projections / Settings, icon-collapsible, Sign out in footer), separating global navigation from page-specific actions and widening content.

**Architecture:** A pathless TanStack Router layout route renders `SidebarProvider + AppSidebar + SidebarInset` once for all four protected routes; pages render their content inside it via `<Outlet />`. `AppShell` is repurposed into a content-width wrapper (no more global nav) that keeps an optional page-header `actions` slot. The auth guard moves from the four child routes onto the single layout route.

**Tech Stack:** React, TanStack Router, shadcn `sidebar` (base-nova / base-ui registry), Tailwind v4, lucide-react, Bun. Verification via `tsgo` typecheck/build and Playwright e2e (no web unit-test harness exists).

---

## File structure

- **Create** `apps/web/src/components/ui/sidebar.tsx` (+ any deps the CLI adds: `sheet.tsx`, `tooltip.tsx`, `separator.tsx`, `skeleton.tsx`) — shadcn primitive, via CLI.
- **Create** `apps/web/src/hooks/use-mobile.ts` — added by the CLI; the sidebar's mobile breakpoint hook.
- **Create** `apps/web/src/components/app-sidebar.tsx` — the app's nav sidebar (header wordmark + toggle, nav menu, sign-out footer).
- **Modify** `apps/web/src/components/app-layout.tsx` — `AppShell` becomes a content-width wrapper (no header/nav); `Eyebrow` unchanged.
- **Modify** `apps/web/src/router.tsx` — add pathless `appLayoutRoute`, move the guard onto it, re-parent the four protected routes.
- **Modify** `apps/web/src/routes/dashboard.tsx` — drop nav from `actions`; keep only `AccountForm` as the page-header action.
- **Modify** `apps/web/src/routes/account-detail.tsx` — keep `BackButton` (now rendered by the new `AppShell` actions slot).
- **Modify** `apps/web/src/routes/settings.tsx` — drop the Back button.
- **Modify** `apps/web/src/routes/projections.tsx` — render through `AppShell` (shared inset + wider width).
- **Create** `e2e/tests/sidebar.spec.ts` — asserts sidebar nav renders and navigates on protected routes.

---

## Task 1: Install the shadcn sidebar primitive

**Files:**
- Create: `apps/web/src/components/ui/sidebar.tsx` (+ CLI-added deps)
- Create: `apps/web/src/hooks/use-mobile.ts`

- [ ] **Step 1: Run the shadcn CLI from the web app**

Run:
```bash
cd /Users/aziz/Workspace/uang/apps/web && bunx --bun shadcn@latest add sidebar
```
If prompted to overwrite existing components, decline overwrites for already-present components (button, input). Accept new ones (sidebar, sheet, tooltip, separator, skeleton, use-mobile hook).

Expected: `src/components/ui/sidebar.tsx` is created and the terminal lists the added files.

- [ ] **Step 2: Verify the files landed and the sidebar tokens already exist**

Run:
```bash
cd /Users/aziz/Workspace/uang/apps/web && ls src/components/ui/sidebar.tsx src/hooks/use-mobile.ts && grep -c -- "--sidebar" src/index.css
```
Expected: both paths print, and the grep count is `> 0` (the `--sidebar-*` tokens already exist in `index.css`, so no CSS work is needed).

- [ ] **Step 3: Typecheck to confirm the new files compile**

Run:
```bash
cd /Users/aziz/Workspace/uang/apps/web && bunx tsgo -b
```
Expected: exits 0 (no type errors). If the CLI added a `use-mobile` hook at a different path than `@/hooks/use-mobile`, note the actual path printed in Step 1 — later tasks import `useSidebar` from `@/components/ui/sidebar`, not the hook directly, so this is only informational.

- [ ] **Step 4: Commit**

```bash
cd /Users/aziz/Workspace/uang && git add apps/web/src/components/ui apps/web/src/hooks apps/web/components.json && git commit -m "chore(web): add shadcn sidebar primitive"
```

---

## Task 2: Build the AppSidebar component

**Files:**
- Create: `apps/web/src/components/app-sidebar.tsx`

- [ ] **Step 1: Write `app-sidebar.tsx`**

Create `apps/web/src/components/app-sidebar.tsx`:
```tsx
import { Link, useRouterState, useNavigate } from "@tanstack/react-router";
import { LayoutDashboard, TrendingUp, Settings, LogOut } from "lucide-react";
import { signOut } from "@/lib/auth";
import {
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarGroup,
  SidebarTrigger,
} from "@/components/ui/sidebar";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/projections", label: "Projections", icon: TrendingUp },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

export function AppSidebar() {
  const nav = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center justify-between gap-2 px-2 py-1.5">
          <Link
            to="/"
            className="font-heading text-xl leading-none tracking-tight text-foreground group-data-[collapsible=icon]:hidden"
          >
            uang<span className="text-gold">.</span>
          </Link>
          <SidebarTrigger className="-mr-1" />
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            {NAV.map(({ to, label, icon: Icon }) => (
              <SidebarMenuItem key={to}>
                <SidebarMenuButton
                  asChild
                  isActive={to === "/" ? pathname === "/" : pathname.startsWith(to)}
                  tooltip={label}
                >
                  <Link to={to}>
                    <Icon />
                    <span>{label}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Sign out"
              onClick={async () => {
                await signOut();
                await nav({ to: "/login" });
              }}
            >
              <LogOut />
              <span>Sign out</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
```

Note: account detail lives at `/accounts/$id`, which is not in `NAV`, so no item is marked active there — that is intentional.

- [ ] **Step 2: Typecheck**

Run:
```bash
cd /Users/aziz/Workspace/uang/apps/web && bunx tsgo -b
```
Expected: exits 0. If any named import (e.g. `SidebarGroup`, `SidebarTrigger`) is reported missing, open `src/components/ui/sidebar.tsx`, confirm the exact exported names, and adjust the imports to match — the shadcn sidebar exports all of these by default.

- [ ] **Step 3: Commit**

```bash
cd /Users/aziz/Workspace/uang && git add apps/web/src/components/app-sidebar.tsx && git commit -m "feat(web): add AppSidebar nav component"
```

---

## Task 3: Repurpose AppShell into a content-width wrapper

**Files:**
- Modify: `apps/web/src/components/app-layout.tsx:5-30`

- [ ] **Step 1: Replace the `AppShell` function**

In `apps/web/src/components/app-layout.tsx`, replace the entire `AppShell` function (lines 5-30, the block starting `// One consistent column width...` through its closing `}`) with:
```tsx
// Content column for every signed-in page. The sidebar + chrome live in the
// layout route; this just sets the width and an optional page-header actions row.
export function AppShell({
  actions,
  children,
}: {
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-5xl px-5 py-8 md:px-6 md:py-10">
      {actions ? (
        <div className="mb-6 flex items-center justify-end gap-1.5">{actions}</div>
      ) : null}
      {children}
    </div>
  );
}
```
Leave the `Eyebrow` export (and the top `import { Link }` / `import { cn }` lines) as they are — `cn` is still used by `Eyebrow`. The `Link` import is now unused by this file; remove it to keep the typecheck clean: change line 1 from `import { Link } from "@tanstack/react-router";` to nothing (delete the line).

- [ ] **Step 2: Typecheck**

Run:
```bash
cd /Users/aziz/Workspace/uang/apps/web && bunx tsgo -b
```
Expected: exits 0. (`router.tsx` and the pages still compile — they import `AppShell`/`Eyebrow`, whose signatures are unchanged.)

- [ ] **Step 3: Commit**

```bash
cd /Users/aziz/Workspace/uang && git add apps/web/src/components/app-layout.tsx && git commit -m "refactor(web): AppShell becomes content-width wrapper"
```

---

## Task 4: Add the pathless layout route and wire the sidebar

**Files:**
- Modify: `apps/web/src/router.tsx`

- [ ] **Step 1: Add imports**

In `apps/web/src/router.tsx`, add these imports below the existing ones (after line 15):
```tsx
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
```

- [ ] **Step 2: Add the pathless layout route**

In `apps/web/src/router.tsx`, immediately after the `rootRoute` definition (after line 17, `const rootRoute = ...`), add:
```tsx
const appLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app-shell",
  beforeLoad: requireInitializedAndAuthed,
  component: () => (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <SidebarTrigger className="fixed left-3 top-3 z-20 md:hidden" />
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  ),
});
```

- [ ] **Step 3: Re-parent the four protected routes and drop their per-route guards**

In `apps/web/src/router.tsx`, change the four protected routes so their parent is `appLayoutRoute` and remove their now-redundant `beforeLoad`:

- `dashboardRoute`: change `getParentRoute: () => rootRoute` → `getParentRoute: () => appLayoutRoute`, and delete the line `beforeLoad: requireInitializedAndAuthed,`.
- `accountDetailRoute`: same two edits.
- `settingsRoute`: same two edits.
- `projectionsRoute`: same two edits.

Leave `onboardingRoute` and `loginRoute` parented to `rootRoute` (they must stay chrome-free).

- [ ] **Step 4: Update the route tree**

In `apps/web/src/router.tsx`, replace the `routeTree` definition (lines 63-70) with a nested tree:
```tsx
const routeTree = rootRoute.addChildren([
  onboardingRoute,
  loginRoute,
  appLayoutRoute.addChildren([
    dashboardRoute,
    accountDetailRoute,
    settingsRoute,
    projectionsRoute,
  ]),
]);
```

- [ ] **Step 5: Typecheck**

Run:
```bash
cd /Users/aziz/Workspace/uang/apps/web && bunx tsgo -b
```
Expected: exits 0.

- [ ] **Step 6: Manually verify the shell renders**

Run the dev server:
```bash
cd /Users/aziz/Workspace/uang && bun run web:dev
```
In the browser (default `http://localhost:5173`), sign in and confirm: the sidebar shows on `/`, `/accounts/:id`, `/settings`, `/projections`; it is absent on `/onboarding` and `/login`. The pages still render their old top-row `actions` (duplicate nav buttons) — that is expected and removed in Tasks 5-8. Stop the dev server when done.

- [ ] **Step 7: Commit**

```bash
cd /Users/aziz/Workspace/uang && git add apps/web/src/router.tsx && git commit -m "feat(web): render sidebar via pathless layout route"
```

---

## Task 5: Trim the dashboard actions to the page-specific one

**Files:**
- Modify: `apps/web/src/routes/dashboard.tsx:5,57-81`

- [ ] **Step 1: Remove the now-unused nav imports and hook**

In `apps/web/src/routes/dashboard.tsx`:
- Delete line 5: `import { signOut } from "@/lib/auth";`
- The `Button` import (line 11) is still used elsewhere in the file? Check: after Step 2 the `actions` block no longer uses `Button`. Run `grep -n "<Button" src/routes/dashboard.tsx` — if no other usage remains, delete the `Button` import (line 11). If usages remain, keep it.
- `useNavigate` (line 4) / `nav` (line 35): after Step 2, `nav` is unused. Run `grep -n "nav(" src/routes/dashboard.tsx` — if the only match was the removed sign-out handler, delete `const nav = useNavigate();` (line 35) and drop `useNavigate` from the line 4 import (keep `Link`).

- [ ] **Step 2: Replace the `actions` prop**

In `apps/web/src/routes/dashboard.tsx`, replace the `actions={ ... }` block (the `<>...</>` fragment passed to `AppShell`, lines 58-80) so only the account form remains:
```tsx
    <AppShell actions={<AccountForm defaultCurrency={base || undefined} />}>
```
(Remove the `Projections →` link, the `Settings` button, and the `Sign out` button — those now live in the sidebar.)

- [ ] **Step 3: Typecheck**

Run:
```bash
cd /Users/aziz/Workspace/uang/apps/web && bunx tsgo -b
```
Expected: exits 0 (no unused-import or undefined-symbol errors).

- [ ] **Step 4: Commit**

```bash
cd /Users/aziz/Workspace/uang && git add apps/web/src/routes/dashboard.tsx && git commit -m "feat(web): dashboard keeps only Add-account in page header"
```

---

## Task 6: Confirm account-detail back link still works

**Files:**
- Modify (only if needed): `apps/web/src/routes/account-detail.tsx`

- [ ] **Step 1: Verify no change needed**

`account-detail.tsx` passes `actions={<BackButton />}` to `AppShell` at lines 48, 157, 184. The new `AppShell` renders `actions` as a top-right row, so the Back link still appears. No code change is required.

Run:
```bash
cd /Users/aziz/Workspace/uang/apps/web && bunx tsgo -b
```
Expected: exits 0.

- [ ] **Step 2: No commit needed** (no file changed). Proceed to Task 7.

---

## Task 7: Drop the Settings page Back button

**Files:**
- Modify: `apps/web/src/routes/settings.tsx:111-119`

- [ ] **Step 1: Remove the `actions` prop**

In `apps/web/src/routes/settings.tsx`, replace the opening `AppShell` with `actions` (lines 111-119) with a bare wrapper:
```tsx
    <AppShell>
```
(Delete the entire `actions={ <Link to="/">...← Back...</Link> }` prop.)

- [ ] **Step 2: Remove the now-unused imports if applicable**

Run `grep -n "<Link\|<Button" src/routes/settings.tsx`. If `Link` or `Button` have no remaining usages in the file, remove them from the imports at the top. If they are still used elsewhere, leave the imports.

- [ ] **Step 3: Typecheck**

Run:
```bash
cd /Users/aziz/Workspace/uang/apps/web && bunx tsgo -b
```
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
cd /Users/aziz/Workspace/uang && git add apps/web/src/routes/settings.tsx && git commit -m "feat(web): drop Settings page Back button (now a nav item)"
```

---

## Task 8: Migrate Projections onto the shared wrapper

**Files:**
- Modify: `apps/web/src/routes/projections.tsx`

- [ ] **Step 1: Replace the standalone `<main>` with `AppShell`**

Replace the full contents of `apps/web/src/routes/projections.tsx` with:
```tsx
import { ProjectionChart } from "@/components/projection-chart";
import { AppShell } from "@/components/app-layout";

export function ProjectionsPage() {
  return (
    <AppShell>
      <h1 className="mb-1 text-xl font-semibold">Projections</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        Total vs accessible net worth over time, at your assumed growth rates.
      </p>
      <ProjectionChart />
    </AppShell>
  );
}
```

- [ ] **Step 2: Typecheck and build**

Run:
```bash
cd /Users/aziz/Workspace/uang/apps/web && bunx tsgo -b && bun run build
```
Expected: both exit 0.

- [ ] **Step 3: Commit**

```bash
cd /Users/aziz/Workspace/uang && git add apps/web/src/routes/projections.tsx && git commit -m "feat(web): projections uses shared content wrapper"
```

---

## Task 9: Add an e2e test for the sidebar and run the suite

**Files:**
- Create: `e2e/tests/sidebar.spec.ts`

- [ ] **Step 1: Inspect an existing spec to reuse the auth/fixture helpers**

Read `e2e/tests/ownership.spec.ts` and `e2e/tests/fixtures.ts` to see how a test signs in / reaches an authenticated page (the `test` fixture and any `backend` setup). Mirror that exact setup in the new spec — do not invent a new login flow.

- [ ] **Step 2: Write the failing test**

Create `e2e/tests/sidebar.spec.ts`. Use the same import + fixture pattern you observed in Step 1 (shown here using the `test`/`expect` exported from `./fixtures`; adjust the import path/fixture name to match the actual file):
```ts
import { test, expect } from "./fixtures";

test("sidebar navigates between dashboard, projections, settings", async ({ page }) => {
  // Arrange: reach an authenticated page using the same setup the other specs use.
  // (Replace this comment with the project's standard sign-in/seed steps from Step 1.)
  await page.goto("/");
  await expect(page.getByText(/Net worth/i)).toBeVisible();

  // The sidebar nav links are present.
  await page.getByRole("link", { name: "Projections" }).click();
  await expect(page.getByRole("heading", { name: "Projections" })).toBeVisible();

  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  await page.getByRole("link", { name: "Dashboard" }).click();
  await expect(page.getByText(/Net worth/i)).toBeVisible();
});
```

- [ ] **Step 3: Run the new test and confirm it passes**

Run:
```bash
cd /Users/aziz/Workspace/uang && bun run e2e -- sidebar.spec.ts
```
Expected: the `sidebar` spec passes. If the sign-in/seed step needs adjustment, fix the Arrange section to match the working pattern from the other specs until it passes. If link-name matching is ambiguous (e.g. both a sidebar link and an in-page link named "Projections"), scope the query with `page.getByRole("navigation")` or the sidebar's `data-sidebar` container.

- [ ] **Step 4: Run the full e2e suite for regressions**

Run:
```bash
cd /Users/aziz/Workspace/uang && bun run e2e
```
Expected: all specs pass. The only nav-coupled assertion in the existing suite is `holdings.spec.ts` clicking the `← Back` link on account detail, which is preserved. If anything fails, fix before committing.

- [ ] **Step 5: Commit**

```bash
cd /Users/aziz/Workspace/uang && git add e2e/tests/sidebar.spec.ts && git commit -m "test(e2e): sidebar navigation across protected routes"
```

---

## Task 10: Final manual verification

- [ ] **Step 1: Run the app and walk the checklist**

Run:
```bash
cd /Users/aziz/Workspace/uang && bun run dev
```
Confirm:
- Sidebar shows on `/`, `/accounts/:id`, `/settings`, `/projections`; absent on `/onboarding`, `/login`.
- Collapse toggle in the sidebar header switches to icon mode and back; icon mode shows tooltips on hover; collapse state persists across a page reload.
- Active nav item highlights correctly per route (Dashboard on `/`, none on `/accounts/:id`).
- Sign out (sidebar footer) logs out and redirects to `/login`.
- On a narrow viewport, the floating trigger (top-left) opens the off-canvas sidebar; selecting an item closes it.
- Dashboard shows "Add account" in its page header; Account Detail shows "← Back"; Settings has no Back button.
- Content is visibly wider (`max-w-5xl`) than before.

- [ ] **Step 2: Stop the dev server.** Implementation complete.

---

## Self-review notes

- **Spec coverage:** nav items (Task 2), icon-collapse + sidebar-header toggle (Tasks 2,4), no desktop top bar + mobile floating trigger (Task 4), wider `max-w-5xl` content (Task 3), pathless layout route with single guard (Task 4), Sign out in footer (Task 2), Account-Detail back kept (Task 6) / Settings back dropped (Task 7), projections migrated (Task 8), e2e + manual verification (Tasks 9-10). All spec sections map to a task.
- **Type consistency:** `AppShell({ actions, children })` signature is preserved across Tasks 3,5,6,7,8; `AppSidebar` exported from `@/components/app-sidebar` and imported in Task 4; sidebar primitives imported from `@/components/ui/sidebar` in Tasks 2,4.
- **No web unit tests:** the project has no component test harness; `tsgo -b` + `bun run build` + Playwright e2e are the gates, used throughout.
