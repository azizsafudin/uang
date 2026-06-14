import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { createApp } from "../app";
import { runMigrations } from "../db/migrate";
import { db } from "../db/client";
import { settings, user, accounts, accountOwners, memberProfiles, entries, fxRates, instruments, lots, prices } from "../db/schema";
import { auth } from "../auth";
import { onboarding } from "../routes/onboarding";
import { isInitialized } from "./settings";

// Reset all app + settings tables (NOT better-auth tables unless asked) for a clean test.
export async function resetDb() {
  await runMigrations();
  await db.delete(accountOwners);
  await db.delete(memberProfiles);
  await db.delete(lots);
  await db.delete(prices);
  await db.delete(instruments);
  await db.delete(entries);
  await db.delete(accounts);
  await db.delete(fxRates);
  await db.delete(settings);
  await db.delete(user);
}

// Build a minimal app = base middleware (cors, onboarding, signup-gate, better-auth handler)
// PLUS the given route plugins. Use this in route tests so each route is testable in isolation.
export function makeApp(...routes: Elysia[]) {
  let app: any = new Elysia()
    .use(cors({ origin: process.env.WEB_ORIGIN ?? "http://localhost:5173", credentials: true }))
    .use(onboarding);
  for (const r of routes) app = app.use(r);
  return app
    .onBeforeHandle(async ({ request, set }: any) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/auth/sign-up/email" && (await isInitialized())) { set.status = 403; return { error: "signup_closed" }; }
    })
    .all("/api/auth/*", ({ request }: any) => auth.handler(request), { parse: "none" });
}

// Initialize the household + an admin user, return a session cookie header for authed requests.
export async function initAndLogin(opts?: { baseCurrency?: string; app?: Elysia }) {
  const app = opts?.app ?? createApp();
  await app.handle(new Request("http://localhost/onboarding/init", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      householdName: "Test", baseCurrency: opts?.baseCurrency ?? "USD",
      email: "admin@test.com", name: "Admin", password: "supersecret1",
    }),
  }));
  const res = await app.handle(new Request("http://localhost/api/auth/sign-in/email", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@test.com", password: "supersecret1" }),
  }));
  const cookie = res.headers.get("set-cookie") ?? "";
  return { app, cookie };
}

export { auth };
