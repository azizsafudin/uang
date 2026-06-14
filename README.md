# Uang

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template/REPLACE_WITH_TEMPLATE_CODE)

> One click provisions the **API + web** services and a persistent volume for the
> database. You only confirm the deploy — the auth secret and service URLs are
> wired automatically. See [`docs/DEPLOY.md`](docs/DEPLOY.md) for how the template
> is built. (The button link is a placeholder until the template is published.)

Self-hosted, single-household personal finance. Monorepo: `apps/web` (SPA),
`apps/api` (ElysiaJS/Bun + libSQL/Drizzle), `packages/shared` (money core).

## Dev
1. `bun install`
2. API: `cd apps/api && DATABASE_URL=file:./data/dev.db BETTER_AUTH_SECRET=dev WEB_ORIGIN=http://localhost:5173 bun run dev`
3. Web: `cd apps/web && VITE_API_URL=http://localhost:3000 bun run dev`
4. Open http://localhost:5173 → complete first-run onboarding.

## Test
```
DATABASE_URL=file:./apps/api/data/sweep.db bun test
```
Set `DATABASE_URL` to a disposable file — the API integration tests create and tear down
data, so this keeps your dev database clean.

## Deploy
See `docs/DEPLOY.md`.
