import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { auth } from "./auth";
import { onboarding } from "./routes/onboarding";
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
    .all("/api/auth/*", ({ request }) => auth.handler(request), { parse: "none" });
}

export type App = ReturnType<typeof createApp>;
