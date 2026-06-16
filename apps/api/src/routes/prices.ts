import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { prices } from "../db/schema";
import { eq } from "drizzle-orm";
import { authGuard } from "../lib/auth-guard";
import { createId, nowEpoch } from "../lib/ids";
import { isUniqueViolation } from "../lib/db-errors";

export const pricesRoutes = new Elysia()
  .use(authGuard)
  .get("/instruments/:id/prices", async ({ params }) =>
    db.select().from(prices).where(eq(prices.instrumentId, params.id)).orderBy(prices.date),
  )
  .post(
    "/instruments/:id/prices",
    async ({ params, body, set }: any) => {
      const id = body.id ?? createId();
      try {
        await db
          .insert(prices)
          .values({
            id,
            instrumentId: params.id,
            date: body.date,
            priceScaled: body.priceScaled,
            source: "manual",
            createdAt: nowEpoch(),
          })
          .onConflictDoUpdate({
            target: [prices.instrumentId, prices.date],
            // A manual entry always wins and is marked manual, even if a trade/fetched
            // row already existed for that date.
            set: { priceScaled: body.priceScaled, source: "manual" },
          });
      } catch (e) {
        if (isUniqueViolation(e)) {
          set.status = 409;
          return { error: "duplicate_id" };
        }
        throw e;
      }
      return { ok: true };
    },
    {
      body: t.Object({
        id: t.Optional(t.String()),
        date: t.String(),
        priceScaled: t.Number(),
      }),
    },
  )
  .delete("/prices/:id", async ({ params }) => {
    await db.delete(prices).where(eq(prices.id, params.id));
    return { ok: true };
  });
