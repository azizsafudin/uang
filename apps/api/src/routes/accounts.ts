import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { accounts, entries } from "../db/schema";
import { eq } from "drizzle-orm";
import { authGuard } from "../lib/auth-guard";
import { createId, nowEpoch } from "../lib/ids";
import { accountBalanceMinor } from "../lib/valuation";

export const accountsRoutes = new Elysia({ prefix: "/accounts" })
  .use(authGuard)
  .get("/", async () => {
    const rows = await db.select().from(accounts).orderBy(accounts.sortOrder);
    return Promise.all(
      rows.map(async (a) => ({ ...a, balanceMinor: await accountBalanceMinor(a.id) })),
    );
  })
  .post(
    "/",
    async ({ body, userId, set }: any) => {
      if ((body.valuationMode ?? "ledger") !== "ledger") {
        set.status = 400;
        return { error: "holdings_not_supported_in_v2" };
      }
      const id = createId();
      await db.insert(accounts).values({
        id,
        name: body.name,
        class: body.class,
        subtype: body.subtype,
        currency: body.currency.toUpperCase(),
        valuationMode: "ledger",
        institution: body.institution ?? null,
        isArchived: 0,
        sortOrder: body.sortOrder ?? 0,
        createdAt: nowEpoch(),
        createdBy: userId!,
      });
      if (typeof body.openingBalanceMinor === "number" && body.openingBalanceMinor !== 0) {
        const today = new Date(nowEpoch() * 1000).toISOString().slice(0, 10);
        await db.insert(entries).values({
          id: createId(),
          accountId: id,
          date: body.openingDate ?? today,
          amountMinor: body.openingBalanceMinor,
          kind: "opening",
          createdAt: nowEpoch(),
          createdBy: userId!,
        });
      }
      return { id };
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1 }),
        class: t.Union([t.Literal("asset"), t.Literal("liability")]),
        subtype: t.String({ minLength: 1 }),
        currency: t.String({ pattern: "^[A-Za-z]{3}$" }),
        valuationMode: t.Optional(t.String()),
        institution: t.Optional(t.String()),
        sortOrder: t.Optional(t.Number()),
        openingBalanceMinor: t.Optional(t.Number()),
        openingDate: t.Optional(t.String()),
      }),
    },
  )
  .patch(
    "/:id",
    async ({ params, body }: any) => {
      const update: Record<string, unknown> = {};
      if (body.name !== undefined) update.name = body.name;
      if (body.institution !== undefined) update.institution = body.institution;
      if (body.sortOrder !== undefined) update.sortOrder = body.sortOrder;
      if (body.isArchived !== undefined) update.isArchived = body.isArchived ? 1 : 0;
      await db.update(accounts).set(update).where(eq(accounts.id, params.id));
      return { ok: true };
    },
    {
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1 })),
        institution: t.Optional(t.String()),
        sortOrder: t.Optional(t.Number()),
        isArchived: t.Optional(t.Boolean()),
      }),
    },
  );
