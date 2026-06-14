# uang E2E tests (Playwright)

Browser-level regression tests that drive a **real running stack** (Vite web + Elysia API) against an **in-memory, ephemeral database**. They cover the headline user journey of each feature area — onboarding, accounts, ownership, holdings, net-worth graph.

## Run

```bash
bun run e2e          # headless, all specs
bun run e2e:ui       # Playwright UI mode
bunx playwright install chromium   # one-time, first run
```

- Runs **1 worker** by default (each worker boots its own web+API stack; one worker reuses a warm web server → no boot contention, no port juggling). Override with `E2E_WORKERS=N`.
- `E2E_PORT_OFFSET=N` shifts the worker-indexed ports (API `3100+`, web `5300+`) so a second checkout/worktree can run concurrently without clashing.
- No disk artifacts: the API runs on `DATABASE_URL=:memory:`, so each test's `freshDb()` (API restart) yields a clean schema-migrated DB that vanishes with the process.

## The convention — **every new feature gets a journey spec**

When you add or change a user-facing feature, add (or extend) a Playwright journey under `e2e/tests/<feature>.spec.ts` that walks the **happy path through the UI** end-to-end. This is the project's standard "did it actually work in the app?" gate — complementary to the unit/route tests, which own logic and edge cases.

Checklist for a new feature:
1. Add a `data-testid` to any element the test must address that isn't stably reachable by role/text (forms, hero numbers, rows). Keep them additive — no behavior change. Existing anchors live across `apps/web/src/**`.
2. Write one `test()` per journey, organized with `test.step(...)`.
3. `test.beforeEach` → `await backend.freshDb()`; for authenticated flows also `await seedHousehold(request, context, backend.apiURL)`.
4. Assert against **server truth**: after an optimistic mutation, `await page.reload()` before asserting derived values (e.g. the net-worth hero) so you don't race the client cache.
5. Run `bun run e2e` and keep it green before merging.

## Harness (`tests/fixtures.ts`, `tests/helpers.ts`)

- `test` / `expect` — import from `./fixtures` (not `@playwright/test`) to get the `backend` fixture + per-worker `baseURL`.
- `backend` (worker-scoped): `backend.freshDb()` restarts the API on a fresh in-memory DB; `backend.apiURL` / `backend.webURL`. Process **trees** are killed on teardown (no orphaned vite/node), with a one-time Vite cold-compile absorbed by generous timeouts + a single retry.
- `seedHousehold(request, context, apiURL, baseCurrency="USD")` — creates the household + admin via the API and injects the session cookie, so the test starts authenticated.
- `createLedgerAccount(page, { name, currency?, opening? })` — opens the Add-account dialog and creates a ledger account.

## What's covered

| Spec | Journey |
|------|---------|
| `smoke` | harness proof: onboarding renders (unseeded) + authed dashboard (seeded) |
| `onboarding` | first-run setup → lands on the dashboard at $0 |
| `accounts` | create a ledger account + opening balance → headline; set balance on detail |
| `ownership` | invite a member, create shared vs personal accounts, net-worth owner toggle |
| `holdings` | create a holdings account, add a lot (new instrument), set price, see per-lot gain + dashboard rollup |
| `networth-graph` | chart renders a series, preset switching, empty-state on an inverted custom range |
