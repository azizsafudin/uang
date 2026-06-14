import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { lots, instruments, settings } from "../db/schema";
import { eq } from "drizzle-orm";
import { authGuard } from "../lib/auth-guard";
import { createId, nowEpoch } from "../lib/ids";
import { isUniqueViolation } from "../lib/db-errors";
import { holdingsAccountValuation } from "../lib/holdings";

export const lotsRoutes = new Elysia()
  .use(authGuard)
  .get("/accounts/:id/lots", async ({ params }) =>
    db.select().from(lots).where(eq(lots.accountId, params.id)).orderBy(lots.tradeDate),
  )
  .post(
    "/accounts/:id/lots",
    async ({ params, body, userId, set }: any) => {
      const instr = await db.select({ id: instruments.id }).from(instruments).where(eq(instruments.id, body.instrumentId));
      if (instr.length === 0) {
        set.status = 422;
        return { error: "unknown_instrument" };
      }
      const id = body.id ?? createId();
      try {
        await db.insert(lots).values({
          id,
          accountId: params.id,
          instrumentId: body.instrumentId,
          unitsScaled: body.unitsScaled,
          unitCostScaled: body.unitCostScaled,
          feesMinor: body.feesMinor ?? 0,
          tradeDate: body.tradeDate,
          note: body.note ?? null,
          createdAt: nowEpoch(),
          createdBy: userId!,
        });
      } catch (e) {
        if (isUniqueViolation(e)) {
          set.status = 409;
          return { error: "duplicate_id" };
        }
        throw e;
      }
      return { id };
    },
    {
      body: t.Object({
        id: t.Optional(t.String()),
        instrumentId: t.String(),
        unitsScaled: t.Number(),
        unitCostScaled: t.Number(),
        feesMinor: t.Optional(t.Number()),
        tradeDate: t.String(),
        note: t.Optional(t.String()),
      }),
    },
  )
  .patch(
    "/lots/:id",
    async ({ params, body }: any) => {
      const update: Record<string, unknown> = {};
      if (body.instrumentId !== undefined) update.instrumentId = body.instrumentId;
      if (body.unitsScaled !== undefined) update.unitsScaled = body.unitsScaled;
      if (body.unitCostScaled !== undefined) update.unitCostScaled = body.unitCostScaled;
      if (body.feesMinor !== undefined) update.feesMinor = body.feesMinor;
      if (body.tradeDate !== undefined) update.tradeDate = body.tradeDate;
      if (body.note !== undefined) update.note = body.note;
      await db.update(lots).set(update).where(eq(lots.id, params.id));
      return { ok: true };
    },
    {
      body: t.Object({
        instrumentId: t.Optional(t.String()),
        unitsScaled: t.Optional(t.Number()),
        unitCostScaled: t.Optional(t.Number()),
        feesMinor: t.Optional(t.Number()),
        tradeDate: t.Optional(t.String()),
        note: t.Optional(t.String()),
      }),
    },
  )
  .delete("/lots/:id", async ({ params }) => {
    await db.delete(lots).where(eq(lots.id, params.id));
    return { ok: true };
  })
  .get("/accounts/:id/holdings", async ({ params }) => {
    const s = (await db.select().from(settings).where(eq(settings.id, 1)))[0];
    const base = s?.baseCurrency ?? "USD";
    const v = await holdingsAccountValuation(params.id, undefined, base);
    return { baseCurrency: base, totalBaseMinor: v.baseMinor, totalGainBaseMinor: v.gainBaseMinor, missing: v.missing, lots: v.lots };
  });
