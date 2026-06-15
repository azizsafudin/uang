import { expect, test, beforeEach } from "bun:test";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { instrumentsRoutes } from "./instruments";
import { db } from "../db/client";
import { instruments, accounts, transactions, prices } from "../db/schema";
import { createId, nowEpoch } from "../lib/ids";
import { SCALE } from "@uang/shared";
import { eq } from "drizzle-orm";

beforeEach(resetDb);

test("requires auth", async () => {
  const app = makeApp(instrumentsRoutes);
  const res = await app.handle(new Request("http://localhost/instruments"));
  expect(res.status).toBe(401);
});

test("create then list instruments", async () => {
  const app = makeApp(instrumentsRoutes);
  const { cookie } = await initAndLogin({ app });

  const create = await app.handle(new Request("http://localhost/instruments", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Apple", kind: "stock", currency: "usd", symbol: "AAPL" }),
  }));
  expect(create.status).toBe(200);
  const { id } = await create.json();
  expect(id).toBeTruthy();

  const list = await (await app.handle(new Request("http://localhost/instruments", { headers: { cookie } }))).json();
  expect(list.length).toBe(1);
  expect(list[0].name).toBe("Apple");
  expect(list[0].symbol).toBe("AAPL");
  expect(list[0].currency).toBe("USD"); // uppercased
});

test("POST /instruments/currency find-or-creates and is idempotent", async () => {
  const app = makeApp(instrumentsRoutes);
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });

  const r1 = await app.handle(new Request("http://localhost/instruments/currency", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ symbol: "sgd" }),
  }));
  expect(r1.status).toBe(200);
  const b1 = await r1.json();
  expect(b1.symbol).toBe("SGD");
  expect(b1.kind).toBe("currency");

  const r2 = await app.handle(new Request("http://localhost/instruments/currency", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ symbol: "SGD" }),
  }));
  const b2 = await r2.json();
  expect(b2.id).toBe(b1.id);
});

test("POST /instruments accepts crypto kind", async () => {
  const app = makeApp(instrumentsRoutes);
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const res = await app.handle(new Request("http://localhost/instruments", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Bitcoin", kind: "crypto", currency: "USD", symbol: "BTC" }),
  }));
  expect(res.status).toBe(200);
});

test("PATCH /instruments/:id edits fields", async () => {
  const app = makeApp(instrumentsRoutes);
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const id = createId();
  await db.insert(instruments).values({
    id, symbol: "AAPL", isin: null, name: "Apple", kind: "stock", currency: "USD", createdAt: nowEpoch(),
  });
  const res = await app.handle(new Request(`http://localhost/instruments/${id}`, {
    method: "PATCH", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Apple Inc.", symbol: "AAPL.US" }),
  }));
  expect(res.status).toBe(200);
  const [row] = await db.select().from(instruments).where(eq(instruments.id, id));
  expect(row.name).toBe("Apple Inc.");
  expect(row.symbol).toBe("AAPL.US");
});

test("GET /instruments/:id returns holders with units, value, and tx counts", async () => {
  const app = makeApp(instrumentsRoutes);
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const instrId = createId();
  await db.insert(instruments).values({
    id: instrId, symbol: "AAPL", isin: null, name: "Apple", kind: "stock", currency: "USD", createdAt: nowEpoch(),
  });
  const acc = createId();
  await db.insert(accounts).values({
    id: acc, name: "Brokerage", class: "asset", subtype: "investment", currency: "USD",
    isArchived: 0, sortOrder: 0, createdAt: nowEpoch(), createdBy: "u",
  });
  const S = Number(SCALE);
  await db.insert(transactions).values({
    id: createId(), accountId: acc, instrumentId: instrId, date: "2026-01-01",
    unitsDelta: 10 * S, unitPriceScaled: 100 * S, feesMinor: 0, notes: null, createdAt: nowEpoch(), createdBy: "u",
  });
  await db.insert(prices).values({
    id: createId(), instrumentId: instrId, date: "2026-01-02", priceScaled: 120 * S, source: "manual", createdAt: nowEpoch(),
  });

  const res = await app.handle(new Request(`http://localhost/instruments/${instrId}`, { headers: { cookie } }));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.instrument.id).toBe(instrId);
  expect(body.latestPriceScaled).toBe(120 * S);
  expect(body.accounts.length).toBe(1);
  expect(body.accounts[0].units).toBe(10 * S);
  expect(body.accounts[0].marketValueMinor).toBe(120000); // 10 × $120
  expect(body.accounts[0].txCount).toBe(1);
  expect(body.totalTx).toBe(1);
});

test("GET /instruments/:id returns 404 for unknown id", async () => {
  const app = makeApp(instrumentsRoutes);
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const res = await app.handle(new Request(`http://localhost/instruments/nope`, { headers: { cookie } }));
  expect(res.status).toBe(404);
});
