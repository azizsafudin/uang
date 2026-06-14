import { expect, test, beforeEach } from "bun:test";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { pricesRoutes } from "./prices";
import { db } from "../db/client";
import { instruments } from "../db/schema";
import { createId, nowEpoch } from "../lib/ids";

const SCALE = 100_000_000;
beforeEach(resetDb);

async function seedInstrument() {
  const id = createId();
  await db.insert(instruments).values({ id, symbol: "X", isin: null, name: "X", kind: "stock", currency: "USD", createdAt: nowEpoch() });
  return id;
}

test("requires auth", async () => {
  const app = makeApp(pricesRoutes);
  const res = await app.handle(new Request("http://localhost/instruments/x/prices"));
  expect(res.status).toBe(401);
});

test("add a price, list it, upsert same date, then delete", async () => {
  const app = makeApp(pricesRoutes);
  const { cookie } = await initAndLogin({ app });
  const inst = await seedInstrument();

  const add = await app.handle(new Request(`http://localhost/instruments/${inst}/prices`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ date: "2026-01-01", priceScaled: 100 * SCALE }),
  }));
  expect(add.status).toBe(200);

  const upsert = await app.handle(new Request(`http://localhost/instruments/${inst}/prices`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ date: "2026-01-01", priceScaled: 120 * SCALE }),
  }));
  expect(upsert.status).toBe(200);

  const list = await (await app.handle(new Request(`http://localhost/instruments/${inst}/prices`, { headers: { cookie } }))).json();
  expect(list.length).toBe(1);
  expect(list[0].priceScaled).toBe(120 * SCALE);

  const del = await app.handle(new Request(`http://localhost/prices/${list[0].id}`, { method: "DELETE", headers: { cookie } }));
  expect(del.status).toBe(200);
  const after = await (await app.handle(new Request(`http://localhost/instruments/${inst}/prices`, { headers: { cookie } }))).json();
  expect(after.length).toBe(0);
});
