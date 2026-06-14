import { expect, test, beforeEach } from "bun:test";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { networthSeriesRoutes } from "./networth-series";
import { db } from "../db/client";
import { accounts, instruments, transactions } from "../db/schema";
import { SCALE } from "@uang/shared";
import { createId, nowEpoch } from "../lib/ids";

beforeEach(resetDb);

const app = makeApp(networthSeriesRoutes);

const S = Number(SCALE);

async function seedAccount(amountMinor: number, date: string) {
  const id = createId();
  await db.insert(accounts).values({
    id, name: "Checking", class: "asset", subtype: "bank", currency: "USD",
    isArchived: 0, sortOrder: 0,
    createdAt: nowEpoch(), createdBy: "seed",
  });
  const instrId = createId();
  await db.insert(instruments).values({
    id: instrId, symbol: "USD", isin: null, name: "USD", kind: "currency", currency: "USD", createdAt: nowEpoch(),
  });
  await db.insert(transactions).values({
    id: createId(), accountId: id, instrumentId: instrId, date,
    unitsDelta: Math.round((amountMinor / 100) * S), unitPriceScaled: S, feesMinor: 0, notes: null,
    createdAt: nowEpoch(), createdBy: "seed",
  });
  return id;
}

test("GET /networth/series returns ascending weekly points", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  await seedAccount(100000, "2026-01-01");

  const res = await app.handle(
    new Request("http://localhost/networth/series?from=2026-01-01&to=2026-01-15", { headers: { cookie } }),
  );
  expect(res.status).toBe(200);

  const series = await res.json();
  expect(series.baseCurrency).toBe("USD");
  expect(series.points.map((p: any) => p.date)).toEqual(["2026-01-01", "2026-01-08", "2026-01-15"]);
  expect(series.points.every((p: any) => p.totalBaseMinor === 100000)).toBe(true);
});

test("GET /networth/series requires `from` (422 when missing)", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const res = await app.handle(new Request("http://localhost/networth/series", { headers: { cookie } }));
  expect(res.status).toBe(422);
});

test("GET /networth/series returns 401 without auth", async () => {
  const res = await app.handle(new Request("http://localhost/networth/series?from=2026-01-01"));
  expect(res.status).toBe(401);
});
