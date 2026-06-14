# Deploying Uang on Railway

The fastest path is the **Deploy on Railway** button in the [README](../README.md).
It provisions two services (`api`, `web`) and a persistent volume in one click,
with all environment variables wired automatically.

The button is backed by a Railway **template**. Templates can only be created in
the Railway dashboard (there is no CLI command for it), so the steps below are a
one-time action to publish the template; afterwards anyone can deploy with the
button.

## Publish the template (one-time)

1. Railway dashboard → your workspace → **Templates** → **New Template**.
2. **Add the `api` service** from GitHub repo `azizsafudin/uang`:
   - **Root Directory:** `/`
   - **Config-as-code path:** `apps/api/railway.json`
   - **Add a Volume**, mount path **`/data`**.
   - **Variables:**
     | Key | Value |
     | --- | --- |
     | `DATABASE_URL` | `file:/data/uang.db` |
     | `NODE_ENV` | `production` |
     | `BETTER_AUTH_SECRET` | `${{ secret(32) }}` |
     | `BETTER_AUTH_URL` | `https://${{ RAILWAY_PUBLIC_DOMAIN }}` |
     | `WEB_ORIGIN` | `https://${{ web.RAILWAY_PUBLIC_DOMAIN }}` |
3. **Add the `web` service** from the same repo `azizsafudin/uang`:
   - **Root Directory:** `/`
   - **Config-as-code path:** `apps/web/railway.json`
   - **Variables:**
     | Key | Value |
     | --- | --- |
     | `VITE_API_URL` | `https://${{ api.RAILWAY_PUBLIC_DOMAIN }}` |
4. Click **Create Template**, then **copy the template code** (the bit after
   `railway.com/template/`).
5. Replace `REPLACE_WITH_TEMPLATE_CODE` in the README button URL with that code
   and commit.

## Why these values

- `BETTER_AUTH_SECRET=${{ secret(32) }}` generates a 32-char secret, satisfying
  the `>= 32 chars` production guard in `apps/api/src/index.ts`.
- `DATABASE_URL=file:/data/uang.db` points at the mounted volume, satisfying the
  "refuse to start without a persistent DATABASE_URL" guard (it rejects `/tmp/`
  and missing values).
- `BETTER_AUTH_URL` / `WEB_ORIGIN` / `VITE_API_URL` use Railway **reference
  variables** so the two services discover each other's generated domains without
  manual editing.

## Serverless (app sleeping)

Both `railway.json` files set `deploy.sleepApplication: true`, so each service
scales to zero after ~10 minutes with no outbound traffic and wakes on the next
inbound request. This keeps a personal, low-traffic deploy cheap. Trade-off: the
first request after idle pays a cold start. The `api` healthcheck does **not**
keep the service awake — Railway only pings it at deploy time, not continuously.
To keep a service always-on instead, remove `sleepApplication` from its
`railway.json` (or toggle Serverless off in the service settings).

## Cookies & CORS

better-auth sets session cookies. The SPA calls the API with
`credentials: "include"`, and the API allows `WEB_ORIGIN` with
`credentials: true`. Both services get HTTPS Railway domains, so `Secure` cookies
work. Because `WEB_ORIGIN` and `VITE_API_URL` are wired to the live domains, no
cross-origin configuration is needed beyond the variables above.

## Known gotchas

- **`VITE_API_URL` is baked in at build time** (it's a Vite env compiled into the
  static bundle). Railway resolves reference variables at provision time, so this
  normally just works. If the web bundle is ever built before the `api` domain is
  assigned and API calls 404, set `VITE_API_URL` to the api service's public URL
  and **redeploy the web service** once.
- **Dockerfile path:** if a build can't find the Dockerfile, set the variable
  `RAILWAY_DOCKERFILE_PATH=apps/api/Dockerfile` (or `apps/web/Dockerfile`) on the
  service instead of relying on `build.dockerfilePath` in `railway.json`.
- **Web port:** nginx listens on `8080` (matches `EXPOSE 8080`); Railway detects
  it. No `PORT` wiring needed for the static service.

## Manual deploy (without the template)

You can also create two services by hand pointing at the same Dockerfiles
(`apps/api/Dockerfile`, `apps/web/Dockerfile`) with Root Directory `/`, add the
`/data` volume on `api`, and set the same variables listed above (using your real
domains in place of the `${{ … }}` references).

## Backup

Use the in-app export plus periodic Railway volume snapshots of the `/data`
volume.
