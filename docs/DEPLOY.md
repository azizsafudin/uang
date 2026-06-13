# Deploying Uang on Railway (two services)

## api service
- Build: Dockerfile `apps/api/Dockerfile`
- Add a **Volume** mounted at `/data`.
- Env:
  - `DATABASE_URL=file:/data/uang.db`
  - `BETTER_AUTH_SECRET=<random 32+ chars>`
  - `BETTER_AUTH_URL=https://<api-domain>`
  - `WEB_ORIGIN=https://<web-domain>`
  - `NODE_ENV=production`
- Migrations run automatically on boot.

## web service
- Build: Dockerfile `apps/web/Dockerfile`
- Build arg / env: `VITE_API_URL=https://<api-domain>`

## Cookies & CORS
better-auth sets session cookies. For cross-subdomain cookies, host both under one
parent domain (e.g. `app.example.com` + `api.example.com`) and the browser will send
credentials because the SPA uses `credentials: "include"` and the API allows
`WEB_ORIGIN` with `credentials: true`. Ensure both are HTTPS (Secure cookies).

## Backup
Use the in-app export (Plan 2) and periodic Railway volume snapshots.
