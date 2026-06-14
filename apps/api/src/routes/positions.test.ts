import { expect, test, beforeEach } from "bun:test";
import { db } from "../db/client";
import { accounts, instruments, prices, transactions } from "../db/schema";
import { SCALE } from "@uang/shared";
import { createId, nowEpoch } from "../lib/ids";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { positionsRoutes } from "./positions";

beforeEach(resetDb);
const app = makeApp(positionsRoutes);
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

test("GET /accounts/:id/positions returns positions and account total", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const acc = await seedAccount("USD");
  const aapl = createId();
  await db.insert(instruments).values({ id: aapl, symbol: "AAPL", isin: null, name: "Apple", kind: "stock", currency: "USD", createdAt: nowEpoch() });
  await db.insert(transactions).values({ id: createId(), accountId: acc, instrumentId: aapl, date: "2026-01-01", unitsDelta: 10 * S, unitPriceScaled: 100 * S, feesMinor: 0, notes: null, createdAt: nowEpoch(), createdBy: "u" });
  await db.insert(prices).values({ id: createId(), instrumentId: aapl, date: "2026-02-01", priceScaled: 120 * S, source: "manual", createdAt: nowEpoch() });

  const res = await app.handle(new Request(`http://localhost/accounts/${acc}/positions`, { headers: { cookie } }));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.accountCurrency).toBe("USD");
  expect(body.totalMinor).toBe(120000); // 10 × 120 = 1200.00
  expect(body.positions.length).toBe(1);
  expect(body.positions[0].valueDisplayMinor).toBe(120000);
  expect(body.positions[0].unrealizedGainMinor).toBe(20000); // (120-100)×10
});
