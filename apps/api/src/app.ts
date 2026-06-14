import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { auth } from "./auth";
import { onboarding } from "./routes/onboarding";
import { accountsRoutes } from "./routes/accounts";
import { entriesRoutes } from "./routes/entries";
import { fxRoutes } from "./routes/fx";
import { networthRoutes } from "./routes/networth";
import { networthSeriesRoutes } from "./routes/networth-series";
import { usersRoutes } from "./routes/users";
import { membersRoutes } from "./routes/members";
import { exportRoutes } from "./routes/export";
import { instrumentsRoutes } from "./routes/instruments";
import { lotsRoutes } from "./routes/lots";
import { pricesRoutes } from "./routes/prices";
import { isInitialized } from "./lib/settings";

export function createApp() {
  return new Elysia()
    .use(cors({
      origin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
      credentials: true,
    }))
    .get("/health", () => ({ ok: true }))
    .use(onboarding)
    // Gate public sign-up once the app is initialized.
    // onBeforeHandle runs before the auth handler for /api/auth/sign-up/email.
    // After first-run, new users are created by an admin via an admin-only invite
    // endpoint (Plan 2). Public sign-up stays closed.
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
    .all("/api/auth/*", ({ request }) => auth.handler(request), { parse: "none" })
    // Auth-guarded app routes are mounted AFTER the auth/onboarding handlers.
    // Each of these route plugins uses `authGuard`, whose scoped onBeforeHandle
    // propagates forward; mounting them last keeps it from intercepting
    // /api/auth/* (sign-in) or /onboarding/*.
    .use(accountsRoutes)
    .use(entriesRoutes)
    .use(fxRoutes)
    .use(networthRoutes)
    .use(networthSeriesRoutes)
    .use(usersRoutes)
    .use(membersRoutes)
    .use(exportRoutes)
    .use(instrumentsRoutes)
    .use(lotsRoutes)
    .use(pricesRoutes);
}

export type App = ReturnType<typeof createApp>;
