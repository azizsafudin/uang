# Deploy and Host azizsafudin/uang on Railway

Uang is a self-hosted, single-household personal finance app. It tracks accounts
(assets and liabilities), investment holdings, and multi-currency balances with
FX, charts net worth over time, and plans savings goals with projections. A
Bun/ElysiaJS API with an embedded SQLite (libSQL) database backs a React
single-page web app.

## About Hosting azizsafudin/uang

Hosting Uang means running a single service from one monorepo: a Bun/ElysiaJS API
that also serves the built React (Vite) front end from the same origin (the app at
`/`, the API under `/api`). The service persists everything in an embedded SQLite
(libSQL) database on a mounted volume, runs Drizzle migrations automatically on
boot, and handles authentication with better-auth using secure session cookies.
Because the app and API share one domain, there is no CORS or cross-service URL
wiring — session cookies are first-party. A generated 32-character auth secret and
a persistent volume are provisioned for you, and the service can sleep when idle to
keep a low-traffic, personal deployment inexpensive.

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
- [Railway reference variables](https://docs.railway.com/reference/variables#reference-variables) — auth URL/secret wiring

### Implementation Details

The service builds from a single root `Dockerfile` (auto-detected by Railway with
Root Directory `/`), which builds the React bundle and runs the Bun API that serves
it. The API reads its persistent database from the mounted volume; the web bundle
targets its own origin and the API infers its public URL from each request, so no
domain or API-URL variables are needed:

```
DATABASE_URL       = file:/data/uang.db
BETTER_AUTH_SECRET = ${{ secret(32) }}
```

The API refuses to start in production without a persistent `DATABASE_URL` and a
strong (32+ char) secret, and runs database migrations automatically on boot. A
public domain is generated for the service so it's reachable; no `BETTER_AUTH_URL`
is wired because `RAILWAY_PUBLIC_DOMAIN` is empty in template deploys (a known
Railway limitation), and the runtime inference avoids depending on it.

## Why Deploy azizsafudin/uang on Railway?

<!-- Recommended: Keep this section as shown below -->
Railway is a singular platform to deploy your infrastructure stack. Railway will host your infrastructure so you don't have to deal with configuration, while allowing you to vertically and horizontally scale it.

By deploying azizsafudin/uang on Railway, you are one step closer to supporting a complete full-stack application with minimal burden. Host your servers, databases, AI agents, and more on Railway.
<!-- End recommended section -->
