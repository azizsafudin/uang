import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { transactions, instruments } from "../db/schema";
import { eq, desc } from "drizzle-orm";
import { SCALE } from "@uang/shared";
import { authGuard } from "../lib/auth-guard";
import { createId, nowEpoch } from "../lib/ids";
import { isUniqueViolation } from "../lib/db-errors";
import { seedTradePrice } from "../lib/trade-prices";

const CASH_PRICE = Number(SCALE); // currency instruments are priced at 1.0

export const transactionsRoutes = new Elysia()
  .use(authGuard)
  .get("/accounts/:id/transactions", async ({ params }) => {
    const rows = await db
      .select()
      .from(transactions)
      .innerJoin(instruments, eq(transactions.instrumentId, instruments.id))
      .where(eq(transactions.accountId, params.id))
      .orderBy(desc(transactions.date));
    return rows.map((r) => ({
      ...r.transactions,
      instrument: {
        id: r.instruments.id, symbol: r.instruments.symbol, name: r.instruments.name,
        kind: r.instruments.kind, currency: r.instruments.currency,
      },
    }));
  })
  .post(
    "/accounts/:id/transactions",
    async ({ params, body, userId, set }: any) => {
      const instr = await db.select({ id: instruments.id, kind: instruments.kind }).from(instruments).where(eq(instruments.id, body.instrumentId));
      if (instr.length === 0) { set.status = 422; return { error: "unknown_instrument" }; }

      const now = nowEpoch();
      const mainId = body.id ?? createId();
      try {
        // NOTE: libsql Drizzle driver's interactive `db.transaction(async (tx) => …)`
        // surfaces spurious "no such table" errors here (concurrent connections lose
        // the schema view), so we fall back to two sequential `db.insert` calls. This
        // is acceptable for this WIP, single-user app. See plan Task 8 note.
        if (body.cashLeg) {
          const cl = body.cashLeg;
          const cinstr = await db.select({ id: instruments.id }).from(instruments).where(eq(instruments.id, cl.instrumentId));
          if (cinstr.length === 0) { set.status = 422; return { error: "unknown_cash_instrument" }; }
          await db.insert(transactions).values({
            id: mainId, accountId: params.id, instrumentId: body.instrumentId,
            date: body.date, unitsDelta: body.unitsDelta,
            unitPriceScaled: body.unitPriceScaled ?? null, feesMinor: body.feesMinor ?? 0,
            notes: body.notes ?? null, createdAt: now, createdBy: userId!,
          });
          await db.insert(transactions).values({
            id: createId(), accountId: params.id, instrumentId: cl.instrumentId,
            date: body.date, unitsDelta: cl.unitsDelta,
            unitPriceScaled: cl.unitPriceScaled ?? CASH_PRICE, feesMinor: 0,
            notes: cl.notes ?? null, linkedTransactionId: mainId, createdAt: now, createdBy: userId!,
          });
        } else {
          await db.insert(transactions).values({
            id: mainId, accountId: params.id, instrumentId: body.instrumentId,
            date: body.date, unitsDelta: body.unitsDelta,
            unitPriceScaled: body.unitPriceScaled ?? null, feesMinor: body.feesMinor ?? 0,
            notes: body.notes ?? null, createdAt: now, createdBy: userId!,
          });
        }
      } catch (e) {
        if (isUniqueViolation(e)) { set.status = 409; return { error: "duplicate_id" }; }
        if (e instanceof Error && e.message === "unknown_cash_instrument") {
          set.status = 422; return { error: "unknown_cash_instrument" };
        }
        throw e;
      }
      if (instr[0].kind !== "currency" && body.unitPriceScaled != null) {
        await seedTradePrice(body.instrumentId, body.date, body.unitPriceScaled);
      }
      return { id: mainId };
    },
    {
      body: t.Object({
        id: t.Optional(t.String()),
        instrumentId: t.String(),
        date: t.String(),
        unitsDelta: t.Number(),
        unitPriceScaled: t.Optional(t.Number()),
        feesMinor: t.Optional(t.Number()),
        notes: t.Optional(t.String()),
        cashLeg: t.Optional(t.Object({
          instrumentId: t.String(),
          unitsDelta: t.Number(),
          unitPriceScaled: t.Optional(t.Number()),
          notes: t.Optional(t.String()),
        })),
      }),
    },
  )
  .patch(
    "/transactions/:id",
    async ({ params, body }: any) => {
      const [tx] = await db.select().from(transactions).where(eq(transactions.id, params.id));
      const update: Record<string, unknown> = {};
      if (body.date !== undefined) update.date = body.date;
      if (body.unitsDelta !== undefined) update.unitsDelta = body.unitsDelta;
      if (body.unitPriceScaled !== undefined) update.unitPriceScaled = body.unitPriceScaled;
      if (body.feesMinor !== undefined) update.feesMinor = body.feesMinor;
      if (body.notes !== undefined) update.notes = body.notes;
      await db.update(transactions).set(update).where(eq(transactions.id, params.id));

      if (tx) {
        const [instr] = await db.select({ kind: instruments.kind }).from(instruments).where(eq(instruments.id, tx.instrumentId));
        const date = body.date ?? tx.date;
        const price = body.unitPriceScaled ?? tx.unitPriceScaled;
        if (instr && instr.kind !== "currency" && price != null) {
          await seedTradePrice(tx.instrumentId, date, price);
        }
      }
      return { ok: true };
    },
    {
      body: t.Object({
        date: t.Optional(t.String()),
        unitsDelta: t.Optional(t.Number()),
        unitPriceScaled: t.Optional(t.Number()),
        feesMinor: t.Optional(t.Number()),
        notes: t.Optional(t.String()),
      }),
    },
  )
  .delete("/transactions/:id", async ({ params }) => {
    await db.delete(transactions).where(eq(transactions.id, params.id));
    return { ok: true };
  });
