import { expect, test, beforeEach } from "bun:test";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { entriesRoutes } from "./entries";
import { db } from "../db/client";
import { accounts } from "../db/schema";
import { createId, nowEpoch } from "../lib/ids";
import { accountBalanceMinor } from "../lib/valuation";

beforeEach(resetDb);

const app = makeApp(entriesRoutes);

// Seed a bare account row directly via Drizzle (no dependency on the accounts route).
async function seedAccount(currency = "USD"): Promise<string> {
  const acctId = createId();
  await db.insert(accounts).values({
    id: acctId,
    name: "Acct",
    class: "asset",
    subtype: "bank",
    currency,
    valuationMode: "ledger",
    isArchived: 0,
    sortOrder: 0,
    createdAt: nowEpoch(),
    createdBy: "u",
  });
  return acctId;
}

test("set-balance inserts an adjustment equal to the delta", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const acctId = await seedAccount();

  // No entries yet → balance is 0; set-balance to 123456 on a date
  const res = await app.handle(
    new Request(`http://localhost/accounts/${acctId}/set-balance`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ targetMinor: 123456, date: "2026-02-01" }),
    }),
  );
  expect(res.status).toBe(200);

  // Balance should now equal the target
  const balance1 = await accountBalanceMinor(acctId);
  expect(balance1).toBe(123456);

  // Set to a lower number — a second adjustment should bring it exactly there
  const res2 = await app.handle(
    new Request(`http://localhost/accounts/${acctId}/set-balance`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ targetMinor: 100000, date: "2026-03-01" }),
    }),
  );
  expect(res2.status).toBe(200);

  const balance2 = await accountBalanceMinor(acctId);
  expect(balance2).toBe(100000);
});

test("entries can be listed and deleted (delete reverts balance)", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const acctId = await seedAccount();

  // Insert one adjustment entry via set-balance
  await app.handle(
    new Request(`http://localhost/accounts/${acctId}/set-balance`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ targetMinor: 5000, date: "2026-01-01" }),
    }),
  );

  // List entries — should have exactly 1
  const listRes = await app.handle(
    new Request(`http://localhost/accounts/${acctId}/entries`, {
      headers: { cookie },
    }),
  );
  expect(listRes.status).toBe(200);
  const listed = await listRes.json();
  expect(listed.length).toBe(1);
  expect(listed[0].amountMinor).toBe(5000);
  expect(listed[0].kind).toBe("adjustment");

  // Delete that entry
  const delRes = await app.handle(
    new Request(`http://localhost/entries/${listed[0].id}`, {
      method: "DELETE",
      headers: { cookie },
    }),
  );
  expect(delRes.status).toBe(200);

  // Entry list is now empty
  const afterRes = await app.handle(
    new Request(`http://localhost/accounts/${acctId}/entries`, {
      headers: { cookie },
    }),
  );
  const after = await afterRes.json();
  expect(after.length).toBe(0);

  // Balance has reverted to 0
  const balanceAfter = await accountBalanceMinor(acctId);
  expect(balanceAfter).toBe(0);
});

test("revalue inserts an entry of kind revaluation", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const acctId = await seedAccount("EUR");

  // Set an initial balance via raw entry (kind: opening)
  await app.handle(
    new Request(`http://localhost/accounts/${acctId}/entries`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ amountMinor: 20000, date: "2026-01-01", kind: "opening" }),
    }),
  );

  // Now revalue to 25000
  const res = await app.handle(
    new Request(`http://localhost/accounts/${acctId}/revalue`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ newValueMinor: 25000, date: "2026-03-01" }),
    }),
  );
  expect(res.status).toBe(200);

  const balance = await accountBalanceMinor(acctId);
  expect(balance).toBe(25000);

  // The revalue entry should be kind = "revaluation"
  const listRes = await app.handle(
    new Request(`http://localhost/accounts/${acctId}/entries`, {
      headers: { cookie },
    }),
  );
  const listed = await listRes.json();
  const revalEntry = listed.find((e: any) => e.kind === "revaluation");
  expect(revalEntry).toBeTruthy();
  expect(revalEntry.amountMinor).toBe(5000); // delta = 25000 - 20000
});

test("raw entry POST inserts a transaction entry", async () => {
  const { cookie } = await initAndLogin({ app, baseCurrency: "USD" });
  const acctId = await seedAccount();

  const res = await app.handle(
    new Request(`http://localhost/accounts/${acctId}/entries`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ amountMinor: -1500, date: "2026-04-15" }),
    }),
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(typeof body.id).toBe("string");

  const balance = await accountBalanceMinor(acctId);
  expect(balance).toBe(-1500);
});

test("unauthenticated requests are rejected with 401", async () => {
  const acctId = createId(); // doesn't need to exist
  const res = await app.handle(
    new Request(`http://localhost/accounts/${acctId}/entries`),
  );
  expect(res.status).toBe(401);
});
