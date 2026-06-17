import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { goals, goalAccounts } from "../db/schema";
import { eq } from "drizzle-orm";
import { authGuard } from "../lib/auth-guard";
import { createId, nowEpoch } from "../lib/ids";
import { isUniqueViolation } from "../lib/db-errors";
import { analyzeGoals, goalProjection } from "../lib/goals";

export const goalsRoutes = new Elysia({ prefix: "/goals" })
  .use(authGuard)
  .get("/", async () => db.select().from(goals).orderBy(goals.sortOrder))
  // Heavier liquidity-aware analysis (allocation + required contribution + on-track).
  .get("/analysis", async () => analyzeGoals())
  .get(
    "/:id/projection",
    async ({ params, query, set }: any) => {
      const r = await goalProjection(params.id, query.historyMonths ?? 12);
      if (!r) {
        set.status = 404;
        return { error: "not_found" };
      }
      return r;
    },
    { query: t.Object({ historyMonths: t.Optional(t.Numeric()) }) },
  )
  .post(
    "/",
    async ({ body, userId, set }: any) => {
      const spendType = body.spendType ?? "none";
      const targetDate = body.targetDate ?? null;
      if (spendType !== "none" && !targetDate) {
        set.status = 422;
        return { error: "spend_requires_target_date" };
      }
      const id = body.id ?? createId();
      try {
        await db.insert(goals).values({
          id,
          name: body.name,
          targetAmountMinor: body.targetAmountMinor,
          currency: body.currency.toUpperCase(),
          targetDate,
          ownerScope: body.ownerScope ?? "household",
          anchorDate: body.anchorDate ?? null,
          monthlyContributionMinor: body.monthlyContributionMinor ?? 0,
          contributionAccountId: body.contributionAccountId ?? null,
          spendType,
          spendAmountMinor: body.spendAmountMinor ?? null,
          spendRateBps: body.spendRateBps ?? null,
          sortOrder: body.sortOrder ?? 0,
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
        name: t.String({ minLength: 1 }),
        targetAmountMinor: t.Number(),
        currency: t.String({ pattern: "^[A-Za-z]{3}$" }),
        targetDate: t.Optional(t.Union([t.String(), t.Null()])),
        ownerScope: t.Optional(t.String()),
        anchorDate: t.Optional(t.Union([t.String(), t.Null()])),
        monthlyContributionMinor: t.Optional(t.Number()),
        contributionAccountId: t.Optional(t.Union([t.String(), t.Null()])),
        spendType: t.Optional(t.Union([t.Literal("none"), t.Literal("once"), t.Literal("monthly"), t.Literal("percent")])),
        spendAmountMinor: t.Optional(t.Union([t.Number(), t.Null()])),
        spendRateBps: t.Optional(t.Union([t.Number(), t.Null()])),
        sortOrder: t.Optional(t.Number()),
      }),
    },
  )
  .patch(
    "/:id",
    async ({ params, body, set }: any) => {
      // Enabling spend requires a target date (existing or in this patch).
      if (body.spendType !== undefined && body.spendType !== "none") {
        const existing = (await db.select().from(goals).where(eq(goals.id, params.id)))[0];
        const effectiveTargetDate = body.targetDate !== undefined ? body.targetDate : existing?.targetDate;
        if (!effectiveTargetDate) {
          set.status = 422;
          return { error: "spend_requires_target_date" };
        }
      }
      const update: Record<string, unknown> = {};
      if (body.name !== undefined) update.name = body.name;
      if (body.targetAmountMinor !== undefined) update.targetAmountMinor = body.targetAmountMinor;
      if (body.currency !== undefined) update.currency = body.currency.toUpperCase();
      if (body.targetDate !== undefined) update.targetDate = body.targetDate;
      if (body.ownerScope !== undefined) update.ownerScope = body.ownerScope;
      if (body.anchorDate !== undefined) update.anchorDate = body.anchorDate;
      if (body.monthlyContributionMinor !== undefined) update.monthlyContributionMinor = body.monthlyContributionMinor;
      if (body.contributionAccountId !== undefined) update.contributionAccountId = body.contributionAccountId;
      if (body.spendType !== undefined) update.spendType = body.spendType;
      if (body.spendAmountMinor !== undefined) update.spendAmountMinor = body.spendAmountMinor;
      if (body.spendRateBps !== undefined) update.spendRateBps = body.spendRateBps;
      if (body.sortOrder !== undefined) update.sortOrder = body.sortOrder;
      await db.update(goals).set(update).where(eq(goals.id, params.id));
      return { ok: true };
    },
    {
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1 })),
        targetAmountMinor: t.Optional(t.Number()),
        currency: t.Optional(t.String({ pattern: "^[A-Za-z]{3}$" })),
        targetDate: t.Optional(t.Union([t.String(), t.Null()])),
        ownerScope: t.Optional(t.String()),
        anchorDate: t.Optional(t.Union([t.String(), t.Null()])),
        monthlyContributionMinor: t.Optional(t.Number()),
        contributionAccountId: t.Optional(t.Union([t.String(), t.Null()])),
        spendType: t.Optional(t.Union([t.Literal("none"), t.Literal("once"), t.Literal("monthly"), t.Literal("percent")])),
        spendAmountMinor: t.Optional(t.Union([t.Number(), t.Null()])),
        spendRateBps: t.Optional(t.Union([t.Number(), t.Null()])),
        sortOrder: t.Optional(t.Number()),
      }),
    },
  )
  // Replace the full set of accounts funding a goal.
  .put(
    "/:id/accounts",
    async ({ params, body }: any) => {
      await db.delete(goalAccounts).where(eq(goalAccounts.goalId, params.id));
      if (body.accountIds.length) {
        await db.insert(goalAccounts).values(
          body.accountIds.map((accountId: string) => ({ goalId: params.id, accountId })),
        );
      }
      return { ok: true };
    },
    { body: t.Object({ accountIds: t.Array(t.String()) }) },
  )
  .delete("/:id", async ({ params }: any) => {
    await db.delete(goals).where(eq(goals.id, params.id));
    return { ok: true };
  });
