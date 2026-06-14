# Deploy to Railway button — design

## Goal

Add a one-click **"Deploy on Railway"** button to the README that provisions the
full app on Railway: both services (`api`, `web`), a persistent volume for the
SQLite database, and all cross-service environment wiring — with no manual env
editing required by the deployer.

## Constraint that shapes the design

A Railway "Deploy on Railway" button is always backed by a **published template**
(`https://railway.com/template/<CODE>`). Templates can only be created through the
Railway **dashboard** (or the internal GraphQL API the dashboard uses) — there is
**no Railway CLI command** to create or publish one (`railway deploy` only
*consumes* an existing template). The project's services must be linked to a
public GitHub repo, which this one is: `github.com/azizsafudin/uang`.

Therefore the work splits in two:

1. **Repo-side (this spec):** everything that makes the template reliable and the
   one dashboard action trivial — per-service config-as-code, the README button,
   and a precise publish guide.
2. **One dashboard action (the user):** compose + publish the template, copy the
   template code, and hand it back so the README button URL is finalized.

## Topology

Two services (matches the existing Dockerfiles and `docs/DEPLOY.md`):

```
Railway project
├─ api   Bun/Elysia  + Volume → /data (libSQL/SQLite)
└─ web   nginx static (Vite build)
```

## Repo artifacts to add/change

### 1. `apps/api/railway.json`

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": {
    "builder": "DOCKERFILE",
    "dockerfilePath": "apps/api/Dockerfile"
  },
  "deploy": {
    "healthcheckPath": "/health",
    "restartPolicyType": "ON_FAILURE"
  }
}
```

- `dockerfilePath` is relative to the repo root because the existing
  `apps/api/Dockerfile` uses a **repo-root build context** (it copies
  `package.json`, `bun.lock`, `packages/shared`, `apps/api`). The service's Root
  Directory must therefore stay `/`.
- `/health` already exists (`apps/api/src/app.ts` → `.get("/health", …)`).

### 2. `apps/web/railway.json`

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": {
    "builder": "DOCKERFILE",
    "dockerfilePath": "apps/web/Dockerfile"
  },
  "deploy": {
    "restartPolicyType": "ON_FAILURE"
  }
}
```

- No healthcheck: nginx serves a SPA with a catch-all `try_files`, so there's no
  dedicated health route. nginx listens on fixed `8080` (matches `EXPOSE 8080`);
  Railway detects the exposed port.

### 3. `README.md`

Add the button immediately under the title, plus a one-line note on what it
provisions. Placeholder template code until the user publishes:

```md
# Uang

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template/<CODE>)

> One click provisions the API + web services and a persistent volume. You only
> need to confirm the deploy — the database secret and service URLs are wired
> automatically.
```

Keep the existing Dev / Test / Deploy sections; the Deploy section continues to
point at `docs/DEPLOY.md`.

### 4. `docs/DEPLOY.md`

Rewrite to lead with the button + the **template-publish guide** (the user's one
dashboard action), and retain the existing cookies/CORS and backup notes.

## Template composition (the user's one dashboard action — documented in DEPLOY.md)

New Template → add `azizsafudin/uang` **twice**, Root Directory `/` for each:

**Service `api`**
- Config path: `apps/api/railway.json`
- Volume mounted at `/data`
- Variables:
  - `DATABASE_URL=file:/data/uang.db`
  - `NODE_ENV=production`
  - `BETTER_AUTH_SECRET=${{ secret(32) }}`  ← Railway-generated; satisfies the
    ≥32-char production guard in `apps/api/src/index.ts`
  - `BETTER_AUTH_URL=https://${{ RAILWAY_PUBLIC_DOMAIN }}`  ← self-reference
  - `WEB_ORIGIN=https://${{ web.RAILWAY_PUBLIC_DOMAIN }}`

**Service `web`**
- Config path: `apps/web/railway.json`
- Variable (build-time): `VITE_API_URL=https://${{ api.RAILWAY_PUBLIC_DOMAIN }}`

Then **Create Template** → copy the template code → it goes into the README
button URL (replace `<CODE>`).

## Known risks (documented in DEPLOY.md, not blockers)

1. **`VITE_API_URL` is build-time.** It's baked into the static bundle and
   cross-references the api domain. Railway resolves reference variables at
   provision time, so this normally works. If the web bundle ever builds before
   the api domain is assigned, the fallback is: set `VITE_API_URL` to the api
   service's public URL and redeploy the web service once.
2. **`dockerfilePath` with a non-root config file** is mildly under-documented.
   If a build can't find the Dockerfile, the fallback is to set the
   `RAILWAY_DOCKERFILE_PATH=apps/<svc>/Dockerfile` variable on the service
   instead of relying on `build.dockerfilePath`.
3. **nginx fixed port 8080.** Matches `EXPOSE 8080`; Railway detects it. Noted
   in case a future change needs `listen $PORT`.

## Out of scope

- Re-architecting to a single combined service (considered and rejected — keep
  two services).
- Programmatic template creation via the internal GraphQL API.
- Automated volume backups beyond the existing in-app export + Railway volume
  snapshots note.

## Success criteria

- `apps/api/railway.json` and `apps/web/railway.json` exist with the schemas above.
- README shows the button (with a placeholder code until publish) and the note.
- `docs/DEPLOY.md` contains a step-by-step publish guide that, followed verbatim,
  yields a template whose one-click deploy boots both services with a persistent
  DB and working auth/CORS.
- After the user publishes and supplies the code, the README button URL resolves
  to the live template.
