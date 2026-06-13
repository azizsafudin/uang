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
    // onBeforeHandle runs before the mounted auth handler for /api/auth/sign-up/email.
    // After first-run, new users are created by an admin via an admin-only invite
    // endpoint (Plan 2). Public sign-up stays closed.
    .onBeforeHandle(async ({ request, set }) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/auth/sign-up/email" && (await isInitialized())) {
        set.status = 403;
        return { error: "signup_closed" };
      }
    })
    // Mount better-auth's handler at /api/auth/*
    .mount("/api/auth", auth.handler);
}

export type App = ReturnType<typeof createApp>;
