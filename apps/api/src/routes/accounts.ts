import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { accounts, entries } from "../db/schema";
import { eq } from "drizzle-orm";
import { authGuard } from "../lib/auth-guard";
import { createId, nowEpoch } from "../lib/ids";
import { isUniqueViolation } from "../lib/db-errors";
import { accountBalanceMinor } from "../lib/valuation";
import { getAllOwnerSets, setOwners, allUsersExist } from "../lib/owners";

export const accountsRoutes = new Elysia({ prefix: "/accounts" })
  .use(authGuard)
  .get("/", async () => {
    const rows = await db.select().from(accounts).orderBy(accounts.sortOrder);
    const ownerSets = await getAllOwnerSets();
    return Promise.all(
      rows.map(async (a) => ({
        ...a,
        balanceMinor: await accountBalanceMinor(a.id),
        ownerIds: ownerSets.get(a.id) ?? [],
      })),
    );
  })
  .post(
    "/",
    async ({ body, userId, set }: any) => {
      // Default owners to the creator; otherwise every id must be an existing user.
      const ownerIds: string[] =
        Array.isArray(body.ownerIds) && body.ownerIds.length > 0 ? body.ownerIds : [userId!];
      if (!(await allUsersExist(ownerIds))) {
        set.status = 422;
        return { error: "invalid_owner_ids" };
      }

      const id = body.id ?? createId();
      try {
        await db.insert(accounts).values({
          id,
          name: body.name,
          class: body.class,
          subtype: body.subtype,
          currency: body.currency.toUpperCase(),
          valuationMode: body.valuationMode === "holdings" ? "holdings" : "ledger",
          institution: body.institution ?? null,
          isArchived: 0,
          sortOrder: body.sortOrder ?? 0,
          createdAt: nowEpoch(),
          createdBy: userId!,
          growthRateBps: body.growthRateBps ?? 0,
          accessibleFromAge: body.accessibleFromAge ?? 0,
          earlyWithdrawal: body.earlyWithdrawal === "penalty" ? "penalty" : "none",
          earlyHaircutBps: body.earlyHaircutBps ?? 0,
          illiquid: body.illiquid ? 1 : 0,
          liquidationAge: body.liquidationAge ?? null,
        });
      } catch (e) {
        if (isUniqueViolation(e)) {
          set.status = 409;
          return { error: "duplicate_id" };
        }
        throw e;
      }
      await setOwners(id, ownerIds);
      // Holdings accounts derive value from lots, never an opening ledger entry.
      if (body.valuationMode !== "holdings" && typeof body.openingBalanceMinor === "number" && body.openingBalanceMinor !== 0) {
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
        id: t.Optional(t.String()),
        name: t.String({ minLength: 1 }),
        class: t.Union([t.Literal("asset"), t.Literal("liability")]),
        subtype: t.String({ minLength: 1 }),
        currency: t.String({ pattern: "^[A-Za-z]{3}$" }),
        valuationMode: t.Optional(t.String()),
        institution: t.Optional(t.String()),
        sortOrder: t.Optional(t.Number()),
        openingBalanceMinor: t.Optional(t.Number()),
        openingDate: t.Optional(t.String()),
        ownerIds: t.Optional(t.Array(t.String())),
        growthRateBps: t.Optional(t.Number()),
        accessibleFromAge: t.Optional(t.Number()),
        earlyWithdrawal: t.Optional(t.Union([t.Literal("none"), t.Literal("penalty")])),
        earlyHaircutBps: t.Optional(t.Number()),
        illiquid: t.Optional(t.Boolean()),
        liquidationAge: t.Optional(t.Union([t.Number(), t.Null()])),
      }),
    },
  )
  .patch(
    "/:id/owners",
    async ({ params, body, set }: any) => {
      if (!Array.isArray(body.ownerIds) || body.ownerIds.length === 0 || !(await allUsersExist(body.ownerIds))) {
        set.status = 422;
        return { error: "invalid_owner_ids" };
      }
      await setOwners(params.id, body.ownerIds);
      return { ok: true };
    },
    {
      body: t.Object({ ownerIds: t.Array(t.String()) }),
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
      if (body.growthRateBps !== undefined) update.growthRateBps = body.growthRateBps;
      if (body.accessibleFromAge !== undefined) update.accessibleFromAge = body.accessibleFromAge;
      if (body.earlyWithdrawal !== undefined) update.earlyWithdrawal = body.earlyWithdrawal;
      if (body.earlyHaircutBps !== undefined) update.earlyHaircutBps = body.earlyHaircutBps;
      if (body.illiquid !== undefined) update.illiquid = body.illiquid ? 1 : 0;
      if (body.liquidationAge !== undefined) update.liquidationAge = body.liquidationAge;
      await db.update(accounts).set(update).where(eq(accounts.id, params.id));
      return { ok: true };
    },
    {
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1 })),
        institution: t.Optional(t.String()),
        sortOrder: t.Optional(t.Number()),
        isArchived: t.Optional(t.Boolean()),
        growthRateBps: t.Optional(t.Number()),
        accessibleFromAge: t.Optional(t.Number()),
        earlyWithdrawal: t.Optional(t.Union([t.Literal("none"), t.Literal("penalty")])),
        earlyHaircutBps: t.Optional(t.Number()),
        illiquid: t.Optional(t.Boolean()),
        liquidationAge: t.Optional(t.Union([t.Number(), t.Null()])),
      }),
    },
  );
