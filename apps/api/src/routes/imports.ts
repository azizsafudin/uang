import { Elysia, t } from "elysia";
import { createHash } from "node:crypto";
import { db } from "../db/client";
import { accounts, importParsers, importBatches, importRows, transactions } from "../db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { authGuard } from "../lib/auth-guard";
import { createId, nowEpoch } from "../lib/ids";
import { ensureCurrencyInstrument } from "../lib/instruments";
import { parseCsv } from "../lib/import/csv";
import { fingerprintCsv, matchParsers } from "../lib/import/detect";
import { dedupHash } from "../lib/import/dedup";
import { unitsDeltaToAmountMinor, amountMinorToUnitsDelta } from "../lib/import/amount";
import { validateParserConfig, validateFingerprint } from "../lib/import/validate";
import type { CsvFingerprint } from "../lib/import/types";
import { SCALE } from "@uang/shared";

const fileHashOf = (s: string) => createHash("sha256").update(s).digest("hex");

export const importsRoutes = new Elysia()
  .use(authGuard)
  // ---- detect: rank saved parsers against an uploaded file ----
  .post(
    "/imports/detect",
    async ({ body }: any) => {
      const fp = fingerprintCsv(body.content, ",");
      const parsers = await db.select().from(importParsers).where(eq(importParsers.sourceFormat, "csv"));
      const valid: { id: string; name: string; fingerprint: CsvFingerprint }[] = [];
      for (const p of parsers) {
        try {
          const fpv = validateFingerprint(JSON.parse(p.fingerprint));
          if (fpv.format === "csv") valid.push({ id: p.id, name: p.name, fingerprint: fpv });
        } catch {
          // skip parsers whose stored fingerprint is malformed rather than crash detect
        }
      }
      const candidates = matchParsers(fp, valid);
      return { fingerprint: fp, candidates };
    },
    { body: t.Object({ filename: t.String(), content: t.String() }) },
  )
  // ---- parse a file into a staged batch ----
  .post(
    "/accounts/:id/imports",
    async ({ params, body, userId, set }: any) => {
      const [account] = await db.select().from(accounts).where(eq(accounts.id, params.id));
      if (!account) { set.status = 404; return { error: "unknown_account" }; }
      const [parser] = await db.select().from(importParsers).where(eq(importParsers.id, body.parserId));
      if (!parser) { set.status = 422; return { error: "unknown_parser" }; }

      const config = validateParserConfig(JSON.parse(parser.config));
      if (config.format !== "csv") { set.status = 422; return { error: "unsupported_format" }; }
      const canonical = parseCsv(body.content, config, account.currency);

      // Build the set of dedup hashes for already-committed cash transactions.
      const cashInstrumentId = await ensureCurrencyInstrument(account.currency);
      const existing = await db.select().from(transactions)
        .where(and(eq(transactions.accountId, params.id), eq(transactions.instrumentId, cashInstrumentId)));
      const seen = new Set<string>();
      for (const txn of existing) {
        const amountMinor = unitsDeltaToAmountMinor(txn.unitsDelta, account.currency);
        seen.add(dedupHash(params.id, { date: txn.date, amountMinor, description: txn.notes ?? "" }));
      }

      const batchId = createId();
      const now = nowEpoch();
      let nNew = 0, nDup = 0, nErr = 0;
      const rowValues = canonical.map((row) => {
        let status: "new" | "duplicate" | "error";
        let hash = "";
        if (row.error || row.date === null || row.amountMinor === null) {
          status = "error"; nErr++;
        } else {
          hash = dedupHash(params.id, { date: row.date, amountMinor: row.amountMinor, description: row.description });
          if (seen.has(hash)) { status = "duplicate"; nDup++; }
          else { seen.add(hash); status = "new"; nNew++; }
        }
        return {
          id: createId(), batchId, raw: JSON.stringify(row.raw),
          date: row.date, amountMinor: row.amountMinor, description: row.description,
          category: null, dedupHash: hash, status, errorReason: row.error ?? null,
          matchedTxnId: null, committedTxnId: null,
        };
      });

      await db.insert(importBatches).values({
        id: batchId, parserId: parser.id, accountId: params.id, filename: body.filename,
        fileHash: fileHashOf(body.content), status: "review",
        rowCountNew: nNew, rowCountDuplicate: nDup, rowCountError: nErr,
        createdAt: now, createdBy: userId!,
      });
      if (rowValues.length > 0) await db.insert(importRows).values(rowValues);

      const rows = await db.select().from(importRows).where(eq(importRows.batchId, batchId));
      return { id: batchId, accountId: params.id, filename: body.filename,
        status: "review", rowCountNew: nNew, rowCountDuplicate: nDup, rowCountError: nErr, rows };
    },
    { body: t.Object({ filename: t.String(), content: t.String(), parserId: t.String() }) },
  )
  // ---- get batch + rows ----
  .get("/imports/:id", async ({ params, set }: any) => {
    const [batch] = await db.select().from(importBatches).where(eq(importBatches.id, params.id));
    if (!batch) { set.status = 404; return { error: "unknown_batch" }; }
    const rows = await db.select().from(importRows).where(eq(importRows.batchId, params.id));
    return { ...batch, rows };
  })
  // ---- edit a staged row ----
  .patch(
    "/import-rows/:id",
    async ({ params, body }: any) => {
      const update: Record<string, unknown> = {};
      if (body.status !== undefined) update.status = body.status;
      if (body.date !== undefined) update.date = body.date;
      if (body.amountMinor !== undefined) update.amountMinor = body.amountMinor;
      if (body.description !== undefined) update.description = body.description;
      await db.update(importRows).set(update).where(eq(importRows.id, params.id));
      return { ok: true };
    },
    {
      body: t.Object({
        status: t.Optional(t.Union([t.Literal("new"), t.Literal("duplicate"), t.Literal("excluded"), t.Literal("error")])),
        date: t.Optional(t.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
        amountMinor: t.Optional(t.Number()),
        description: t.Optional(t.String()),
      }),
    },
  )
  // ---- commit staged rows to transactions ----
  .post("/imports/:id/commit", async ({ params, userId, set }: any) => {
    const [batch] = await db.select().from(importBatches).where(eq(importBatches.id, params.id));
    if (!batch) { set.status = 404; return { error: "unknown_batch" }; }
    if (batch.status === "committed") { set.status = 409; return { error: "already_committed" }; }
    const [account] = await db.select().from(accounts).where(eq(accounts.id, batch.accountId));
    if (!account) { set.status = 404; return { error: "unknown_account" }; }

    const cashInstrumentId = await ensureCurrencyInstrument(account.currency);
    const rows = await db.select().from(importRows)
      .where(and(eq(importRows.batchId, params.id), eq(importRows.status, "new"), isNull(importRows.committedTxnId)));

    const now = nowEpoch();
    let committed = 0;
    for (const row of rows) {
      if (row.date === null || row.amountMinor === null) continue;
      const txnId = createId();
      await db.insert(transactions).values({
        id: txnId, accountId: batch.accountId, instrumentId: cashInstrumentId,
        date: row.date, unitsDelta: amountMinorToUnitsDelta(row.amountMinor, account.currency),
        unitPriceScaled: Number(SCALE), feesMinor: 0, notes: row.description,
        importBatchId: batch.id, createdAt: now, createdBy: userId!,
      });
      await db.update(importRows).set({ committedTxnId: txnId }).where(eq(importRows.id, row.id));
      committed++;
    }
    await db.update(importBatches).set({ status: "committed" }).where(eq(importBatches.id, params.id));
    return { committed };
  })
  // ---- discard batch + rows ----
  .delete("/imports/:id", async ({ params }) => {
    await db.delete(importRows).where(eq(importRows.batchId, params.id));
    await db.delete(importBatches).where(eq(importBatches.id, params.id));
    return { ok: true };
  });
