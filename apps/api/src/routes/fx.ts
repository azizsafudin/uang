import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { fxRates } from "../db/schema";
import { and, eq } from "drizzle-orm";
import { authGuard } from "../lib/auth-guard";
import { createId, nowEpoch } from "../lib/ids";
import { isUniqueViolation } from "../lib/db-errors";

export const fxRoutes = new Elysia({ prefix: "/fx" })
  .use(authGuard)
  .get("/", async () => db.select().from(fxRates).orderBy(fxRates.currency, fxRates.date))
  .post(
    "/",
    async ({ body, set }) => {
      const currency = body.currency.toUpperCase();
      // Upsert by (currency, date): delete any existing then insert (the unique index guarantees one).
      await db.delete(fxRates).where(and(eq(fxRates.currency, currency), eq(fxRates.date, body.date)));
      const id = body.id ?? createId();
      try {
        await db.insert(fxRates).values({ id, currency, date: body.date, rateScaled: body.rateScaled, createdAt: nowEpoch() });
      } catch (e) {
        if (isUniqueViolation(e)) {
          set.status = 409;
          return { error: "duplicate_id" };
        }
        throw e;
      }
      return { id };
    },
    { body: t.Object({ id: t.Optional(t.String()), currency: t.String({ pattern: "^[A-Za-z]{3}$" }), date: t.String(), rateScaled: t.Number() }) },
  )
  .delete("/:id", async ({ params }) => {
    await db.delete(fxRates).where(eq(fxRates.id, params.id));
    return { ok: true };
  });
