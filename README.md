# Uang

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/uang)

> One click provisions a **single service** (the API serves the web SPA on one
> domain) and a persistent volume for the database. You only confirm the deploy —
> the auth secret and URLs are wired automatically. See
> [`docs/DEPLOY.md`](docs/DEPLOY.md) for how the template is built.

Self-hosted, single-household personal finance. Monorepo: `apps/web` (SPA),
`apps/api` (ElysiaJS/Bun + libSQL/Drizzle), `packages/shared` (money core).

## Dev
1. `bun install`
2. `bun dev` — starts the API (`:3000`) and the Vite dev server (`:5173`) together.
3. Open http://localhost:5173 → complete first-run onboarding.

The Vite dev server proxies `/api` to the API, so the browser talks to a single
origin (`:5173`) — same model as the deployed single service (no `VITE_API_URL`,
no CORS, first-party cookies). The API runs on dev defaults; override via env if
needed (see `.env.example`).

## Test
```
DATABASE_URL=file:./apps/api/data/sweep.db bun test
```
Set `DATABASE_URL` to a disposable file — the API integration tests create and tear down
data, so this keeps your dev database clean.

## Deploy
See `docs/DEPLOY.md`.
