import { expect, test, beforeEach } from "bun:test";
import { Elysia } from "elysia";
import { authGuard } from "./auth-guard";
import { resetDb, initAndLogin } from "./test-helpers";

beforeEach(resetDb);

function guardedApp() {
  return new Elysia().use(authGuard).get("/whoami", ({ userId }: any) => ({ userId }));
}

test("rejects unauthenticated requests with 401", async () => {
  const app = guardedApp();
  const res = await app.handle(new Request("http://localhost/whoami"));
  expect(res.status).toBe(401);
});

test("allows authenticated requests and exposes userId", async () => {
  const { cookie } = await initAndLogin();
  const app = guardedApp();
  const res = await app.handle(new Request("http://localhost/whoami", { headers: { cookie } }));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(typeof body.userId).toBe("string");
  expect(body.userId.length).toBeGreaterThan(0);
});
