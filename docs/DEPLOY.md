# Deploying Uang on Railway

The fastest path is the **Deploy on Railway** button in the [README](../README.md).
It provisions **one service** and a persistent volume in one click, with all
environment variables wired automatically.

Uang deploys as a **single service**: the Bun/Elysia API serves the built React
SPA from the same origin (the API lives under `/api`, the app at `/`). One domain,
one volume — no CORS or cross-service URL wiring.

The button is backed by a Railway **template**. Templates can only be created in
the Railway dashboard (there is no CLI command for it), so the steps below are a
one-time action to publish the template; afterwards anyone can deploy with the
button.

> **Why one service with a root `Dockerfile`.** Railway reliably uses the
> Dockerfile builder only when a file named `Dockerfile` sits at the service's
> Root Directory. A Dockerfile in a subdirectory is **not** reliably picked up:
> the template editor has no config-as-code path field, and the
> `RAILWAY_DOCKERFILE_PATH` variable does **not** override Railway's Railpack
> auto-builder for a Bun workspace monorepo (it ignores the variable and fails
> with "No start command detected"). A single root `Dockerfile` sidesteps all of
> that — Railway auto-detects it and always builds with Docker.

## Publish the template (one-time)

1. Railway dashboard → your workspace → **Templates** → **New Template**.
2. **Add a service** from GitHub repo `azizsafudin/uang`:
   - **Root Directory:** `/` (so the root `Dockerfile` is detected and the Docker
     build context is the repo root, which the build needs).
   - **Add a Volume**, mount path **`/data`**.
   - **Variables:**
     | Key | Value |
     | --- | --- |
     | `DATABASE_URL` | `file:/data/uang.db` |
     | `NODE_ENV` | `production` |
     | `BETTER_AUTH_SECRET` | `${{ secret(32) }}` |
     | `BETTER_AUTH_URL` | `https://${{ RAILWAY_PUBLIC_DOMAIN }}` |
     | `WEB_ORIGIN` | `https://${{ RAILWAY_PUBLIC_DOMAIN }}` |
   - **Settings:** set **Healthcheck Path** = `/health`, and enable **Serverless**.
3. Click **Create Template**, then **Publish** it (publishing is what makes the
   public deploy link resolve — a created-but-unpublished template 404s for
   anyone outside your workspace).
4. Point the README button at the published template's deploy URL. The current
   published template is <https://railway.com/deploy/uang>.

## Why these values

- No `RAILWAY_DOCKERFILE_PATH`, no `VITE_API_URL`. The build uses the root
  `Dockerfile` automatically, and the web bundle targets its own origin
  (`window.location.origin`), so the SPA finds the API at `/api` on the same
  domain with zero configuration.
- `BETTER_AUTH_SECRET=${{ secret(32) }}` generates a 32-char secret, satisfying
  the `>= 32 chars` production guard in `apps/api/src/index.ts`.
- `DATABASE_URL=file:/data/uang.db` points at the mounted volume, satisfying the
  "refuse to start without a persistent DATABASE_URL" guard (it rejects `/tmp/`
  and missing values).
- `BETTER_AUTH_URL` / `WEB_ORIGIN` are the service's own public domain (a Railway
  reference variable). Same origin for the app and API means `WEB_ORIGIN` (used by
  better-auth's trusted origins and CORS) is simply the deploy's domain.

## Serverless (app sleeping)

Enabling **Serverless** (step 2 above) scales the service to zero after ~10
minutes with no inbound traffic and wakes it on the next request. This keeps a
personal, low-traffic deploy cheap. Trade-off: the first request after idle pays a
cold start. The healthcheck does **not** keep the service awake — Railway only
pings it at deploy time, not continuously. To keep it always-on, toggle Serverless
off in the service settings.

## Cookies & CORS

better-auth sets session cookies. Because the SPA and API share one origin, the
session cookie is first-party and there is no cross-origin request to configure —
CORS is effectively a no-op. `BETTER_AUTH_URL`/`WEB_ORIGIN` being the live HTTPS
domain means `Secure` cookies work out of the box.

## Known gotchas

- **"No start command detected" / Railpack runs instead of Docker:** Railway isn't
  using the root `Dockerfile`. Confirm the service's **Root Directory** is `/` (not
  a subdirectory) so the root `Dockerfile` is detected. Do **not** rely on
  `RAILWAY_DOCKERFILE_PATH` — it does not override Railpack for this monorepo.
- **Port:** the API reads `PORT` (Railway injects it) and listens there; `EXPOSE
  3000` is just a default. No manual port wiring needed.
- **First boot:** the API runs database migrations automatically on start, so the
  first request after a fresh deploy may be slightly slower.

## Manual deploy (without the template)

Create one service pointing at the repo with **Root Directory `/`** (the root
`Dockerfile` is detected automatically), add the `/data` volume, and set the
variables above (using your real domain in place of the `${{ … }}` reference).

## Local development

Locally the two apps run separately for fast iteration: the API on `:3000` and the
Vite dev server on `:5173`. Set `VITE_API_URL=http://localhost:3000` (see
`.env.example`) so the dev client reaches the cross-origin API; `WEB_ORIGIN` lets
the API's CORS accept it. In production neither is needed — everything is one
origin.

## Backup

Use the in-app export plus periodic Railway volume snapshots of the `/data`
volume.
