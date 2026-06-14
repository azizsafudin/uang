import { expect, test, beforeEach } from "bun:test";
import { db } from "../db/client";
import { accounts, accountOwners, instruments, prices, transactions, fxRates, settings } from "../db/schema";
import { SCALE } from "@uang/shared";
import { createId, nowEpoch } from "./ids";
import { resetDb } from "./test-helpers";
import { netWorth, accountValueMinor, convertMinor } from "./valuation";

beforeEach(resetDb);

const S = Number(SCALE);

async function setBase(base: string) {
  await db.insert(settings).values({ id: 1, householdName: "H", baseCurrency: base, createdAt: nowEpoch() });
}

async function seedAccount(opts: { currency: string; cls?: "asset" | "liability"; owner?: string }): Promise<string> {
  const id = createId();
  await db.insert(accounts).values({
    id, name: "Acct", class: opts.cls ?? "asset", subtype: "bank", currency: opts.currency,
    isArchived: 0, sortOrder: 0, createdAt: nowEpoch(), createdBy: "u",
    growthRateBps: 0, accessibleFromAge: 0, earlyWithdrawal: "none",
    earlyHaircutBps: 0, illiquid: 0, liquidationAge: null,
  });
  if (opts.owner) await db.insert(accountOwners).values({ accountId: id, userId: opts.owner });
  return id;
}

async function addCurrencyInstrument(currency: string): Promise<string> {
  const id = createId();
  await db.insert(instruments).values({
    id, symbol: currency, isin: null, name: currency, kind: "currency", currency, createdAt: nowEpoch(),
  });
  return id;
}

async function cashTx(accountId: string, instrumentId: string, amountMajor: number, date = "2026-01-01") {
  await db.insert(transactions).values({
    id: createId(), accountId, instrumentId, date,
    unitsDelta: Math.round(amountMajor * S), unitPriceScaled: S,
    feesMinor: 0, notes: null, createdAt: nowEpoch(), createdBy: "u",
  });
}

async function addFx(currency: string, date: string, rateMajor: number) {
  await db.insert(fxRates).values({
    id: createId(), currency, date, rateScaled: Math.round(rateMajor * S), createdAt: nowEpoch(),
  });
}

test("convertMinor routes X->base->Y and returns null on a missing rate", async () => {
  await setBase("USD");
  await addFx("SGD", "2026-01-01", 0.74);
  // SGD -> USD
  expect(await convertMinor(10000, "SGD", "USD", "USD")).toBe(7400);
  // USD -> USD identity
  expect(await convertMinor(5000, "USD", "USD", "USD")).toBe(5000);
  // EUR has no rate -> null
  expect(await convertMinor(5000, "EUR", "USD", "USD")).toBe(null);
});

test("accountValueMinor sums cash positions in the target currency", async () => {
  await setBase("USD");
  const acc = await seedAccount({ currency: "USD" });
  const usd = await addCurrencyInstrument("USD");
  await cashTx(acc, usd, 1000);
  await cashTx(acc, usd, -250, "2026-02-01");
  const { valueMinor, missing } = await accountValueMinor(acc, "USD", "USD");
  expect(valueMinor).toBe(75000); // 750.00
  expect(missing).toBe(false);
});

test("netWorth converts a foreign-currency account to base", async () => {
  await setBase("USD");
  await addFx("SGD", "2026-01-01", 0.74);
  const acc = await seedAccount({ currency: "SGD" });
  const sgd = await addCurrencyInstrument("SGD");
  await cashTx(acc, sgd, 1000); // 1000 SGD

  const nw = await netWorth();
  expect(nw.baseCurrency).toBe("USD");
  expect(nw.accounts.length).toBe(1);
  expect(nw.accounts[0].currency).toBe("SGD");
  expect(nw.accounts[0].balanceMinor).toBe(100000); // 1000.00 SGD (account currency)
  expect(nw.accounts[0].baseMinor).toBe(74000);      // 740.00 USD
  expect(nw.totalBaseMinor).toBe(74000);
});

test("netWorth flags missingRate and excludes the account from the total", async () => {
  await setBase("USD");
  const acc = await seedAccount({ currency: "EUR" }); // no FX rate seeded
  const eur = await addCurrencyInstrument("EUR");
  await cashTx(acc, eur, 500);

  const nw = await netWorth();
  expect(nw.accounts[0].missingRate).toBe(true);
  expect(nw.totalBaseMinor).toBe(0);
});

test("netWorth owner filter shows only solely-owned accounts", async () => {
  await setBase("USD");
  const mine = await seedAccount({ currency: "USD", owner: "me" });
  const usd = await addCurrencyInstrument("USD");
  await cashTx(mine, usd, 100);
  const shared = await seedAccount({ currency: "USD" });
  await db.insert(accountOwners).values({ accountId: shared, userId: "me" });
  await db.insert(accountOwners).values({ accountId: shared, userId: "you" });
  await cashTx(shared, usd, 999);

  const nw = await netWorth({ owner: "me" });
  expect(nw.accounts.length).toBe(1);
  expect(nw.totalBaseMinor).toBe(10000);
});
