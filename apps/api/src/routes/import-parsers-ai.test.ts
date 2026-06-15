import { expect, test, beforeEach } from "bun:test";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { db } from "../db/client";
import { settings } from "../db/schema";
import { eq } from "drizzle-orm";
import { startMockAi } from "../lib/import/ai-server.test-helper";
import { settingsRoutes } from "./settings";
import { importParsersRoutes } from "./import-parsers";

beforeEach(resetDb);
const app = makeApp(settingsRoutes, importParsersRoutes);

const CONFIG = {
  version: 1, format: "csv", csv: { delimiter: ",", headerRow: 0, skipRows: 0 },
  fields: {
    date: { column: "Date", format: "YYYY-MM-DD" },
    description: { column: "Desc" },
    amount: { mode: "single", column: "Amount", decimal: ".", thousands: ",", sign: "negativeIsDebit" },
  },
};
const CSV = "Date,Desc,Amount\n2026-01-01,COFFEE,-4.50";

async function enableAi(cookie: string, baseUrl: string) {
  await db.update(settings).set({ aiBaseUrl: baseUrl, aiModel: "m" }).where(eq(settings.id, 1));
}

test("synthesize returns a validated config from the provider", async () => {
  const { cookie } = await initAndLogin({ app });
  const mock = startMockAi(CONFIG);
  try {
    await enableAi(cookie, mock.baseUrl);
    const res = await app.handle(new Request("http://localhost/import-parsers/synthesize", {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ content: CSV }),
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).config.fields.amount.mode).toBe("single");
  } finally { mock.stop(); }
});

test("synthesize returns 422 when AI is not configured", async () => {
  const { cookie } = await initAndLogin({ app });
  const res = await app.handle(new Request("http://localhost/import-parsers/synthesize", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ content: CSV }),
  }));
  expect(res.status).toBe(422);
  expect((await res.json()).error).toBe("ai_not_configured");
});

test("synthesize returns 502 when the provider is unreachable", async () => {
  const { cookie } = await initAndLogin({ app });
  await enableAi(cookie, "http://127.0.0.1:1/v1"); // dead
  const res = await app.handle(new Request("http://localhost/import-parsers/synthesize", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ content: CSV }),
  }));
  expect(res.status).toBe(502);
});

test("refine returns a new validated config", async () => {
  const { cookie } = await initAndLogin({ app });
  const mock = startMockAi(CONFIG);
  try {
    await enableAi(cookie, mock.baseUrl);
    const res = await app.handle(new Request("http://localhost/import-parsers/refine", {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ content: CSV, config: CONFIG, instruction: "dates are ISO", errors: [] }),
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).config.format).toBe("csv");
  } finally { mock.stop(); }
});

test("preview parses the sample with a config and returns first rows + counts", async () => {
  const { cookie } = await initAndLogin({ app });
  const res = await app.handle(new Request("http://localhost/import-parsers/preview", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ content: "Date,Desc,Amount\n2026-01-01,COFFEE,-4.50\n2026-01-02,PAY,1000.00", config: CONFIG, currency: "USD" }),
  }));
  expect(res.status).toBe(200);
  const out = await res.json();
  expect(out.total).toBe(2);
  expect(out.errorCount).toBe(0);
  expect(out.rows[0]).toMatchObject({ date: "2026-01-01", amountMinor: -450, description: "COFFEE" });
});

test("preview returns 422 on an invalid config", async () => {
  const { cookie } = await initAndLogin({ app });
  const res = await app.handle(new Request("http://localhost/import-parsers/preview", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ content: "x", config: { version: 1, format: "csv" }, currency: "USD" }),
  }));
  expect(res.status).toBe(422);
});
