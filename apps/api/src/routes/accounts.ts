import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { accounts, transactions, accountOwners, settings, groups } from "../db/schema";
import { eq } from "drizzle-orm";
import { authGuard } from "../lib/auth-guard";
import { createId, nowEpoch } from "../lib/ids";
import { isUniqueViolation } from "../lib/db-errors";
import { accountValueMinor } from "../lib/valuation";
import { ensureCurrencyInstrument } from "../lib/instruments";
import { getAllOwnerSets, setOwners, allUsersExist } from "../lib/owners";

export const accountsRoutes = new Elysia({ prefix: "/accounts" })
  .use(authGuard)
  .get("/", async () => {
    const s = (await db.select().from(settings).where(eq(settings.id, 1)))[0];
    const base = s?.baseCurrency ?? "USD";
    const rows = await db.select().from(accounts).orderBy(accounts.sortOrder);
    const ownerSets = await getAllOwnerSets();
    return Promise.all(
      rows.map(async (a) => ({
        ...a,
        balanceMinor: (await accountValueMinor(a.id, a.currency, base)).valueMinor,
        ownerIds: ownerSets.get(a.id) ?? [],
      })),
    );
  })
  .post(
    "/",
    async ({ body, userId, set }: any) => {
      const ownerIds: string[] =
        Array.isArray(body.ownerIds) && body.ownerIds.length > 0 ? body.ownerIds : [userId!];
      if (!(await allUsersExist(ownerIds))) {
        set.status = 422;
        return { error: "invalid_owner_ids" };
      }

      const id = body.id ?? createId();
      const currency = body.currency.toUpperCase();
      try {
        await db.insert(accounts).values({
          id,
          name: body.name,
          class: body.class,
          subtype: body.subtype,
          currency,
          institution: body.institution ?? null,
          isArchived: 0,
          sortOrder: body.sortOrder ?? 0,
          createdAt: nowEpoch(),
          createdBy: userId!,
          groupId: body.groupId ?? null,
          growthRateBps: body.growthRateBps ?? 0,
          accessibleFromAge: body.accessibleFromAge ?? 0,
          earlyWithdrawal: body.earlyWithdrawal === "penalty" ? "penalty" : "none",
          earlyHaircutBps: body.earlyHaircutBps ?? 0,
          illiquid: body.illiquid ? 1 : 0,
          liquidationAge: body.liquidationAge ?? null,
          compoundInterval: body.compoundInterval ?? "annually",
          loanTermMonths: body.loanTermMonths ?? null,
        });
      } catch (e) {
        if (isUniqueViolation(e)) {
          set.status = 409;
          return { error: "duplicate_id" };
        }
        throw e;
      }
      await setOwners(id, ownerIds);
      await ensureCurrencyInstrument(currency);
      return { id };
    },
    {
      body: t.Object({
        id: t.Optional(t.String()),
        name: t.String({ minLength: 1 }),
        class: t.Union([t.Literal("asset"), t.Literal("liability")]),
        subtype: t.String({ minLength: 1 }),
        currency: t.String({ pattern: "^[A-Za-z]{3}$" }),
        institution: t.Optional(t.String()),
        groupId: t.Optional(t.Union([t.String(), t.Null()])),
        sortOrder: t.Optional(t.Number()),
        ownerIds: t.Optional(t.Array(t.String())),
        growthRateBps: t.Optional(t.Number()),
        accessibleFromAge: t.Optional(t.Number()),
        earlyWithdrawal: t.Optional(t.Union([t.Literal("none"), t.Literal("penalty")])),
        earlyHaircutBps: t.Optional(t.Number()),
        illiquid: t.Optional(t.Boolean()),
        liquidationAge: t.Optional(t.Union([t.Number(), t.Null()])),
        compoundInterval: t.Optional(t.Union([t.Literal("monthly"), t.Literal("quarterly"), t.Literal("annually")])),
        loanTermMonths: t.Optional(t.Union([t.Number(), t.Null()])),
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
    "/reorder",
    async ({ body }: any) => {
      for (const item of body.items) {
        if (item.kind === "account") {
          const upd: Record<string, unknown> = { sortOrder: item.sortOrder };
          if ("groupId" in item) upd.groupId = item.groupId;
          await db.update(accounts).set(upd).where(eq(accounts.id, item.id));
        } else {
          await db.update(groups).set({ sortOrder: item.sortOrder }).where(eq(groups.id, item.id));
        }
      }
      return { ok: true };
    },
    {
      body: t.Object({
        items: t.Array(
          t.Object({
            id: t.String(),
            kind: t.Union([t.Literal("account"), t.Literal("group")]),
            sortOrder: t.Number(),
            groupId: t.Optional(t.Union([t.String(), t.Null()])),
          }),
        ),
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
      if ("groupId" in body) update.groupId = body.groupId;
      if (body.growthRateBps !== undefined) update.growthRateBps = body.growthRateBps;
      if (body.accessibleFromAge !== undefined) update.accessibleFromAge = body.accessibleFromAge;
      if (body.earlyWithdrawal !== undefined) update.earlyWithdrawal = body.earlyWithdrawal;
      if (body.earlyHaircutBps !== undefined) update.earlyHaircutBps = body.earlyHaircutBps;
      if (body.illiquid !== undefined) update.illiquid = body.illiquid ? 1 : 0;
      if (body.liquidationAge !== undefined) update.liquidationAge = body.liquidationAge;
      if (body.compoundInterval !== undefined) update.compoundInterval = body.compoundInterval;
      if (body.loanTermMonths !== undefined) update.loanTermMonths = body.loanTermMonths;
      await db.update(accounts).set(update).where(eq(accounts.id, params.id));
      return { ok: true };
    },
    {
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1 })),
        institution: t.Optional(t.String()),
        sortOrder: t.Optional(t.Number()),
        groupId: t.Optional(t.Union([t.String(), t.Null()])),
        isArchived: t.Optional(t.Boolean()),
        growthRateBps: t.Optional(t.Number()),
        accessibleFromAge: t.Optional(t.Number()),
        earlyWithdrawal: t.Optional(t.Union([t.Literal("none"), t.Literal("penalty")])),
        earlyHaircutBps: t.Optional(t.Number()),
        illiquid: t.Optional(t.Boolean()),
        liquidationAge: t.Optional(t.Union([t.Number(), t.Null()])),
        compoundInterval: t.Optional(t.Union([t.Literal("monthly"), t.Literal("quarterly"), t.Literal("annually")])),
        loanTermMonths: t.Optional(t.Union([t.Number(), t.Null()])),
      }),
    },
  )
  .delete("/:id", async ({ params, set }: any) => {
    const [account] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.id, params.id));
    if (!account) {
      set.status = 404;
      return { error: "not_found" };
    }
    if (!account.isArchived) {
      set.status = 422;
      return { error: "not_archived" };
    }
    await db
      .delete(accountOwners)
      .where(eq(accountOwners.accountId, params.id));
    await db.delete(transactions).where(eq(transactions.accountId, params.id));
    await db.delete(accounts).where(eq(accounts.id, params.id));
    return { ok: true };
  });
