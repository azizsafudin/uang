import { expect, test, beforeEach } from "bun:test";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { networthRoutes } from "./networth";
import { db } from "../db/client";
import { accounts, entries } from "../db/schema";
import { createId, nowEpoch } from "../lib/ids";

beforeEach(resetDb);

const app = makeApp(networthRoutes);

// Seed an account + an opening entry directly via Drizzle (no dependency on accounts route).
async function seedAccount(opts: {
  name: string;
  cls: "asset" | "liability";
  currency: string;
  amountMinor: number;
  date: string;
  userId: string;
}) {
  const id = createId();
  await db.insert(accounts).values({
    id,
    name: opts.name,
    class: opts.cls,
    subtype: "bank",
    currency: opts.currency,
    valuationMode: "ledger",
    isArchived: 0,
    sortOrder: 0,
    createdAt: nowEpoch(),
    createdBy: opts.userId,
  });
  await db.insert(entries).values({
    id: createId(),
    accountId: id,
    date: opts.date,
    amountMinor: opts.amountMinor,
    kind: "opening",
    createdAt: nowEpoch(),
    createdBy: opts.userId,
  });
  return id;
}

test("GET /networth returns headline and per-account breakdown (assets minus liabilities)", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });

  // Seed asset: $1,000.00 (100000 minor) and liability: -$250.00 (-25000 minor)
  // Net worth = 100000 + (-25000) = 75000 minor
  await seedAccount({ name: "Checking", cls: "asset", currency: "USD", amountMinor: 100000, date: "2026-01-01", userId: "seed" });
  await seedAccount({ name: "Card", cls: "liability", currency: "USD", amountMinor: -25000, date: "2026-01-01", userId: "seed" });

  const res = await app.handle(new Request("http://localhost/networth", { headers: { cookie } }));
  expect(res.status).toBe(200);

  const nw = await res.json();
  expect(nw.baseCurrency).toBe("USD");
  expect(nw.totalBaseMinor).toBe(75000);
  expect(nw.accounts.length).toBe(2);

  // Each account should have the expected fields
  const checking = nw.accounts.find((a: any) => a.name === "Checking");
  expect(checking).toBeDefined();
  expect(checking.balanceMinor).toBe(100000);
  expect(checking.baseMinor).toBe(100000);
  expect(checking.missingRate).toBe(false);
  expect(checking.class).toBe("asset");

  const card = nw.accounts.find((a: any) => a.name === "Card");
  expect(card).toBeDefined();
  expect(card.balanceMinor).toBe(-25000);
  expect(card.baseMinor).toBe(-25000);
  expect(card.missingRate).toBe(false);
  expect(card.class).toBe("liability");
});

test("GET /networth supports optional ?asOf=YYYY-MM-DD query", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });

  await seedAccount({ name: "Savings", cls: "asset", currency: "USD", amountMinor: 50000, date: "2026-03-01", userId: "seed" });

  // asOf before the entry date -> balance should be 0
  const resBefore = await app.handle(new Request("http://localhost/networth?asOf=2026-02-01", { headers: { cookie } }));
  expect(resBefore.status).toBe(200);
  const nwBefore = await resBefore.json();
  expect(nwBefore.totalBaseMinor).toBe(0);

  // asOf on entry date -> balance should be 50000
  const resOn = await app.handle(new Request("http://localhost/networth?asOf=2026-03-01", { headers: { cookie } }));
  expect(resOn.status).toBe(200);
  const nwOn = await resOn.json();
  expect(nwOn.totalBaseMinor).toBe(50000);
});

test("GET /networth returns 401 without auth", async () => {
  const res = await app.handle(new Request("http://localhost/networth"));
  expect(res.status).toBe(401);
});
