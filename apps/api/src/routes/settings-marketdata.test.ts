import { expect, test, beforeEach } from "bun:test";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { settingsRoutes } from "./settings";
import { usersRoutes } from "./users";

beforeEach(resetDb);
const app = makeApp(settingsRoutes);
const appWithUsers = makeApp(settingsRoutes, usersRoutes);

async function memberCookie(adminCookie: string): Promise<string> {
  await appWithUsers.handle(new Request("http://localhost/users", {
    method: "POST", headers: { "content-type": "application/json", cookie: adminCookie },
    body: JSON.stringify({ email: "member@test.com", name: "Member", password: "anothersecret1" }),
  }));
  const signin = await appWithUsers.handle(new Request("http://localhost/api/auth/sign-in/email", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "member@test.com", password: "anothersecret1" }),
  }));
  return signin.headers.get("set-cookie") ?? "";
}

test("PATCH sets market-data key; GET returns marketDataApiKeySet not the key; empty preserves", async () => {
  const { cookie } = await initAndLogin({ app });
  await app.handle(new Request("http://localhost/settings", {
    method: "PATCH", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ marketDataApiKey: "AV-KEY" }),
  }));
  const got = await (await app.handle(new Request("http://localhost/settings", { headers: { cookie } }))).json();
  expect(got.marketDataApiKeySet).toBe(true);
  expect("marketDataApiKey" in got).toBe(false);

  await app.handle(new Request("http://localhost/settings", {
    method: "PATCH", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ projectionEndAge: 80 }),
  }));
  const got2 = await (await app.handle(new Request("http://localhost/settings", { headers: { cookie } }))).json();
  expect(got2.marketDataApiKeySet).toBe(true);
});

test("clearMarketData wipes the stored key", async () => {
  const { cookie } = await initAndLogin({ app });
  await app.handle(new Request("http://localhost/settings", {
    method: "PATCH", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ marketDataApiKey: "AV-KEY" }),
  }));
  await app.handle(new Request("http://localhost/settings", {
    method: "PATCH", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ clearMarketData: true }),
  }));
  const got = await (await app.handle(new Request("http://localhost/settings", { headers: { cookie } }))).json();
  expect(got.marketDataApiKeySet).toBe(false);
});

test("non-admin gets 403 setting the market-data key", async () => {
  const { cookie: adminCookie } = await initAndLogin({ app: appWithUsers });
  const cookie = await memberCookie(adminCookie);
  const denied = await appWithUsers.handle(new Request("http://localhost/settings", {
    method: "PATCH", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ marketDataApiKey: "x" }),
  }));
  expect(denied.status).toBe(403);
  expect((await denied.json()).error).toBe("admin_only");
});
