import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { instruments } from "../db/schema";
import { eq } from "drizzle-orm";
import { authGuard } from "../lib/auth-guard";
import { createId, nowEpoch } from "../lib/ids";
import { ensureCurrencyInstrument } from "../lib/instruments";

export const instrumentsRoutes = new Elysia({ prefix: "/instruments" })
  .use(authGuard)
  .get("/", async () => db.select().from(instruments).orderBy(instruments.name))
  // Find-or-create the currency instrument for a symbol; returns the full row.
  .post(
    "/currency",
    async ({ body }) => {
      const id = await ensureCurrencyInstrument(body.symbol);
      const [row] = await db.select().from(instruments).where(eq(instruments.id, id));
      return row;
    },
    { body: t.Object({ symbol: t.String({ pattern: "^[A-Za-z]{3}$" }) }) },
  )
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
        kind: t.Union([
          t.Literal("stock"), t.Literal("etf"), t.Literal("fund"),
          t.Literal("crypto"), t.Literal("other"),
        ]),
        currency: t.String({ pattern: "^[A-Za-z]{3}$" }),
        symbol: t.Optional(t.String()),
        isin: t.Optional(t.String()),
      }),
    },
  )
  .patch(
    "/:id",
    async ({ params, body }: any) => {
      const update: Record<string, unknown> = {};
      if (body.name !== undefined) update.name = body.name;
      if (body.symbol !== undefined) update.symbol = body.symbol || null;
      if (body.isin !== undefined) update.isin = body.isin || null;
      if (body.kind !== undefined) update.kind = body.kind;
      if (body.currency !== undefined) update.currency = body.currency.toUpperCase();
      await db.update(instruments).set(update).where(eq(instruments.id, params.id));
      return { ok: true };
    },
    {
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1 })),
        symbol: t.Optional(t.String()),
        isin: t.Optional(t.String()),
        kind: t.Optional(t.Union([
          t.Literal("currency"), t.Literal("stock"), t.Literal("etf"),
          t.Literal("fund"), t.Literal("crypto"), t.Literal("other"),
        ])),
        currency: t.Optional(t.String({ pattern: "^[A-Za-z]{3}$" })),
      }),
    },
  );
