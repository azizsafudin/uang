import { expect, test, beforeEach, beforeAll } from "bun:test";
import { unzipSync, strFromU8 } from "fflate";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { exportRoutes } from "./export";
import { accountsRoutes } from "./accounts";

const app = makeApp(exportRoutes);
let cookie = "";

// Migrate + seed once before all tests in this file.
beforeAll(async () => {
  await resetDb();
  ({ cookie } = await initAndLogin({ app }));
});

// Keep the DB fresh between tests (re-init session after each reset).
beforeEach(async () => {
  await resetDb();
  ({ cookie } = await initAndLogin({ app }));
});

test("GET /export without cookie returns 401", async () => {
  const res = await app.handle(new Request("http://localhost/export"));
  expect(res.status).toBe(401);
});

test("GET /export with cookie returns 200, correct headers, and a SQLite file body", async () => {
  const res = await app.handle(
    new Request("http://localhost/export", { headers: { cookie } }),
  );

  expect(res.status).toBe(200);

  const contentType = res.headers.get("content-type") ?? "";
  expect(contentType).toBe("application/octet-stream");

  const disposition = res.headers.get("content-disposition") ?? "";
  expect(disposition).toContain("attachment");
  expect(disposition).toContain(".db");
  // Filename carries the household slug (initAndLogin household is "Test").
  expect(disposition).toContain("test.db");

  const buf = await res.arrayBuffer();
  expect(buf.byteLength).toBeGreaterThan(0);

  // SQLite files begin with "SQLite format 3\0" (16 bytes header)
  const header = new Uint8Array(buf, 0, 16);
  const magic = new TextDecoder().decode(header.slice(0, 15));
  expect(magic).toBe("SQLite format 3");
});

test("GET /export/csv without cookie returns 401", async () => {
  const res = await app.handle(new Request("http://localhost/export/csv"));
  expect(res.status).toBe(401);
});

test("GET /export/csv returns a zip containing the expected CSVs", async () => {
  const csvApp = makeApp(accountsRoutes, exportRoutes);
  const { cookie: c } = await initAndLogin({ app: csvApp });

  await csvApp.handle(
    new Request("http://localhost/accounts", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: c },
      body: JSON.stringify({
        name: "Checking",
        class: "asset",
        subtype: "bank",
        currency: "USD",
      }),
    }),
  );

  const res = await csvApp.handle(
    new Request("http://localhost/export/csv", { headers: { cookie: c } }),
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/zip");
  expect(res.headers.get("content-disposition") ?? "").toContain("test.zip");

  const buf = new Uint8Array(await res.arrayBuffer());
  const files = unzipSync(buf);
  expect(Object.keys(files).sort()).toEqual([
    "accounts.csv",
    "goals.csv",
    "holdings.csv",
    "settings.csv",
    "transactions.csv",
  ]);

  const accountsCsv = strFromU8(files["accounts.csv"]);
  expect(accountsCsv.split("\r\n")[0]).toBe(
    "name,class,subtype,currency,institution,group,archived,growth_rate_pct,accessible_from_age,early_withdrawal,illiquid,liquidation_age",
  );
  expect(accountsCsv).toContain("Checking");
});
