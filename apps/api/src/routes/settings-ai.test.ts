import { expect, test, beforeEach } from "bun:test";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { settingsRoutes } from "./settings";
import { usersRoutes } from "./users";

beforeEach(resetDb);
const app = makeApp(settingsRoutes);
// A second app that also mounts the users routes so we can mint a non-admin member.
const appWithUsers = makeApp(settingsRoutes, usersRoutes);

// Invite a non-admin member (as admin) and return their session cookie.
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

test("PATCH sets AI fields; GET returns aiApiKeySet not the key; empty key preserved", async () => {
  const { cookie } = await initAndLogin({ app });

  await app.handle(new Request("http://localhost/settings", {
    method: "PATCH", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ aiBaseUrl: "http://localhost:11434/v1", aiModel: "llama3.1", aiApiKey: "sk-secret" }),
  }));

  const got = await (await app.handle(new Request("http://localhost/settings", { headers: { cookie } }))).json();
  expect(got.aiBaseUrl).toBe("http://localhost:11434/v1");
  expect(got.aiModel).toBe("llama3.1");
  expect(got.aiApiKeySet).toBe(true);
  expect("aiApiKey" in got).toBe(false); // raw key never returned

  // PATCH without aiApiKey must NOT wipe the stored key
  await app.handle(new Request("http://localhost/settings", {
    method: "PATCH", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ aiModel: "llama3.2" }),
  }));
  const got2 = await (await app.handle(new Request("http://localhost/settings", { headers: { cookie } }))).json();
  expect(got2.aiApiKeySet).toBe(true);
  expect(got2.aiModel).toBe("llama3.2");
});

test("PATCH clearAi wipes base URL, model, and the stored key", async () => {
  const { cookie } = await initAndLogin({ app });
  await app.handle(new Request("http://localhost/settings", {
    method: "PATCH", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ aiBaseUrl: "http://localhost:11434/v1", aiModel: "llama3.1", aiApiKey: "sk-secret" }),
  }));

  await app.handle(new Request("http://localhost/settings", {
    method: "PATCH", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ clearAi: true }),
  }));

  const got = await (await app.handle(new Request("http://localhost/settings", { headers: { cookie } }))).json();
  expect(got.aiBaseUrl).toBe("");
  expect(got.aiModel).toBe("");
  expect(got.aiApiKeySet).toBe(false);
});

test("non-admin member gets 403 when clearing AI settings", async () => {
  const { cookie: adminCookie } = await initAndLogin({ app: appWithUsers });
  const cookie = await memberCookie(adminCookie);
  const denied = await appWithUsers.handle(new Request("http://localhost/settings", {
    method: "PATCH", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ clearAi: true }),
  }));
  expect(denied.status).toBe(403);
  expect((await denied.json()).error).toBe("admin_only");
});

import { startMockAi } from "../lib/import/ai-server.test-helper";

test("POST /settings/ai/test pings the configured provider", async () => {
  const { cookie } = await initAndLogin({ app });
  const mock = startMockAi({ ok: true });
  try {
    await app.handle(new Request("http://localhost/settings", {
      method: "PATCH", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ aiBaseUrl: mock.baseUrl, aiModel: "m" }),
    }));
    const res = await app.handle(new Request("http://localhost/settings/ai/test", { method: "POST", headers: { cookie } }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  } finally {
    mock.stop();
  }
});

test("POST /settings/ai/test returns ok:false when unconfigured", async () => {
  const { cookie } = await initAndLogin({ app });
  const res = await app.handle(new Request("http://localhost/settings/ai/test", { method: "POST", headers: { cookie } }));
  expect((await res.json()).ok).toBe(false);
});

test("non-admin member gets 403 when PATCHing AI provider fields", async () => {
  const { cookie: adminCookie } = await initAndLogin({ app: appWithUsers });
  const cookie = await memberCookie(adminCookie);

  // Non-AI fields remain writable by a member.
  const okRes = await appWithUsers.handle(new Request("http://localhost/settings", {
    method: "PATCH", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ projectionEndAge: 80 }),
  }));
  expect(okRes.status).toBe(200);

  // AI provider fields are admin-only.
  const denied = await appWithUsers.handle(new Request("http://localhost/settings", {
    method: "PATCH", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ aiBaseUrl: "http://evil/v1" }),
  }));
  expect(denied.status).toBe(403);
  expect((await denied.json()).error).toBe("admin_only");
});

test("non-admin member gets 403 on POST /settings/ai/test", async () => {
  const { cookie: adminCookie } = await initAndLogin({ app: appWithUsers });
  const cookie = await memberCookie(adminCookie);
  const res = await appWithUsers.handle(new Request("http://localhost/settings/ai/test", { method: "POST", headers: { cookie } }));
  expect(res.status).toBe(403);
  expect((await res.json()).error).toBe("admin_only");
});
