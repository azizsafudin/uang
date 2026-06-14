# Uang — End-to-End (Playwright) Testing (design)

**Date:** 2026-06-14
**Status:** Draft for review
**Builds on:** all five merged slices (foundation, accounts/net-worth, ownership, holdings, net-worth graph) on `main`. This adds a UI-level regression suite; it does not change app behavior except for additive `data-testid` attributes.

---

## 1. Goal

Catch regressions in the **wired-together UI journeys** that the existing 76 API/route unit tests can't see — onboarding, creating accounts, the ownership toggle, the holdings flow, and the net-worth graph — by driving a real browser against a real running stack. Each journey runs against an **isolated, ephemeral SQLite database** so runs are deterministic and leave no trace.

After this slice: `bun run e2e` boots the app per worker, runs ~5 headline-journey specs in Chromium, and tears everything down (processes killed, temp DB files deleted).

## 2. Scope

**In scope:** a dedicated `e2e/` workspace with Playwright; a worker-scoped backend fixture (per-worker API+web on ephemeral DB files); a seed/auth helper; ~5 happy-path journey specs (one per feature area); a small set of additive `data-testid` anchors in existing web components; root scripts to run it.

**Out of scope / deferred:** exhaustive edge-case coverage through the UI (validation errors, 422s, missing-rate flags, multi-currency math — already covered by unit/route tests); CI wiring (no git remote yet); visual-regression/screenshot snapshots; cross-browser (Chromium only); mobile viewports.

## 3. Decisions (locked in brainstorming)

- **Coverage:** one end-to-end happy-path spec per feature area (not exhaustive). Unit/route tests already own logic and edge cases.
- **Isolation:** per-worker **ephemeral SQLite files**. The API binds `DATABASE_URL` once at boot and holds the connection, so "fresh file per test" is realized as "fresh file per spec via API restart" (no truncation, no test-only API route).
- **Location:** a dedicated `e2e/` workspace package (added to root `workspaces`).
- **Selectors:** a small set of `data-testid` anchors + roles/visible text for the rest.

## 4. Architecture

### 4.1 Workspace
A new top-level `e2e/` package:
- `e2e/package.json` — `name: "@uang/e2e"`, `private: true`, devDep `@playwright/test`, scripts `test` (`playwright test`) and `test:ui` (`playwright test --ui`).
- Root `package.json` — add `"e2e"` to `workspaces`; add scripts `e2e` (`bun --cwd e2e run test`) and `e2e:ui`.
- `e2e/playwright.config.ts` — `testDir: "./tests"`, `fullyParallel: true`, `workers` configurable (default a small number, e.g. 4), `timeout`/`expect.timeout` generous enough for server boot, `use: { trace: "on-first-retry" }`, Chromium project. **No** top-level `webServer` (servers are fixture-managed per worker).
- Chromium is installed via `bunx playwright install chromium` (documented; run once).

### 4.2 Backend harness — `e2e/tests/fixtures.ts`
A **worker-scoped fixture** (`backend`) that owns a running stack isolated by physical DB file:

- **Ports** derived from `testInfo.workerIndex`: `apiPort = 3100 + workerIndex`, `webPort = 5300 + workerIndex` (clear of dev's 3000/5173).
- **API process:** spawn `bun apps/api/src/index.ts` from the repo root with env:
  - `DATABASE_URL=file:<dbPath>` where `dbPath = /tmp/uang-e2e-<workerIndex>-<seq>.db`
  - `PORT=<apiPort>`, `BETTER_AUTH_SECRET=<a fixed 32+char test secret>`, `WEB_ORIGIN=http://localhost:<webPort>`, `NODE_ENV=test`
  - Readiness: poll `GET http://localhost:<apiPort>/health` until `{ ok: true }` (with a timeout).
  - The API runs migrations + owner-backfill on boot, so the file starts schema-complete and empty.
- **Web process:** spawn `vite --port <webPort>` (via `bun --cwd apps/web run dev -- --port <webPort>`) with env `VITE_API_URL=http://localhost:<apiPort>`. Readiness: poll the web port. (Dev server, not a prod build, because `VITE_API_URL` is injected at dev-server start; one static build can't carry per-worker API URLs.)
- **`baseURL`:** the fixture overrides Playwright's `baseURL` to `http://localhost:<webPort>` so `page.goto("/")` resolves correctly.
- **Fresh DB per spec:** `backend.freshDb()` kills the current API process, deletes the old DB file, and restarts the API on a **new** `/tmp` file (same `apiPort`); the web server stays up (it only references the port). Each spec calls this in `beforeAll`, so every journey starts from an empty schema-complete DB. (Web restart is unnecessary — it holds no DB.)
- **Teardown** (worker end): kill API + web processes; delete every `.db`, `.db-wal`, `.db-shm` file the worker created.

> Cookies: better-auth uses non-secure cookies when `NODE_ENV !== "production"`, so http cookies on `localhost:<webPort>` work without TLS.

### 4.3 Seeding & auth — `e2e/tests/helpers.ts`
Two starting states, both atop a fresh DB:
- **Unseeded** (the onboarding spec): the empty migrated DB; the spec drives the onboarding form in the UI.
- **Seeded** (all other specs): `seedHousehold(context, apiBase)` uses Playwright's `request` to `POST /onboarding/init` (household + admin) then `POST /api/auth/sign-in/email`, captures the `set-cookie`, and injects it via `context.addCookies(...)`. Specs then start already authenticated — no UI login per test.
- Small UI helpers as needed (e.g. `createAccount(page, {...})`, `addFxRate(page, {...})`) built on the `data-testid` anchors, to keep specs readable.

### 4.4 Specs — `e2e/tests/*.spec.ts`
Each journey is a single `test()` organized with `test.step(...)`. Each spec's `beforeAll` calls `backend.freshDb()`; seeded specs also `seedHousehold(...)`.

1. **`onboarding.spec.ts`** — fresh, unseeded. Fill the onboarding form (household name, base currency, admin name/email/password) → submit → lands on the dashboard → net-worth hero reads the zero/empty state.
2. **`accounts.spec.ts`** — seeded. Create a ledger asset account with an opening balance → it appears in the dashboard list and the net-worth headline reflects it → open its detail and record a balance via "Set balance".
3. **`ownership.spec.ts`** — seeded. Invite a second member (Settings) → create an account owned by both (shared) and one owned solely by the admin → on the dashboard, the **Household** headline includes the shared account while a **member** view excludes it; the account **list** shows all regardless of toggle.
4. **`holdings.spec.ts`** — seeded. Create a Holdings (investment) account → "Add lot" with a **new** instrument (name/symbol/currency) + units/cost → set a price via "Update price" → the lot shows a non-zero market value and per-lot gain, and the account value rolls into the dashboard net worth.
5. **`networth-graph.spec.ts`** — seeded. Create an account and give it balances on two dates → the net-worth chart renders a series → switching a preset (e.g. 1Y → YTD) changes the rendered range; the owner toggle re-points the series.

(Settings touches — adding an FX rate, the export link — are exercised inline where a journey needs them, e.g. ownership/holdings, rather than a standalone spec.)

### 4.5 Selectors — additive `data-testid` anchors
A small set of `data-testid` attributes added to existing components (no behavior change), enough to address the journeys stably:
- Dashboard: net-worth hero value; each account row (e.g. `account-row` + the name); the net-worth toggle option buttons; the chart container; the chart preset buttons.
- Account form: the "Add account" trigger; name/type/subtype/currency/valuation/opening-balance fields; submit.
- Owners: the owners checkboxes (keyed by member).
- Account detail: "Set balance" trigger + amount/date fields; (holdings) "Add lot" trigger; instrument select + "new instrument" fields; units/cost/fees/date; "Update price" trigger + price/date.
- Settings: FX currency/date/rate fields + submit; invite name/email/password + submit; export link.

The plan will enumerate the exact `data-testid` strings so specs and components agree.

## 5. Testing / success criteria

- `bun run e2e` from a clean `main` checkout (with Chromium installed) runs all specs green.
- Each spec leaves no residual `/tmp/uang-e2e-*.db*` files and no orphaned API/web processes.
- The suite does not touch the developer's real `apps/api/data/uang.db`.
- Re-running the suite is deterministic (fresh DB per spec).
- The added `data-testid` attributes don't alter rendering; `bun run build` (web) and `bun test` (api) stay green.

## 6. Risks / notes

- **Server-boot flakiness:** mitigated by polling `/health` and the web port with generous timeouts before the first navigation.
- **Port collisions** if a previous run left orphans: the teardown kills processes; the readiness poll surfaces a stuck port quickly. Ports are worker-indexed to avoid intra-run clashes.
- **Vite dev-server cost per worker:** acceptable for ~5 specs; keep `workers` modest. Serial (`workers: 1`) remains a valid fallback — the fixture model is unchanged, just one stack.
- **`bun apps/api/src/index.ts` env guards:** the production guards only trigger under `NODE_ENV=production`; tests run with `NODE_ENV=test`, so the ephemeral `/tmp` DB and test secret are accepted.
