import { expect, test, beforeEach } from "bun:test";
import { SCALE } from "@uang/shared";
import { db } from "../db/client";
import { accounts, importParsers, importBatches, importRows, transactions } from "../db/schema";
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

test("GET batch returns batch + rows; PATCH row edits and toggles status", async () => {
  const { cookie } = await initAndLogin({ app });
  const acc = await seedAccount();
  const parserId = await seedParser(cookie);
  const created = await (await app.handle(new Request(`http://localhost/accounts/${acc}/imports`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ filename: "feb.csv", content: CSV, parserId }),
  }))).json();

  const got = await (await app.handle(new Request(`http://localhost/imports/${created.id}`, { headers: { cookie } }))).json();
  expect(got.rows.length).toBe(2);

  const rowId = got.rows[0].id;
  const patched = await app.handle(new Request(`http://localhost/import-rows/${rowId}`, {
    method: "PATCH", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ status: "excluded", description: "edited" }),
  }));
  expect(patched.status).toBe(200);
  const after = await db.select().from(importRows).where(eq(importRows.id, rowId));
  expect(after[0].status).toBe("excluded");
  expect(after[0].description).toBe("edited");
});

const S = Number(SCALE);

test("commit inserts only 'new' rows as cash transactions and marks the batch committed", async () => {
  const { cookie } = await initAndLogin({ app });
  const acc = await seedAccount();
  const parserId = await seedParser(cookie);
  const created = await (await app.handle(new Request(`http://localhost/accounts/${acc}/imports`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ filename: "feb.csv", content: CSV, parserId }),
  }))).json();

  // exclude the COFFEE row; only SALARY should commit
  const coffee = created.rows.find((r: any) => r.description === "COFFEE");
  await app.handle(new Request(`http://localhost/import-rows/${coffee.id}`, {
    method: "PATCH", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ status: "excluded" }),
  }));

  const res = await app.handle(new Request(`http://localhost/imports/${created.id}/commit`, {
    method: "POST", headers: { cookie },
  }));
  expect(res.status).toBe(200);
  const result = await res.json();
  expect(result.committed).toBe(1);

  const txns = await db.select().from(transactions).where(eq(transactions.accountId, acc));
  expect(txns.length).toBe(1);
  expect(txns[0].unitsDelta).toBe(2500 * S);     // +$2500 salary
  expect(txns[0].notes).toBe("SALARY");
  expect(txns[0].importBatchId).toBe(created.id);

  const [batch] = await db.select().from(importBatches).where(eq(importBatches.id, created.id));
  expect(batch.status).toBe("committed");
});

test("commit is idempotent: re-running does not double-insert transactions", async () => {
  const { cookie } = await initAndLogin({ app });
  const acc = await seedAccount();
  const parserId = await seedParser(cookie);
  const created = await (await app.handle(new Request(`http://localhost/accounts/${acc}/imports`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ filename: "feb.csv", content: CSV, parserId }),
  }))).json();

  await app.handle(new Request(`http://localhost/imports/${created.id}/commit`, { method: "POST", headers: { cookie } }));
  const firstCount = (await db.select().from(transactions).where(eq(transactions.accountId, acc))).length;
  expect(firstCount).toBe(2);

  // force a re-run by resetting the batch status back to "review"
  await db.update(importBatches).set({ status: "review" }).where(eq(importBatches.id, created.id));
  const res2 = await app.handle(new Request(`http://localhost/imports/${created.id}/commit`, { method: "POST", headers: { cookie } }));
  expect(res2.status).toBe(200);
  expect((await res2.json()).committed).toBe(0);

  const secondCount = (await db.select().from(transactions).where(eq(transactions.accountId, acc))).length;
  expect(secondCount).toBe(firstCount); // no new transactions
});

test("PATCH /import-rows rejects a malformed date with 422", async () => {
  const { cookie } = await initAndLogin({ app });
  const acc = await seedAccount();
  const parserId = await seedParser(cookie);
  const created = await (await app.handle(new Request(`http://localhost/accounts/${acc}/imports`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ filename: "feb.csv", content: CSV, parserId }),
  }))).json();
  const rowId = created.rows[0].id;
  const res = await app.handle(new Request(`http://localhost/import-rows/${rowId}`, {
    method: "PATCH", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ date: "not-a-date" }),
  }));
  expect(res.status).toBe(422);
});

test("committed rows dedup against a second import", async () => {
  const { cookie } = await initAndLogin({ app });
  const acc = await seedAccount();
  const parserId = await seedParser(cookie);
  const first = await (await app.handle(new Request(`http://localhost/accounts/${acc}/imports`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ filename: "feb.csv", content: CSV, parserId }),
  }))).json();
  await app.handle(new Request(`http://localhost/imports/${first.id}/commit`, { method: "POST", headers: { cookie } }));

  const second = await (await app.handle(new Request(`http://localhost/accounts/${acc}/imports`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ filename: "feb-again.csv", content: CSV, parserId }),
  }))).json();
  expect(second.rowCountDuplicate).toBe(2);
  expect(second.rowCountNew).toBe(0);
});

test("discard deletes the batch and its rows", async () => {
  const { cookie } = await initAndLogin({ app });
  const acc = await seedAccount();
  const parserId = await seedParser(cookie);
  const created = await (await app.handle(new Request(`http://localhost/accounts/${acc}/imports`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ filename: "feb.csv", content: CSV, parserId }),
  }))).json();
  const res = await app.handle(new Request(`http://localhost/imports/${created.id}`, { method: "DELETE", headers: { cookie } }));
  expect(res.status).toBe(200);
  const rows = await db.select().from(importRows).where(eq(importRows.batchId, created.id));
  expect(rows.length).toBe(0);
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

// ---- PDF extract + staging tests ----

import { readFileSync } from "node:fs";
import { join } from "node:path";

const PDF_PARSER = {
  version: 1, format: "pdf",
  region: { startAfter: "Transaction Details", stopAt: "Closing Balance" },
  transactionLine: "^(?<date>\\d{2}/\\d{2}/\\d{4})\\s+(?<description>.+?)\\s+(?<amount>-?[\\d,]+\\.\\d{2})$",
  date: { format: "DD/MM/YYYY" },
  amount: { decimal: ".", thousands: ",", sign: "negativeIsDebit" },
};
const PDF_FP = { format: "pdf", markers: ["dbs bank statement of account", "transaction details"] };
const samplePdfB64 = () =>
  readFileSync(join(import.meta.dir, "../lib/import/fixtures/sample-statement.pdf")).toString("base64");

test("POST /imports/extract returns text + fingerprint + candidates for a PDF", async () => {
  const { cookie } = await initAndLogin({ app });
  const res = await app.handle(new Request("http://localhost/imports/extract", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ filename: "stmt.pdf", file: samplePdfB64() }),
  }));
  expect(res.status).toBe(200);
  const out = await res.json();
  expect(out.text).toContain("COFFEE BEAN");
  expect(out.fingerprint.format).toBe("pdf");
  expect(Array.isArray(out.candidates)).toBe(true);
});

test("POST /imports/extract returns 422 pdf_no_text for an empty PDF", async () => {
  const { cookie } = await initAndLogin({ app });
  const emptyB64 = readFileSync(join(import.meta.dir, "../lib/import/fixtures/sample-empty.pdf")).toString("base64");
  const res = await app.handle(new Request("http://localhost/imports/extract", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ filename: "x.pdf", file: emptyB64 }),
  }));
  expect(res.status).toBe(422);
  expect((await res.json()).error).toBe("pdf_no_text");
});

test("POST /accounts/:id/imports stages rows from extracted PDF text via a pdf parser", async () => {
  const { cookie } = await initAndLogin({ app });
  // 1) create an account using the same seedAccount helper as all other tests
  const accountId = await seedAccount();
  // 2) extract text from the fixture PDF
  const ex = await app.handle(new Request("http://localhost/imports/extract", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ filename: "stmt.pdf", file: samplePdfB64() }),
  }));
  const text = (await ex.json()).text;
  // 3) save a pdf parser
  await app.handle(new Request("http://localhost/import-parsers", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ id: "pdfp", name: "DBS PDF", sourceFormat: "pdf", config: PDF_PARSER, fingerprint: PDF_FP, origin: "ai" }),
  }));
  // 4) stage the extracted text through the pdf parser
  const res = await app.handle(new Request(`http://localhost/accounts/${accountId}/imports`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ filename: "stmt.pdf", content: text, parserId: "pdfp" }),
  }));
  expect(res.status).toBe(200);
  const out = await res.json();
  expect(out.rowCountNew).toBe(2);
});
