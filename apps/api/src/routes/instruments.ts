import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { instruments } from "../db/schema";
import { authGuard } from "../lib/auth-guard";
import { createId, nowEpoch } from "../lib/ids";

export const instrumentsRoutes = new Elysia({ prefix: "/instruments" })
  .use(authGuard)
  .get("/", async () => db.select().from(instruments).orderBy(instruments.name))
  .post(
    "/",
    async ({ body }) => {
      const id = createId();
      await db.insert(instruments).values({
        id,
        symbol: body.symbol ?? null,
        isin: body.isin ?? null,
        name: body.name,
        kind: body.kind,
        currency: body.currency.toUpperCase(),
        createdAt: nowEpoch(),
      });
      return { id };
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1 }),
        kind: t.Union([t.Literal("stock"), t.Literal("etf"), t.Literal("fund"), t.Literal("other")]),
        currency: t.String({ pattern: "^[A-Za-z]{3}$" }),
        symbol: t.Optional(t.String()),
        isin: t.Optional(t.String()),
      }),
    },
  );
