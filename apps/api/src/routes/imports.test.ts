import { expect, test, beforeEach } from "bun:test";
import { db } from "../db/client";
import { accounts, importParsers, importBatches, importRows } from "../db/schema";
import { eq } from "drizzle-orm";
import { resetDb, makeApp, initAndLogin } from "../lib/test-helpers";
import { createId, nowEpoch } from "../lib/ids";
import { importParsersRoutes } from "./import-parsers";
import { importsRoutes } from "./imports";

beforeEach(resetDb);
const app = makeApp(importParsersRoutes, importsRoutes);

const config = {
  version: 1, format: "csv", csv: { delimiter: ",", headerRow: 0, skipRows: 0 },
  fields: {
    date: { column: "Date", format: "YYYY-MM-DD" },
    description: { column: "Description" },
    amount: { mode: "single", column: "Amount", decimal: ".", thousands: ",", sign: "negativeIsDebit" },
  },
};
const fingerprint = { format: "csv", delimiter: ",", headerColumns: ["amount", "date", "description"] };
const CSV = "Date,Description,Amount\n2026-02-01,COFFEE,-4.50\n2026-02-02,SALARY,2500.00";

async function seedAccount(currency = "USD") {
  const id = createId();
  await db.insert(accounts).values({
    id, name: "Checking", class: "asset", subtype: "cash", currency,
    isArchived: 0, sortOrder: 0, createdAt: nowEpoch(), createdBy: "u",
    growthRateBps: 0, accessibleFromAge: 0, earlyWithdrawal: "none",
    earlyHaircutBps: 0, illiquid: 0, liquidationAge: null,
  });
  return id;
}
async function seedParser(cookie: string) {
  const res = await app.handle(new Request("http://localhost/import-parsers", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Test CSV", sourceFormat: "csv", config, fingerprint }),
  }));
  return (await res.json()).id as string;
}

test("detect suggests a matching parser", async () => {
  const { cookie } = await initAndLogin({ app });
  await seedParser(cookie);
  const res = await app.handle(new Request("http://localhost/imports/detect", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ filename: "feb.csv", content: CSV }),
  }));
  const { candidates } = await res.json();
  expect(candidates[0].confident).toBe(true);
});

test("parse stages rows with dedup status and counts", async () => {
  const { cookie } = await initAndLogin({ app });
  const acc = await seedAccount();
  const parserId = await seedParser(cookie);

  const res = await app.handle(new Request(`http://localhost/accounts/${acc}/imports`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ filename: "feb.csv", content: CSV, parserId }),
  }));
  expect(res.status).toBe(200);
  const batch = await res.json();
  expect(batch.rowCountNew).toBe(2);
  expect(batch.rows.length).toBe(2);
  expect(batch.rows.find((r: any) => r.description === "COFFEE").amountMinor).toBe(-450);

  // re-import the same file -> all duplicates (against the prior staged? no — against committed.
  // Here nothing committed yet, so still "new". Within-batch dup is covered below.)
  const dupCsv = "Date,Description,Amount\n2026-02-01,COFFEE,-4.50\n2026-02-01,COFFEE,-4.50";
  const res2 = await app.handle(new Request(`http://localhost/accounts/${acc}/imports`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ filename: "dup.csv", content: dupCsv, parserId }),
  }));
  const batch2 = await res2.json();
  expect(batch2.rowCountNew).toBe(1);
  expect(batch2.rowCountDuplicate).toBe(1); // second identical row flagged within-batch
});
