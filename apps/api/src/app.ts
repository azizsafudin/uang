import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { staticPlugin } from "@elysiajs/static";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { auth } from "./auth";
import { onboarding } from "./routes/onboarding";
import { accountsRoutes } from "./routes/accounts";
import { transactionsRoutes } from "./routes/transactions";
import { fxRoutes } from "./routes/fx";
import { networthRoutes } from "./routes/networth";
import { holdingsRoutes } from "./routes/holdings";
import { networthSeriesRoutes } from "./routes/networth-series";
import { usersRoutes } from "./routes/users";
import { membersRoutes } from "./routes/members";
import { settingsRoutes } from "./routes/settings";
import { goalsRoutes } from "./routes/goals";
import { exportRoutes } from "./routes/export";
import { importRoutes } from "./routes/import";
import { instrumentsRoutes } from "./routes/instruments";
import { positionsRoutes } from "./routes/positions";
import { pricesRoutes } from "./routes/prices";
import { marketDataRoutes } from "./routes/market-data";
import { groupsRoutes } from "./routes/groups";
import { importParsersRoutes } from "./routes/import-parsers";
import { importsRoutes } from "./routes/imports";
import { isInitialized } from "./lib/settings";

// The API surface, defined at root-relative paths (`/accounts`, `/onboarding`, …).
// This is the source of the Eden `App` type, so client calls stay `api.accounts…`.
// In production it is mounted under `/api` (see `createWebApp`); the Eden client's
// base URL carries the `/api` prefix, keeping the typed paths clean on both sides.
export function createApiApp() {
  return new Elysia()
    .use(onboarding)
    // Auth-guarded app routes. Each plugin's scoped `authGuard` onBeforeHandle
    // applies only within that plugin, so it never intercepts onboarding or auth.
    .use(accountsRoutes)
    .use(transactionsRoutes)
    .use(importParsersRoutes)
    .use(importsRoutes)
    .use(fxRoutes)
    .use(networthRoutes)
    .use(holdingsRoutes)
    .use(networthSeriesRoutes)
    .use(usersRoutes)
    .use(membersRoutes)
    .use(settingsRoutes)
    .use(goalsRoutes)
    .use(exportRoutes)
    .use(importRoutes)
    .use(instrumentsRoutes)
    .use(positionsRoutes)
    .use(pricesRoutes)
    .use(marketDataRoutes)
    .use(groupsRoutes);
}

export type App = ReturnType<typeof createApiApp>;

// better-auth handler + the public sign-up gate, at the absolute `/api/auth/*`
// path better-auth expects (its basePath is `/api/auth`). Mounted at the top
// level in both the root-path and same-origin servers so the path is identical.
function createAuthApp() {
  return new Elysia()
    // Gate public sign-up once the app is initialized. onBeforeHandle runs before
    // the auth handler for /api/auth/sign-up/email. After first-run, new users are
    // created by an admin via an admin-only invite endpoint; public sign-up stays closed.
    .onBeforeHandle(async ({ request, set }) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/auth/sign-up/email" && (await isInitialized())) {
        set.status = 403;
        return { error: "signup_closed" };
      }
    })
    // Route better-auth requests with the FULL original path so better-auth's
    // router can strip its own basePath (/api/auth) and match routes correctly.
    // parse: "none" prevents Elysia from consuming the request body before
    // auth.handler reads it (critical for POST /api/auth/sign-in/email).
    .all("/api/auth/*", ({ request }) => auth.handler(request), { parse: "none" });
}

// Root-path server: API routes live at the root (`/accounts`, `/onboarding`, …)
// with auth at `/api/auth`. Used by the test suite (route tests call root paths).
export function createApp() {
  return new Elysia()
    .use(cors({
      origin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
      credentials: true,
    }))
    .get("/health", () => ({ ok: true }))
    .use(createAuthApp())
    .use(createApiApp());
}

// Resolve the built web bundle. Defaults to apps/web/dist under the working
// directory (the repo root, where the API process runs); overridable via
// WEB_DIST (set explicitly in the Docker image).
const webDist = process.env.WEB_DIST ?? resolve(process.cwd(), "apps/web/dist");

// Same-origin production server: API under `/api`, auth at `/api/auth`, and the
// built React SPA served from the root with a history-fallback to index.html.
// One service, one domain — no CORS or cross-service URL wiring needed.
export function createWebApp() {
  const app = new Elysia()
    .use(cors({
      origin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
      credentials: true,
    }))
    .get("/health", () => ({ ok: true }))
    .use(createAuthApp())
    .group("/api", (a) => a.use(createApiApp()));

  if (existsSync(webDist)) {
    const indexHtml = readFileSync(join(webDist, "index.html"), "utf8");
    return app
      // alwaysStatic:true registers an exact GET route per asset file. Without it,
      // @elysiajs/static defaults this on by NODE_ENV==="production"; in any non-prod
      // run that serves a built dist it instead mounts a single `GET /*` catch-all,
      // which out-ranks the auth `.all("/api/auth/*")` wildcard for GET requests and
      // 404s endpoints like /api/auth/get-session (breaking session establishment).
      // Pinning it true makes a dev-with-dist server behave like prod and keeps /api
      // routes reachable.
      .use(staticPlugin({ assets: webDist, prefix: "", alwaysStatic: true }))
      // SPA history fallback. Using onError(NOT_FOUND) — rather than a `/*` route —
      // means real routes (API, auth, static assets) always match first; only a
      // genuinely unmatched path lands here. Non-API paths get index.html so
      // client-side routes (e.g. /settings, /goals) survive a refresh/deep-link.
      .onError(({ code, request }) => {
        if (code !== "NOT_FOUND") return;
        if (new URL(request.url).pathname.startsWith("/api/")) {
          return new Response(JSON.stringify({ error: "not_found" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(indexHtml, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      });
  }

  return app;
}
