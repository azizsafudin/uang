import { expect, test, beforeEach } from "bun:test";
import { createApp } from "../app";
import { runMigrations } from "../db/migrate";
import { db } from "../db/client";
import { settings, user } from "../db/schema";

// Note: Elysia 1.4.28 requires the host to be >=4 chars (e.g. "localhost") due to
// how it extracts the path from the URL (skips first 11 chars of "http://host/").
// The plan uses "http://x/" but that causes path extraction to fail in 1.4.28,
// so we use "http://localhost/" throughout.
const BASE = "http://localhost";

// Use a fresh in-memory-ish file per run via env set before import is not possible here;
// these tests assume DATABASE_URL points at a disposable file (see run command).
beforeEach(async () => {
  await runMigrations();
  await db.delete(settings);
  await db.delete(user);
});

test("status reports uninitialized when no settings row", async () => {
  const app = createApp();
  const res = await app.handle(new Request(`${BASE}/onboarding/status`));
  expect(await res.json()).toEqual({ initialized: false });
});

test("init creates settings + admin user, and blocks a second init", async () => {
  const app = createApp();
  const body = JSON.stringify({
    householdName: "Safudin",
    baseCurrency: "MYR",
    email: "a@b.com",
    name: "Aziz",
    password: "supersecret1",
  });
  const res = await app.handle(new Request(`${BASE}/onboarding/init`, {
    method: "POST", headers: { "content-type": "application/json" }, body,
  }));
  expect(res.status).toBe(200);

  const s = await db.select().from(settings);
  expect(s.length).toBe(1);
  expect(s[0].baseCurrency).toBe("MYR");
  const u = await db.select().from(user);
  expect(u.length).toBe(1);
  expect(u[0].isAdmin).toBe(true);

  // second attempt is rejected
  const res2 = await app.handle(new Request(`${BASE}/onboarding/init`, {
    method: "POST", headers: { "content-type": "application/json" }, body,
  }));
  expect(res2.status).toBe(409);
});

test("public sign-up is blocked once initialized", async () => {
  const app = createApp();
  // initialize first
  await app.handle(new Request(`${BASE}/onboarding/init`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ householdName: "H", baseCurrency: "MYR", email: "admin@x.com", name: "A", password: "supersecret1" }),
  }));
  // attempt a direct sign-up against the auth mount
  const res = await app.handle(new Request(`${BASE}/api/auth/sign-up/email`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "intruder@x.com", name: "X", password: "supersecret1" }),
  }));
  expect(res.status).toBe(403);
});
