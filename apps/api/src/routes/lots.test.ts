import { expect, test, beforeEach } from "bun:test";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { lotsRoutes } from "./lots";
import { db } from "../db/client";
import { instruments, accounts, prices } from "../db/schema";
import { createId, nowEpoch } from "../lib/ids";

const SCALE = 100_000_000;
beforeEach(resetDb);

async function seedInstrument(currency = "USD") {
  const id = createId();
  await db.insert(instruments).values({ id, symbol: "X", isin: null, name: "X", kind: "stock", currency, createdAt: nowEpoch() });
  return id;
}
async function seedHoldingsAccount() {
  const id = createId();
  await db.insert(accounts).values({
    id, name: "Broker", class: "asset", subtype: "investment", currency: "USD",
    valuationMode: "holdings", isArchived: 0, sortOrder: 0, createdAt: nowEpoch(), createdBy: "seed",
  });
  return id;
}
async function seedPrice(instrumentId: string, date: string, priceMajor: number) {
  await db.insert(prices).values({ id: createId(), instrumentId, date, priceScaled: Math.round(priceMajor * SCALE), source: "manual", createdAt: nowEpoch() });
}

test("requires auth", async () => {
  const app = makeApp(lotsRoutes);
  const res = await app.handle(new Request("http://localhost/accounts/x/lots"));
  expect(res.status).toBe(401);
});

test("add, list, then delete a lot", async () => {
  const app = makeApp(lotsRoutes);
  const { cookie } = await initAndLogin({ app });
  const acc = await seedHoldingsAccount();
  const inst = await seedInstrument();

  const add = await app.handle(new Request(`http://localhost/accounts/${acc}/lots`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ instrumentId: inst, unitsScaled: 10 * SCALE, unitCostScaled: 100 * SCALE, feesMinor: 500, tradeDate: "2026-01-01" }),
  }));
  expect(add.status).toBe(200);
  const { id: lotId } = await add.json();

  const list = await (await app.handle(new Request(`http://localhost/accounts/${acc}/lots`, { headers: { cookie } }))).json();
  expect(list.length).toBe(1);
  expect(list[0].instrumentId).toBe(inst);

  const del = await app.handle(new Request(`http://localhost/lots/${lotId}`, { method: "DELETE", headers: { cookie } }));
  expect(del.status).toBe(200);
  const after = await (await app.handle(new Request(`http://localhost/accounts/${acc}/lots`, { headers: { cookie } }))).json();
  expect(after.length).toBe(0);
});

test("add a lot with an unknown instrument is rejected (422)", async () => {
  const app = makeApp(lotsRoutes);
  const { cookie } = await initAndLogin({ app });
  const acc = await seedHoldingsAccount();

  const add = await app.handle(new Request(`http://localhost/accounts/${acc}/lots`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ instrumentId: "ghost", unitsScaled: SCALE, unitCostScaled: SCALE, tradeDate: "2026-01-01" }),
  }));
  expect(add.status).toBe(422);
});

test("PATCH a lot updates units", async () => {
  const app = makeApp(lotsRoutes);
  const { cookie } = await initAndLogin({ app });
  const acc = await seedHoldingsAccount();
  const inst = await seedInstrument();
  const { id: lotId } = await (await app.handle(new Request(`http://localhost/accounts/${acc}/lots`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ instrumentId: inst, unitsScaled: 10 * SCALE, unitCostScaled: 100 * SCALE, tradeDate: "2026-01-01" }),
  }))).json();

  const patch = await app.handle(new Request(`http://localhost/lots/${lotId}`, {
    method: "PATCH", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ unitsScaled: 20 * SCALE }),
  }));
  expect(patch.status).toBe(200);
  const list = await (await app.handle(new Request(`http://localhost/accounts/${acc}/lots`, { headers: { cookie } }))).json();
  expect(list[0].unitsScaled).toBe(20 * SCALE);
});

test("GET /accounts/:id/holdings returns per-lot valuation + totals", async () => {
  const app = makeApp(lotsRoutes);
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const acc = await seedHoldingsAccount();
  const inst = await seedInstrument("USD");
  await seedPrice(inst, "2026-01-01", 123.45);
  await app.handle(new Request(`http://localhost/accounts/${acc}/lots`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ instrumentId: inst, unitsScaled: 10 * SCALE, unitCostScaled: 100 * SCALE, feesMinor: 500, tradeDate: "2026-01-01" }),
  }));

  const res = await app.handle(new Request(`http://localhost/accounts/${acc}/holdings`, { headers: { cookie } }));
  expect(res.status).toBe(200);
  const h = await res.json();
  expect(h.totalBaseMinor).toBe(123450);
  expect(h.totalGainBaseMinor).toBe(22950);
  expect(h.baseCurrency).toBe("USD");
  expect(h.lots.length).toBe(1);
  expect(h.lots[0].mvMinor).toBe(123450);
  expect(h.lots[0].instrumentCurrency).toBe("USD");
});
