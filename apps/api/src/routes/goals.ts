import { Elysia, t } from "elysia";
import { db } from "../db/client";
import { goals } from "../db/schema";
import { eq } from "drizzle-orm";
import { authGuard } from "../lib/auth-guard";
import { createId, nowEpoch } from "../lib/ids";
import { isUniqueViolation } from "../lib/db-errors";
import { analyzeGoals } from "../lib/goals";

export const goalsRoutes = new Elysia({ prefix: "/goals" })
  .use(authGuard)
  .get("/", async () => db.select().from(goals).orderBy(goals.sortOrder))
  // Heavier liquidity-aware analysis (allocation + required contribution + on-track).
  .get("/analysis", async () => analyzeGoals())
  .post(
    "/",
    async ({ body, userId, set }: any) => {
      const id = body.id ?? createId();
      try {
        await db.insert(goals).values({
          id,
          name: body.name,
          term: body.term === "short" ? "short" : "long",
          targetAmountMinor: body.targetAmountMinor,
          currency: body.currency.toUpperCase(),
          targetDate: body.targetDate,
          ownerScope: body.ownerScope ?? "household",
          anchorDate: body.anchorDate ?? null,
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
        term: t.Union([t.Literal("short"), t.Literal("long")]),
        targetAmountMinor: t.Number(),
        currency: t.String({ pattern: "^[A-Za-z]{3}$" }),
        targetDate: t.String(),
        ownerScope: t.Optional(t.String()),
        anchorDate: t.Optional(t.Union([t.String(), t.Null()])),
        sortOrder: t.Optional(t.Number()),
      }),
    },
  )
  .patch(
    "/:id",
    async ({ params, body }: any) => {
      const update: Record<string, unknown> = {};
      if (body.name !== undefined) update.name = body.name;
      if (body.term !== undefined) update.term = body.term;
      if (body.targetAmountMinor !== undefined) update.targetAmountMinor = body.targetAmountMinor;
      if (body.currency !== undefined) update.currency = body.currency.toUpperCase();
      if (body.targetDate !== undefined) update.targetDate = body.targetDate;
      if (body.ownerScope !== undefined) update.ownerScope = body.ownerScope;
      if (body.anchorDate !== undefined) update.anchorDate = body.anchorDate;
      if (body.sortOrder !== undefined) update.sortOrder = body.sortOrder;
      await db.update(goals).set(update).where(eq(goals.id, params.id));
      return { ok: true };
    },
    {
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1 })),
        term: t.Optional(t.Union([t.Literal("short"), t.Literal("long")])),
        targetAmountMinor: t.Optional(t.Number()),
        currency: t.Optional(t.String({ pattern: "^[A-Za-z]{3}$" })),
        targetDate: t.Optional(t.String()),
        ownerScope: t.Optional(t.String()),
        anchorDate: t.Optional(t.Union([t.String(), t.Null()])),
        sortOrder: t.Optional(t.Number()),
      }),
    },
  )
  .delete("/:id", async ({ params }: any) => {
    await db.delete(goals).where(eq(goals.id, params.id));
    return { ok: true };
  });
