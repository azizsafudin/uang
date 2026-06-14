# Deploy and Host azizsafudin/uang on Railway

Uang is a self-hosted, single-household personal finance app. It tracks accounts
(assets and liabilities), investment holdings, and multi-currency balances with
FX, charts net worth over time, and plans savings goals with projections. A
Bun/ElysiaJS API with an embedded SQLite (libSQL) database backs a React
single-page web app.

## About Hosting azizsafudin/uang

Hosting Uang means running two services from one monorepo: a Bun/ElysiaJS API and
a static React (Vite) front end served by nginx. The API persists everything in an
embedded SQLite (libSQL) database on a mounted volume, runs Drizzle migrations
automatically on boot, and handles authentication with better-auth using secure
session cookies. The two services are wired together through Railway reference
variables, so the front end knows the API's URL and CORS/cookies work across both
HTTPS domains. A generated 32-character auth secret and a persistent volume are
provisioned for you, and both services can sleep when idle to keep a low-traffic,
personal deployment inexpensive.

## Common Use Cases

- Track household net worth over time across multiple accounts and currencies
- Manage investment holdings and instrument prices alongside cash, assets, and liabilities
- Plan and monitor savings goals with projections — fully self-hosted and private

## Dependencies for azizsafudin/uang Hosting

- A persistent volume mounted at `/data` for the SQLite (libSQL) database
- A generated `BETTER_AUTH_SECRET` (32+ chars) for better-auth session signing

### Deployment Dependencies

- [Bun](https://bun.sh) — runtime for the API
- [ElysiaJS](https://elysiajs.com) — API framework
- [Drizzle ORM](https://orm.drizzle.team) + [libSQL](https://github.com/tursodatabase/libsql) — database layer
- [better-auth](https://www.better-auth.com) — authentication
- [Vite](https://vite.dev) + [React](https://react.dev) — web front end
- [Railway reference variables](https://docs.railway.com/reference/variables#reference-variables) — cross-service URL/secret wiring

### Implementation Details

Both services build from Dockerfiles via config-as-code (`apps/api/railway.json`,
`apps/web/railway.json`) and are linked by Railway reference variables. The API
reads its persistent database from the mounted volume and the web build is pointed
at the API's public domain at build time:

```
# api service
DATABASE_URL      = file:/data/uang.db
BETTER_AUTH_SECRET = ${{ secret(32) }}
BETTER_AUTH_URL   = https://${{ RAILWAY_PUBLIC_DOMAIN }}
WEB_ORIGIN        = https://${{ web.RAILWAY_PUBLIC_DOMAIN }}

# web service
VITE_API_URL      = https://${{ api.RAILWAY_PUBLIC_DOMAIN }}
```

The API refuses to start in production without a persistent `DATABASE_URL` and a
strong (32+ char) secret, and runs database migrations automatically on boot.

## Why Deploy azizsafudin/uang on Railway?

<!-- Recommended: Keep this section as shown below -->
Railway is a singular platform to deploy your infrastructure stack. Railway will host your infrastructure so you don't have to deal with configuration, while allowing you to vertically and horizontally scale it.

By deploying azizsafudin/uang on Railway, you are one step closer to supporting a complete full-stack application with minimal burden. Host your servers, databases, AI agents, and more on Railway.
<!-- End recommended section -->
