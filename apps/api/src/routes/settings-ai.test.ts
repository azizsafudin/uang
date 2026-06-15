import { expect, test, beforeEach } from "bun:test";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { settingsRoutes } from "./settings";

beforeEach(resetDb);
const app = makeApp(settingsRoutes);

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
