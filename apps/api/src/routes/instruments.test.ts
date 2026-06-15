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

test("POST /instruments normalizes symbol to uppercase and rejects case-insensitive duplicates", async () => {
  const app = makeApp(instrumentsRoutes);
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });

  // lowercase symbol is stored uppercased
  const first = await app.handle(new Request("http://localhost/instruments", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Apple", kind: "stock", currency: "USD", symbol: "aapl" }),
  }));
  expect(first.status).toBe(200);
  const { id } = await first.json();
  const [row] = await db.select().from(instruments).where(eq(instruments.id, id));
  expect(row.symbol).toBe("AAPL");

  // a differently-cased duplicate is refused with a clean 409
  const dup = await app.handle(new Request("http://localhost/instruments", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Apple again", kind: "stock", currency: "USD", symbol: "AAPL" }),
  }));
  expect(dup.status).toBe(409);
  expect((await dup.json()).error).toBe("duplicate_symbol");

  // symbol-less instruments are exempt from the constraint (multiple allowed)
  for (const name of ["Mystery A", "Mystery B"]) {
    const res = await app.handle(new Request("http://localhost/instruments", {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name, kind: "other", currency: "USD" }),
    }));
    expect(res.status).toBe(200);
  }
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

test("DELETE /instruments/:id without confirm returns 409 + impact summary", async () => {
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

  const res = await app.handle(new Request(`http://localhost/instruments/${instrId}`, { method: "DELETE", headers: { cookie } }));
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.error).toBe("confirm_required");
  expect(body.totalTx).toBe(1);
  expect(body.accounts[0].name).toBe("Brokerage");

  const stillThere = await db.select().from(instruments).where(eq(instruments.id, instrId));
  expect(stillThere.length).toBe(1); // not deleted
});

test("DELETE /instruments/:id?confirm=true cascades instrument, prices, transactions, cash legs", async () => {
  const app = makeApp(instrumentsRoutes);
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const instrId = createId();
  const usd = createId();
  await db.insert(instruments).values({
    id: instrId, symbol: "AAPL", isin: null, name: "Apple", kind: "stock", currency: "USD", createdAt: nowEpoch(),
  });
  await db.insert(instruments).values({
    id: usd, symbol: "USD", isin: null, name: "USD", kind: "currency", currency: "USD", createdAt: nowEpoch(),
  });
  const acc = createId();
  await db.insert(accounts).values({
    id: acc, name: "Brokerage", class: "asset", subtype: "investment", currency: "USD",
    isArchived: 0, sortOrder: 0, createdAt: nowEpoch(), createdBy: "u",
  });
  const S = Number(SCALE);
  const buyId = createId();
  await db.insert(transactions).values({
    id: buyId, accountId: acc, instrumentId: instrId, date: "2026-01-01",
    unitsDelta: 10 * S, unitPriceScaled: 100 * S, feesMinor: 0, notes: null, createdAt: nowEpoch(), createdBy: "u",
  });
  await db.insert(transactions).values({
    id: createId(), accountId: acc, instrumentId: usd, date: "2026-01-01",
    unitsDelta: -1000 * S, unitPriceScaled: S, feesMinor: 0, notes: null,
    linkedTransactionId: buyId, createdAt: nowEpoch(), createdBy: "u",
  });
  await db.insert(prices).values({
    id: createId(), instrumentId: instrId, date: "2026-01-01", priceScaled: 100 * S, source: "trade", createdAt: nowEpoch(),
  });

  const res = await app.handle(new Request(`http://localhost/instruments/${instrId}?confirm=true`, { method: "DELETE", headers: { cookie } }));
  expect(res.status).toBe(200);
  expect((await db.select().from(instruments).where(eq(instruments.id, instrId))).length).toBe(0);
  expect((await db.select().from(prices).where(eq(prices.instrumentId, instrId))).length).toBe(0);
  // both the trade and its linked cash leg are gone
  expect((await db.select().from(transactions).where(eq(transactions.accountId, acc))).length).toBe(0);
});

test("GET /instruments includes latestPriceScaled, latestPriceDate, holderCount", async () => {
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
    id: createId(), instrumentId: instrId, date: "2026-02-01", priceScaled: 130 * S, source: "manual", createdAt: nowEpoch(),
  });
  await db.insert(prices).values({
    id: createId(), instrumentId: instrId, date: "2026-01-10", priceScaled: 110 * S, source: "trade", createdAt: nowEpoch(),
  });

  const list = await (await app.handle(new Request(`http://localhost/instruments`, { headers: { cookie } }))).json();
  const row = list.find((i: any) => i.id === instrId);
  expect(row.latestPriceScaled).toBe(130 * S);
  expect(row.latestPriceDate).toBe("2026-02-01");
  expect(row.holderCount).toBe(1);
});
