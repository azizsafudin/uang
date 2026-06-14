import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { prices } from "../db/schema";
import { eq } from "drizzle-orm";
import { authGuard } from "../lib/auth-guard";
import { createId, nowEpoch } from "../lib/ids";

export const pricesRoutes = new Elysia()
  .use(authGuard)
  .get("/instruments/:id/prices", async ({ params }) =>
    db.select().from(prices).where(eq(prices.instrumentId, params.id)).orderBy(prices.date),
  )
  .post(
    "/instruments/:id/prices",
    async ({ params, body }: any) => {
      const id = createId();
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
          set: { priceScaled: body.priceScaled },
        });
      return { ok: true };
    },
    {
      body: t.Object({
        date: t.String(),
        priceScaled: t.Number(),
      }),
    },
  )
  .delete("/prices/:id", async ({ params }) => {
    await db.delete(prices).where(eq(prices.id, params.id));
    return { ok: true };
  });
