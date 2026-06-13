import { expect, test, beforeEach } from "bun:test";
import { createApp } from "../app";
import { runMigrations } from "../db/migrate";
import { db } from "../db/client";
import { settings, user } from "../db/schema";

// Elysia 1.4.28 requires a host >=4 chars for correct path extraction.
const BASE = "http://localhost";

beforeEach(async () => {
  await runMigrations();
  await db.delete(settings);
  await db.delete(user);
});

test("POST /api/auth/sign-in/email returns 200 with session cookie and user after onboarding", async () => {
  const app = createApp();

  // Initialize the app first (creates the admin user).
  const initRes = await app.handle(
    new Request(`${BASE}/onboarding/init`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        householdName: "TestHouse",
        baseCurrency: "MYR",
        email: "a@b.com",
        name: "Alice",
        password: "supersecret1",
      }),
    }),
  );
  expect(initRes.status).toBe(200);

  // Sign in via the better-auth HTTP route.
  const signInRes = await app.handle(
    new Request(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@b.com", password: "supersecret1" }),
    }),
  );

  expect(signInRes.status).toBe(200);

  // Response body must include the user's email.
  const body = await signInRes.json();
  expect(body.user?.email).toBe("a@b.com");

  // A Set-Cookie header must be present (session cookie).
  const setCookie = signInRes.headers.get("set-cookie");
  expect(setCookie).not.toBeNull();
  expect(setCookie).toMatch(/better-auth\.session_token/);
});

test("GET /api/auth/get-session returns the signed-in user", async () => {
  const app = createApp();

  // Initialize and sign in.
  await app.handle(
    new Request(`${BASE}/onboarding/init`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        householdName: "H",
        baseCurrency: "MYR",
        email: "a@b.com",
        name: "A",
        password: "supersecret1",
      }),
    }),
  );

  const signInRes = await app.handle(
    new Request(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@b.com", password: "supersecret1" }),
    }),
  );
  expect(signInRes.status).toBe(200);

  // Extract the session token from Set-Cookie.
  const setCookie = signInRes.headers.get("set-cookie") ?? "";
  const tokenMatch = setCookie.match(/better-auth\.session_token=([^;]+)/);
  expect(tokenMatch).not.toBeNull();
  const sessionToken = tokenMatch![1];

  // Fetch the session using the token as a cookie.
  const sessionRes = await app.handle(
    new Request(`${BASE}/api/auth/get-session`, {
      headers: { cookie: `better-auth.session_token=${sessionToken}` },
    }),
  );
  expect(sessionRes.status).toBe(200);

  const sessionBody = await sessionRes.json();
  expect(sessionBody.user?.email).toBe("a@b.com");
});

test("GET /api/auth/ok returns 200", async () => {
  const app = createApp();
  const res = await app.handle(new Request(`${BASE}/api/auth/ok`));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});
