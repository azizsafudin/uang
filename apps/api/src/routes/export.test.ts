import { expect, test, beforeEach, beforeAll } from "bun:test";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { exportRoutes } from "./export";

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

  const buf = await res.arrayBuffer();
  expect(buf.byteLength).toBeGreaterThan(0);

  // SQLite files begin with "SQLite format 3\0" (16 bytes header)
  const header = new Uint8Array(buf, 0, 16);
  const magic = new TextDecoder().decode(header.slice(0, 15));
  expect(magic).toBe("SQLite format 3");
});
