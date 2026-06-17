import { expect, test, beforeEach } from "bun:test";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { holdingsRoutes } from "./holdings";
import { db } from "../db/client";
import { accounts, instruments, transactions, prices, accountOwners } from "../db/schema";
import { SCALE } from "@uang/shared";
import { createId, nowEpoch } from "../lib/ids";
import { ensureCurrencyInstrument } from "../lib/instruments";

beforeEach(resetDb);

const app = makeApp(holdingsRoutes);
const S = Number(SCALE);

async function makeAccount(opts: {
  name: string; subtype: string; currency: string; userId: string;
}): Promise<string> {
  const id = createId();
  await db.insert(accounts).values({
    id, name: opts.name, class: "asset", subtype: opts.subtype, currency: opts.currency,
    isArchived: 0, sortOrder: 0, createdAt: nowEpoch(), createdBy: opts.userId,
  });
  return id;
}

// A cash balance: a (shared) currency instrument + a single deposit priced at SCALE.
// The currency instrument is find-or-created (it's unique per symbol), so seeding
// multiple cash accounts in the same currency reuses the one instrument row.
async function seedCash(accountId: string, currency: string, amountMajor: number) {
  const instrId = await ensureCurrencyInstrument(currency);
  await db.insert(transactions).values({
    id: createId(), accountId, instrumentId: instrId, date: "2026-01-01",
    unitsDelta: Math.round(amountMajor * S), unitPriceScaled: S, feesMinor: 0,
    notes: null, createdAt: nowEpoch(), createdBy: "seed",
  });
}

// A security lot: a (shared) instrument + a buy transaction + a current price.
async function seedSecurity(opts: {
  accountId: string; instrumentId: string; symbol: string; name: string;
  currency: string; units: number; buyPrice: number; curPrice: number;
}) {
  // Instrument may be shared across accounts; insert once (ignore dup).
  await db.insert(instruments).values({
    id: opts.instrumentId, symbol: opts.symbol, isin: null, name: opts.name,
    kind: "stock", currency: opts.currency, createdAt: nowEpoch(),
  }).onConflictDoNothing();
  await db.insert(prices).values({
    id: createId(), instrumentId: opts.instrumentId, date: "2026-06-01",
    priceScaled: Math.round(opts.curPrice * S), source: "manual", createdAt: nowEpoch(),
  }).onConflictDoNothing();
  await db.insert(transactions).values({
    id: createId(), accountId: opts.accountId, instrumentId: opts.instrumentId, date: "2026-01-01",
    unitsDelta: Math.round(opts.units * S), unitPriceScaled: Math.round(opts.buyPrice * S),
    feesMinor: 0, notes: null, createdAt: nowEpoch(), createdBy: "seed",
  });
}

test("GET /holdings rolls up the same instrument across two accounts", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const a1 = await makeAccount({ name: "Schwab", subtype: "investment", currency: "USD", userId: "seed" });
  const a2 = await makeAccount({ name: "IBKR", subtype: "investment", currency: "USD", userId: "seed" });
  const aapl = createId();
  await seedSecurity({ accountId: a1, instrumentId: aapl, symbol: "AAPL", name: "Apple", currency: "USD", units: 10, buyPrice: 100, curPrice: 150 });
  await seedSecurity({ accountId: a2, instrumentId: aapl, symbol: "AAPL", name: "Apple", currency: "USD", units: 5, buyPrice: 120, curPrice: 150 });

  const res = await app.handle(new Request("http://localhost/holdings", { headers: { cookie } }));
  expect(res.status).toBe(200);
  const h = await res.json();

  expect(h.securities.length).toBe(1);
  const row = h.securities[0];
  expect(row.symbol).toBe("AAPL");
  expect(row.accountCount).toBe(2);
  // 15 units @ 150 = 2250.00 -> 225000 minor
  expect(row.valueBaseMinor).toBe(225000);
  // gain: (150-100)*10 + (150-120)*5 = 500 + 150 = 650.00 -> 65000 minor
  expect(row.unrealizedGainBaseMinor).toBe(65000);
  expect(h.totalBaseMinor).toBe(225000);
});

test("GET /holdings counts cash only for cash/bank/investment subtypes", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const savings = await makeAccount({ name: "Savings", subtype: "bank", currency: "USD", userId: "seed" });
  await seedCash(savings, "USD", 1000); // counts
  const house = await makeAccount({ name: "House", subtype: "property", currency: "USD", userId: "seed" });
  await seedCash(house, "USD", 500000); // excluded (property)

  const res = await app.handle(new Request("http://localhost/holdings", { headers: { cookie } }));
  const h = await res.json();

  expect(h.securities.length).toBe(0);
  expect(h.cash.length).toBe(1);
  expect(h.cash[0].currency).toBe("USD");
  expect(h.cash[0].valueBaseMinor).toBe(100000); // 1000.00, house excluded
  expect(h.totalBaseMinor).toBe(100000);
});

test("GET /holdings?owner=<member> only includes that member's sole-owned accounts", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const mine = await makeAccount({ name: "Mine", subtype: "bank", currency: "USD", userId: "u1" });
  await db.insert(accountOwners).values({ accountId: mine, userId: "u1" });
  await seedCash(mine, "USD", 100);
  const joint = await makeAccount({ name: "Joint", subtype: "bank", currency: "USD", userId: "u1" });
  await db.insert(accountOwners).values([{ accountId: joint, userId: "u1" }, { accountId: joint, userId: "u2" }]);
  await seedCash(joint, "USD", 200);

  const res = await app.handle(new Request("http://localhost/holdings?owner=u1", { headers: { cookie } }));
  const h = await res.json();
  expect(h.cash[0].valueBaseMinor).toBe(10000); // only "Mine" (100.00)
});

test("GET /holdings returns 401 without auth", async () => {
  const res = await app.handle(new Request("http://localhost/holdings"));
  expect(res.status).toBe(401);
});
