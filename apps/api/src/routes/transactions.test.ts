import { expect, test, beforeEach } from "bun:test";
import { db } from "../db/client";
import { accounts, instruments, transactions, prices } from "../db/schema";
import { eq } from "drizzle-orm";
import { SCALE } from "@uang/shared";
import { createId, nowEpoch } from "../lib/ids";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { transactionsRoutes } from "./transactions";

beforeEach(resetDb);
const app = makeApp(transactionsRoutes);
const S = Number(SCALE);

async function seedAccount(currency = "USD"): Promise<string> {
  const id = createId();
  await db.insert(accounts).values({
    id, name: "Acct", class: "asset", subtype: "investment", currency,
    isArchived: 0, sortOrder: 0, createdAt: nowEpoch(), createdBy: "u",
    growthRateBps: 0, accessibleFromAge: 0, earlyWithdrawal: "none",
    earlyHaircutBps: 0, illiquid: 0, liquidationAge: null,
  });
  return id;
}

async function seedInstrument(kind: string, currency = "USD"): Promise<string> {
  const id = createId();
  await db.insert(instruments).values({
    id, symbol: "X", isin: null, name: "Instr",
    kind: kind as "currency" | "stock" | "etf" | "fund" | "crypto" | "other",
    currency, createdAt: nowEpoch(),
  });
  return id;
}

test("POST creates a transaction and GET lists it with instrument info, date desc", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const acc = await seedAccount();
  const instr = await seedInstrument("stock");

  const create = await app.handle(new Request(`http://localhost/accounts/${acc}/transactions`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ instrumentId: instr, date: "2026-01-01", unitsDelta: 10 * S, unitPriceScaled: 100 * S }),
  }));
  expect(create.status).toBe(200);

  await app.handle(new Request(`http://localhost/accounts/${acc}/transactions`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ instrumentId: instr, date: "2026-03-01", unitsDelta: 5 * S, unitPriceScaled: 120 * S }),
  }));

  const list = await (await app.handle(new Request(`http://localhost/accounts/${acc}/transactions`, { headers: { cookie } }))).json();
  expect(list.length).toBe(2);
  expect(list[0].date).toBe("2026-03-01"); // desc
  expect(list[0].instrument.kind).toBe("stock");
});

test("POST rejects an unknown instrument with 422", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const acc = await seedAccount();
  const res = await app.handle(new Request(`http://localhost/accounts/${acc}/transactions`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ instrumentId: "nope", date: "2026-01-01", unitsDelta: 100 }),
  }));
  expect(res.status).toBe(422);
});

test("POST with cashLeg atomically writes both legs", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const acc = await seedAccount();
  const stock = await seedInstrument("stock");
  const usd = await seedInstrument("currency", "USD");

  const res = await app.handle(new Request(`http://localhost/accounts/${acc}/transactions`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      instrumentId: stock, date: "2026-01-01", unitsDelta: 10 * S, unitPriceScaled: 100 * S, feesMinor: 500,
      cashLeg: { instrumentId: usd, unitsDelta: -1005 * S },
    }),
  }));
  expect(res.status).toBe(200);
  const rows = await db.select().from(transactions).where(eq(transactions.accountId, acc));
  expect(rows.length).toBe(2);
});

test("PATCH edits fields; DELETE removes the row", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const acc = await seedAccount();
  const instr = await seedInstrument("stock");
  const txId = createId();
  await db.insert(transactions).values({
    id: txId, accountId: acc, instrumentId: instr, date: "2026-01-01",
    unitsDelta: 10 * S, unitPriceScaled: 100 * S, feesMinor: 0, notes: null,
    createdAt: nowEpoch(), createdBy: "u",
  });

  const patch = await app.handle(new Request(`http://localhost/transactions/${txId}`, {
    method: "PATCH", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ unitsDelta: 20 * S, notes: "topped up" }),
  }));
  expect(patch.status).toBe(200);
  const [after] = await db.select().from(transactions).where(eq(transactions.id, txId));
  expect(after.unitsDelta).toBe(20 * S);
  expect(after.notes).toBe("topped up");

  await app.handle(new Request(`http://localhost/transactions/${txId}`, { method: "DELETE", headers: { cookie } }));
  const remaining = await db.select().from(transactions).where(eq(transactions.id, txId));
  expect(remaining.length).toBe(0);
});

test("POST a stock buy seeds a trade-sourced price at the trade date", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const acc = await seedAccount();
  const stock = await seedInstrument("stock");

  await app.handle(new Request(`http://localhost/accounts/${acc}/transactions`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ instrumentId: stock, date: "2026-01-01", unitsDelta: 10 * S, unitPriceScaled: 50 * S }),
  }));

  const rows = await db.select().from(prices).where(eq(prices.instrumentId, stock));
  expect(rows.length).toBe(1);
  expect(rows[0].date).toBe("2026-01-01");
  expect(rows[0].source).toBe("trade");
  expect(rows[0].priceScaled).toBe(50 * S);
});

test("POST a currency (cash) transaction does NOT seed a price", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const acc = await seedAccount();
  const usd = await seedInstrument("currency", "USD");

  await app.handle(new Request(`http://localhost/accounts/${acc}/transactions`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ instrumentId: usd, date: "2026-01-01", unitsDelta: 1000 * S, unitPriceScaled: S }),
  }));

  const rows = await db.select().from(prices).where(eq(prices.instrumentId, usd));
  expect(rows.length).toBe(0);
});

test("PATCH editing a trade's price updates its trade-sourced price row", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const acc = await seedAccount();
  const stock = await seedInstrument("stock");
  const create = await (await app.handle(new Request(`http://localhost/accounts/${acc}/transactions`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ instrumentId: stock, date: "2026-01-01", unitsDelta: 10 * S, unitPriceScaled: 50 * S }),
  }))).json();

  await app.handle(new Request(`http://localhost/transactions/${create.id}`, {
    method: "PATCH", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ unitPriceScaled: 60 * S }),
  }));

  const [row] = await db.select().from(prices).where(eq(prices.instrumentId, stock));
  expect(row.priceScaled).toBe(60 * S);
});

test("POST with cashLeg links the cash leg to the main trade", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const acc = await seedAccount();
  const stock = await seedInstrument("stock");
  const usd = await seedInstrument("currency", "USD");

  const create = await (await app.handle(new Request(`http://localhost/accounts/${acc}/transactions`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      instrumentId: stock, date: "2026-01-01", unitsDelta: 10 * S, unitPriceScaled: 100 * S,
      cashLeg: { instrumentId: usd, unitsDelta: -1000 * S },
    }),
  }))).json();

  const leg = await db.select().from(transactions).where(eq(transactions.instrumentId, usd));
  expect(leg.length).toBe(1);
  expect(leg[0].linkedTransactionId).toBe(create.id);
});
