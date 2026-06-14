# Deploy on Railway button — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-click "Deploy on Railway" button to the README, backed by repo-side config-as-code and a precise template-publish guide, so the app deploys as two services + a persistent volume with all env wiring automatic.

**Architecture:** Two Railway services (`api` Bun/Elysia + volume at `/data`, `web` nginx static) built from the existing Dockerfiles via per-service `railway.json` config-as-code. Cross-service env (secret, domains, CORS origin, `VITE_API_URL`) is wired through Railway template reference variables, composed once in the dashboard. The README button points at the published template code.

**Tech Stack:** Railway config-as-code (`railway.json`), existing Docker builds (Bun, nginx), Markdown docs.

**Note on testing:** These artifacts are config + docs, so there is no unit test to write. Each task's "verification" is concrete and runnable: the JSON parses, the Dockerfile paths it references exist, and the markdown renders the intended links. The real end-to-end validation (a successful one-click deploy) happens after the user publishes the template — covered in the final task as a manual checklist.

**Spec:** `docs/superpowers/specs/2026-06-15-railway-deploy-button-design.md`

**Branch:** `railway-deploy-button` (already created; spec already committed there).

---

### Task 1: API service config-as-code

**Files:**
- Create: `apps/api/railway.json`

- [ ] **Step 1: Create `apps/api/railway.json`**

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

- [ ] **Step 2: Verify the JSON parses and the referenced Dockerfile + health route exist**

Run:
```bash
python3 -m json.tool apps/api/railway.json > /dev/null && echo "JSON ok"
test -f apps/api/Dockerfile && echo "Dockerfile ok"
grep -q '"/health"' apps/api/src/app.ts && echo "health route ok"
```
Expected output:
```
JSON ok
Dockerfile ok
health route ok
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/railway.json
git commit -m "chore(api): add Railway config-as-code (Dockerfile build + /health check)"
```

---

### Task 2: Web service config-as-code

**Files:**
- Create: `apps/web/railway.json`

- [ ] **Step 1: Create `apps/web/railway.json`**

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

- [ ] **Step 2: Verify the JSON parses and the referenced Dockerfile exists**

Run:
```bash
python3 -m json.tool apps/web/railway.json > /dev/null && echo "JSON ok"
test -f apps/web/Dockerfile && echo "Dockerfile ok"
```
Expected output:
```
JSON ok
Dockerfile ok
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/railway.json
git commit -m "chore(web): add Railway config-as-code (Dockerfile build)"
```

---

### Task 3: README button

**Files:**
- Modify: `README.md` (insert button + note immediately under the `# Uang` title)

- [ ] **Step 1: Insert the button block under the title**

The README currently starts with:
```md
# Uang

Self-hosted, single-household personal finance. Monorepo: `apps/web` (SPA),
`apps/api` (ElysiaJS/Bun + libSQL/Drizzle), `packages/shared` (money core).
```

Change it to (insert the button block between the title and the description):
```md
# Uang

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template/REPLACE_WITH_TEMPLATE_CODE)

> One click provisions the **API + web** services and a persistent volume for the
> database. You only confirm the deploy — the auth secret and service URLs are
> wired automatically. See [`docs/DEPLOY.md`](docs/DEPLOY.md) for how the template
> is built. (The button link is a placeholder until the template is published.)

Self-hosted, single-household personal finance. Monorepo: `apps/web` (SPA),
`apps/api` (ElysiaJS/Bun + libSQL/Drizzle), `packages/shared` (money core).
```

> The literal `REPLACE_WITH_TEMPLATE_CODE` is intentional — it is swapped for the
> real template code after the user publishes the template (final task).

- [ ] **Step 2: Verify the button markup is present**

Run:
```bash
grep -q 'railway.com/button.svg' README.md && echo "button ok"
grep -q 'REPLACE_WITH_TEMPLATE_CODE' README.md && echo "placeholder present"
```
Expected output:
```
button ok
placeholder present
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): add Deploy on Railway button (placeholder template code)"
```

---

### Task 4: Rewrite `docs/DEPLOY.md` as the template-publish guide

**Files:**
- Modify: `docs/DEPLOY.md` (full rewrite, replacing the manual two-service walkthrough)

- [ ] **Step 1: Replace `docs/DEPLOY.md` with the publish guide**

Write the full file contents:

````md
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
````

- [ ] **Step 2: Verify the doc parses as markdown and contains the key wiring**

Run:
```bash
grep -q 'secret(32)' docs/DEPLOY.md && echo "secret ref ok"
grep -q 'web.RAILWAY_PUBLIC_DOMAIN' docs/DEPLOY.md && echo "web ref ok"
grep -q 'api.RAILWAY_PUBLIC_DOMAIN' docs/DEPLOY.md && echo "api ref ok"
grep -q '/data' docs/DEPLOY.md && echo "volume path ok"
```
Expected output:
```
secret ref ok
web ref ok
api ref ok
volume path ok
```

- [ ] **Step 3: Commit**

```bash
git add docs/DEPLOY.md
git commit -m "docs(deploy): rewrite as Railway template-publish guide"
```

---

### Task 5: Publish + finalize (manual, with the user)

This task is performed with the user because it needs their Railway account and a
dashboard action — it cannot be automated.

- [ ] **Step 1: User publishes the template** following `docs/DEPLOY.md` →
  "Publish the template (one-time)".

- [ ] **Step 2: User provides the template code** (the part after
  `railway.com/template/`).

- [ ] **Step 3: Replace the placeholder in the README**

```bash
# Replace CODE with the real template code from the user
sed -i '' 's|railway.com/template/REPLACE_WITH_TEMPLATE_CODE|railway.com/template/CODE|' README.md
grep 'railway.com/template/' README.md   # confirm the code is in place
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(readme): point Deploy on Railway button at published template"
```

- [ ] **Step 5: Smoke-test the one-click deploy** (user, in browser): click the
  button, confirm both services build, the api passes its `/health` check, the web
  app loads, and first-run onboarding works end to end.

---

## Self-review notes

- **Spec coverage:** api `railway.json` (Task 1), web `railway.json` (Task 2),
  README button + note (Task 3), `docs/DEPLOY.md` publish guide incl. all
  reference variables, volume, and the three documented risks (Task 4), publish +
  finalize incl. the success-criteria smoke test (Task 5). All spec sections map
  to a task.
- **Placeholders:** the only intentional placeholder token is
  `REPLACE_WITH_TEMPLATE_CODE`, which Task 5 resolves; no `TBD`/`TODO` left.
- **Consistency:** `dockerfilePath` values (`apps/api/Dockerfile`,
  `apps/web/Dockerfile`), the `/data` mount, and variable names match the spec and
  the existing `apps/api/src/index.ts` guards verbatim.
