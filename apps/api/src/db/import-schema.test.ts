import { expect, test, beforeEach } from "bun:test";
import { db } from "./client";
import { importParsers, importBatches, importRows } from "./schema";
import { resetDb } from "../lib/test-helpers";
import { createId, nowEpoch } from "../lib/ids";

beforeEach(resetDb);

test("import tables accept rows and round-trip", async () => {
  const parserId = createId();
  await db.insert(importParsers).values({
    id: parserId, name: "DBS Statement Parser", sourceFormat: "csv",
    config: JSON.stringify({ version: 1, format: "csv" }),
    fingerprint: JSON.stringify({ format: "csv", headerColumns: ["amount", "date"] }),
    origin: "manual", createdAt: nowEpoch(), createdBy: "u",
  });
  const batchId = createId();
  await db.insert(importBatches).values({
    id: batchId, parserId, accountId: "acc1", filename: "feb.csv",
    fileHash: "abc", status: "review", rowCountNew: 1, rowCountDuplicate: 0,
    rowCountError: 0, createdAt: nowEpoch(), createdBy: "u",
  });
  await db.insert(importRows).values({
    id: createId(), batchId, raw: JSON.stringify({ Date: "01 Feb 2026" }),
    date: "2026-02-01", amountMinor: -1234, description: "COFFEE",
    category: null, dedupHash: "h1", status: "new", errorReason: null,
    matchedTxnId: null, committedTxnId: null,
  });

  const parsers = await db.select().from(importParsers);
  const batches = await db.select().from(importBatches);
  const rows = await db.select().from(importRows);
  expect(parsers.length).toBe(1);
  expect(batches[0].status).toBe("review");
  expect(rows[0].amountMinor).toBe(-1234);
});
