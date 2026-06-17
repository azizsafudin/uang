# PWA mobile layout — design

**Date:** 2026-06-17
**Status:** Approved (pending spec review)

## Goal

Give installed-PWA users on a phone a native-feeling, app-shell layout: a
bottom tab bar instead of the top breadcrumb/header, with chrome (theme +
privacy toggles) relocated into the sidebar. Browser users and desktop-installed
PWA users keep the current sidebar + top-bar layout untouched.

## Mode gate

The whole feature is gated on **standalone display AND phone-width**:

```ts
const isPwaMobile = useIsPWA() && useIsMobile();
```

- Reuse the existing `useIsPWA()` (`hooks/use-pwa.ts`) and `useIsMobile()`
  (`hooks/use-mobile.ts`) hooks together inline. **No new combined hook.**
- Improve `useIsPWA` so its `useState` initializes **synchronously** from
  `detectPWA()` (matchMedia is synchronous) instead of `undefined`, to minimize
  a first-paint flash of the wrong layout. `useIsMobile` keeps its current
  behavior.

Resulting matrix:

| Context | Layout |
|---|---|
| Phone, standalone PWA | Bottom tab bar, no top header, toggles in sidebar |
| Phone, browser tab | Current layout (sidebar + top bar) |
| Desktop, standalone PWA | Current layout (sidebar + top bar) |
| Desktop, browser | Current layout (sidebar + top bar) |

## Components & changes

### 1. Layout route — `router.tsx`

The `appLayoutRoute` component branches on `isPwaMobile`:

- Extract the existing sticky `<header>` (SidebarTrigger + `AppBreadcrumb` +
  toggles) into a new `components/app-top-bar.tsx` (`AppTopBar`). Rendered only
  when `!isPwaMobile`.
- Render `<PwaTabBar />` only when `isPwaMobile`.
- In PWA mode the content area gets bottom padding so it clears the fixed bar:
  `pb-[calc(4rem+env(safe-area-inset-bottom))]` (applied on `SidebarInset`/Outlet
  wrapper, PWA-mode only).
- Extract the inline `ValuePrivacyToggle` (currently defined in `router.tsx`)
  into its own component `components/value-privacy-toggle.tsx` so both the top
  bar and the sidebar can render it.

### 2. Bottom tab bar — `components/pwa-tab-bar.tsx` (new)

Fixed-bottom bar, full width, 5 slots, with iOS safe-area inset padding
(`pb-[env(safe-area-inset-bottom)]`). Lives inside `SidebarProvider` (mounted by
the layout route) so it can call `useSidebar()`.

```
┌──────────────────────────────────────────┐
│  ⌂        ⇄       ⊕      ▤        ☰        │
│ Home  Transac.  (add)  Assets   More      │
└──────────────────────────────────────────┘
```

- **Home** → `/`, **Transactions** → `/transactions`, **Assets** → `/assets`.
  Active state from `useRouterState({ select: s => s.location.pathname })`,
  matching the same active-path logic `nav-main.tsx` uses (`/` is exact; others
  `startsWith`).
- **(+) center** — a raised accent button (primary/gold), visually distinct.
  Opens the global add-transaction flow (section 4). The bar owns the dialog
  open state.
- **More** — `useSidebar().setOpenMobile(true)` to open the sidebar sheet.
- Icons reuse the lucide set already in use: `LayoutDashboard`/`Home`,
  `ArrowLeftRight`, `Plus`, an assets icon (e.g. `Wallet`/`Landmark`), `Menu`.

### 3. Sidebar — `components/app-sidebar.tsx`

- When `isPwaMobile`, render a toggles row in `SidebarFooter` containing
  `ThemeToggle` + `ValuePrivacyToggle`. Computed via `useIsPWA() && useIsMobile()`
  inline inside the sidebar. When not PWA-mobile, the footer is unchanged (the
  toggles stay in the top bar).
- The sidebar is already a mobile off-canvas sheet, so "More" needs no extra
  wiring beyond `setOpenMobile(true)`.

### 4. Global add-transaction — refactor `components/add-transaction-dialog.tsx`

Make the account optional/selectable so the same dialog serves both the
account-detail page and the global "+".

New/changed props:

```ts
{
  accountId?: string;          // omitted = global mode
  accountCurrency?: string;
  open?: boolean;              // controlled open (tab bar owns it)
  onOpenChange?: (o: boolean) => void;
  showTrigger?: boolean;       // default true; tab bar passes false
}
```

Behavior:

- **Account-detail page** (`routes/account-detail.tsx`) keeps passing
  `accountId` + `accountCurrency` and its own trigger → **unchanged behavior**.
- **Global mode** (no `accountId`): render an account `<Select>` at the top of
  the form, pre-selected to the **last-used account** = `account.id` of the most
  recent row from `api.transactions.get()` (already sorted most-recent-first).
  Fallback order: last-used → only account → first account. The form's currency
  (`newCurrency` default / cash currency) derives from the **selected** account
  rather than a fixed `accountCurrency` prop.
- The selected account drives which `transactionsCollection(accountId)` the
  optimistic insert writes to.

`PwaTabBar` mounts `<AddTransactionDialog open={addOpen} onOpenChange={setAddOpen}
showTrigger={false} />` (no `accountId`) and toggles `addOpen` from the (+)
button.

### 5. Assets page — `routes/assets.tsx` (new) + routing + nav

- New `AssetsPage` stub: title "Assets" + a "Coming soon" placeholder. Intended
  to become the accounts/holdings (asset) breakdown.
- Add `assetsRoute` (`path: "/assets"`) under `appLayoutRoute` in `router.tsx`.
- Add Assets to `nav-main.tsx` (sidebar nav) so it is reachable in browser /
  desktop mode too, not only via the PWA tab.

## Out of scope

- Real content for the Assets page (stub only).
- Any change to browser / desktop layout beyond extracting `AppTopBar` and
  `ValuePrivacyToggle` (pure refactor, same rendered output).
- Offline/service-worker behavior — unrelated to this layout work.

## Testing

- Unit: `useIsPWA` synchronous-init returns correct boolean for standalone vs
  not (matchMedia mock). Last-used-account resolver picks the most-recent row's
  account with the documented fallbacks.
- Component/E2E (affected specs only, end of slice): the global add-transaction
  flow creates a transaction against the selected account; tab-bar navigation
  switches active tab; "More" opens the sidebar sheet. Browser-mode layout
  unchanged (top bar + breadcrumb still present). Per `e2e/README.md`, run only
  the affected specs (accounts/transactions) while iterating.

## Risks / notes

- First-paint flash on phone PWA is minimized (sync `useIsPWA` init) but
  `useIsMobile` still resolves in an effect; acceptable, no new hook per
  decision.
- `as any` is banned: the iOS `navigator.standalone` access already uses a
  precise `Navigator & { standalone?: boolean }` type; keep that pattern.
